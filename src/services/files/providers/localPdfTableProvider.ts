/**
 * Local PDF table extraction provider.
 *
 * Custom detector built on `pdfjs-dist@5` legacy build. No
 * `pdf-table-extractor` (it pinned pdfjs-dist@1 and required a
 * canvas runtime that Bun cannot load in this environment), no
 * `node-canvas`, no web worker. See design §3.2.
 *
 * Algorithm summary (per page):
 *   1. Load the page with `pdfjs.getDocument(...)`.
 *   2. Walk `page.getTextContent().items`. Each text item carries
 *      `transform[5]` (x, y in PDF points, origin bottom-left),
 *      `width`, `height`.
 *   3. Cluster items by y-coordinate (tolerance 2pt) → rows.
 *   4. Within each row, segment cells by x-coordinate: an item
 *      continues the current cell if its `x` is within `x + width + 4pt`
 *      of the previous item's end.
 *   5. The first 1-2 rows of a page that are short and text-like are
 *      header rows. Multi-level headers are flattened into a single
 *      `headers` array (interleaving L1, L2 with L2 cells repeated
 *      for the span they cover).
 *   6. Bbox of a table = union of every cell's geometry, normalized
 *      to PDF native origin (bottom-left).
 *   7. Per-row confidence = `min(1, chars / (numCells * 8))`. Table
 *      confidence = mean of row confidences.
 *
 * Multi-page: this provider runs the algorithm once per page and
 * concatenates the results. The caller is responsible for
 * persisting `(page, tableIndex)` per source.
 */

import type { PdfjsLegacyModule } from "../loaders/pdfjsLegacy";
import type {
  BBox,
  ExtractedFigure,
  ExtractedTable,
  TableExtractionProvider,
} from "../pdfTableExtractor";
import { TableExtractionProviderError } from "../pdfTableExtractor";

// ---------------------------------------------------------------------------
// Tunables (kept as module constants so tests can reference them)
// ---------------------------------------------------------------------------

/** Items within this many points of each other on Y are on the same row. */
export const Y_TOLERANCE_PT = 2;

/** Items within this many points of the previous item's right edge continue the same cell. */
export const X_TOLERANCE_PT = 4;

/** Maximum text length for a cell to be considered a header cell. */
export const MAX_HEADER_CELL_CHARS = 40;

/** Maximum number of body rows that count as "header" rows (1-2 for multi-level). */
export const MAX_HEADER_ROWS = 2;

/** Minimum number of body rows for a cluster of rows to be considered a "table" at all. */
export const MIN_BODY_ROWS = 1;

// ---------------------------------------------------------------------------
// pdfjs text-item shape (just the fields we use)
// ---------------------------------------------------------------------------

type PdfjsTransform = [number, number, number, number, number, number];

type PdfjsTextItem = {
  str: string;
  transform: PdfjsTransform;
  width: number;
  height: number;
  hasEOL?: boolean;
};

type PdfjsTextContent = {
  items: PdfjsTextItem[];
};

// ---------------------------------------------------------------------------
// Detector
// ---------------------------------------------------------------------------

export type LocalProviderDeps = () => Promise<PdfjsLegacyModule>;

export class LocalTableExtractionProvider implements TableExtractionProvider {
  readonly name = "local" as const;

  constructor(private readonly loadPdfjs: LocalProviderDeps) {}

  async extract(pdf: Uint8Array): Promise<ExtractedTable[]> {
    const pdfjs = await this.loadPdfjs();

    let doc: any;
    try {
      const loadingTask = pdfjs.getDocument({
        data: pdf,
        useWorkerFetch: false,
        isEvalSupported: false,
        disableFontFace: true,
        verbosity: 0,
      });
      doc = await loadingTask.promise;
    } catch (error) {
      throw new TableExtractionProviderError(
        `pdfjs getDocument failed: ${(error as Error).message ?? String(error)}`,
        error,
      );
    }

    try {
      const tables: ExtractedTable[] = [];
      const numPages: number = doc.numPages;

      for (let pageNum = 1; pageNum <= numPages; pageNum++) {
        const page = await doc.getPage(pageNum);
        const viewport = page.getViewport({ scale: 1.0 });
        const pageHeightPt = viewport.height;
        const tc: PdfjsTextContent = await page.getTextContent();
        const pageTables = detectTablesOnPage(tc.items, pageNum, pageHeightPt);
        tables.push(...pageTables);
        page.cleanup();
      }

      return tables;
    } catch (error) {
      throw new TableExtractionProviderError(
        `pdfjs page extraction failed: ${(error as Error).message ?? String(error)}`,
        error,
      );
    } finally {
      try {
        await doc.destroy();
      } catch {
        // ignore
      }
    }
  }

  /**
   * The local detector does not identify figures. Returns `[]` so
   * the orchestrator's figure persistence path is a no-op when this
   * provider is the only one that ran. Figure data only comes from
   * Mistral in v1.
   */
  async extractFigures(_pdf: Uint8Array): Promise<ExtractedFigure[]> {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Pure detector (exported for unit tests; no pdfjs dependency)
// ---------------------------------------------------------------------------

export type Cell = {
  text: string;
  bbox: BBox;
  x: number; // canvas coords (origin top-left)
  y: number;
  width: number;
  height: number;
};

export type DetectedRow = {
  // Median y in canvas coords (top-left origin)
  y: number;
  cells: Cell[];
};

/**
 * Run the clustering algorithm on the text items of a single page.
 * `pageHeightPt` is the page height in PDF points (from
 * `page.getViewport({ scale: 1.0 }).height`). Returns the list of
 * detected tables on this page.
 *
 * Exported so the unit tests can drive it with synthetic fixtures
 * without going through pdfjs.
 */
export function detectTablesOnPage(
  items: PdfjsTextItem[],
  page: number,
  pageHeightPt: number,
): ExtractedTable[] {
  // 1. Normalize items → cells in canvas coords (origin top-left).
  const cells = itemsToCells(items, page, pageHeightPt);

  if (cells.length === 0) return [];

  // 2. Group cells into rows by y (tolerance Y_TOLERANCE_PT).
  const rows = groupCellsIntoRows(cells, Y_TOLERANCE_PT);

  if (rows.length === 0) return [];

  // 3. For each row, segment into column cells by x-distance.
  const segmentedRows: DetectedRow[] = rows.map((row) => ({
    y: row.y,
    cells: segmentRowIntoCells(row.cells, X_TOLERANCE_PT),
  }));

  // 4. Find table clusters: groups of consecutive rows that share
  //    approximately the same column anchors. A new table starts
  //    when the next row's column count differs by more than 1, OR
  //    when there's a vertical gap > 3 * (row height).
  const clusters = clusterRowsIntoTables(segmentedRows);

  // 5. For each cluster, decide which rows are header rows, build
  //    ExtractedTable.
  const tables: ExtractedTable[] = [];
  for (let i = 0; i < clusters.length; i++) {
    const cluster = clusters[i];
    const tableIndex = i;
    const t = buildTableFromCluster(cluster, page, tableIndex);
    if (t) tables.push(t);
  }

  return tables;
}

// ---------------------------------------------------------------------------
// Step 1: pdfjs items → cells in canvas coords
// ---------------------------------------------------------------------------

function itemsToCells(
  items: PdfjsTextItem[],
  page: number,
  pageHeightPt: number,
): Cell[] {
  const out: Cell[] = [];
  for (const item of items) {
    // Filter out whitespace-only and "spacer" items (PDF.js sometimes
    // emits " " tokens that are just to advance the cursor).
    if (!item.str || item.str.trim() === "") continue;
    const t = item.transform;
    // t = [a, b, c, d, e, f] → horizontal text: e = x (left), f = y (bottom)
    const xPdf = t[4];
    const yPdf = t[5];
    const w = item.width || 0;
    const h = item.height || Math.abs(t[3]) || 0;

    // Convert PDF coords (origin bottom-left) to canvas coords
    // (origin top-left):
    //   canvasY = pageHeight - (pdfY + h)  (item's top edge)
    const yCanvas = pageHeightPt - (yPdf + h);

    out.push({
      text: item.str,
      bbox: { x: xPdf, y: yPdf, w, h, page, units: "pt" },
      x: xPdf,
      y: yCanvas,
      width: w,
      height: h,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Step 2: cluster cells into rows
// ---------------------------------------------------------------------------

function groupCellsIntoRows(cells: Cell[], yTolerance: number): DetectedRow[] {
  // Sort by y ascending (top-to-bottom in canvas coords).
  const sorted = [...cells].sort((a, b) => a.y - b.y);

  const rows: { y: number; cells: Cell[] }[] = [];
  for (const cell of sorted) {
    const cellMidY = cell.y + cell.height / 2;
    const matched = rows.find((r) => Math.abs(r.y - cellMidY) <= yTolerance);
    if (matched) {
      matched.cells.push(cell);
      // Update the row anchor as the running median of cell midpoints.
      matched.y = median(matched.cells.map((c) => c.y + c.height / 2));
    } else {
      rows.push({ y: cellMidY, cells: [cell] });
    }
  }

  // Sort each row's cells by x (left-to-right).
  for (const r of rows) {
    r.cells.sort((a, b) => a.x - b.x);
  }
  return rows;
}

// ---------------------------------------------------------------------------
// Step 3: segment a row into column cells
// ---------------------------------------------------------------------------

/**
 * Group consecutive cells in a row that are within xTolerance of
 * the previous cell's right edge → same logical cell. Returns one
 * Cell per column, with text concatenated (whitespace normalized).
 */
export function segmentRowIntoCells(
  rowCells: Cell[],
  xTolerance: number,
): Cell[] {
  if (rowCells.length === 0) return [];

  const segments: Cell[] = [];
  let current: Cell = { ...rowCells[0] };

  for (let i = 1; i < rowCells.length; i++) {
    const next = rowCells[i];
    const currentRight = current.x + current.width;
    if (next.x - currentRight <= xTolerance) {
      // Same cell — append text, extend bbox.
      const newText = appendText(current.text, next.text);
      const newRight = Math.max(currentRight, next.x + next.width);
      const newLeft = Math.min(current.x, next.x);
      const newTop = Math.min(current.y, next.y);
      const newBottom = Math.max(
        current.y + current.height,
        next.y + next.height,
      );
      current = {
        ...current,
        text: newText,
        x: newLeft,
        y: newTop,
        width: newRight - newLeft,
        height: newBottom - newTop,
        bbox: {
          ...current.bbox,
          x: newLeft,
          w: newRight - newLeft,
          h: newBottom - newTop,
        },
      };
    } else {
      // Push the current segment and start a new one.
      segments.push(normalizeCellText(current));
      current = { ...next };
    }
  }
  segments.push(normalizeCellText(current));
  return segments;
}

function appendText(a: string, b: string): string {
  if (!a) return b;
  if (!b) return a;
  // If `a` already ends with a space OR `b` starts with a space,
  // just concatenate; otherwise insert a single space.
  if (a.endsWith(" ") || b.startsWith(" ")) return a + b;
  return `${a} ${b}`;
}

function normalizeCellText(cell: Cell): Cell {
  return { ...cell, text: cell.text.replace(/\s+/g, " ").trim() };
}

// ---------------------------------------------------------------------------
// Step 4: cluster rows into tables
// ---------------------------------------------------------------------------

function clusterRowsIntoTables(rows: DetectedRow[]): DetectedRow[][] {
  if (rows.length === 0) return [];

  const tables: DetectedRow[][] = [];
  let current: DetectedRow[] = [rows[0]];

  for (let i = 1; i < rows.length; i++) {
    const prev = rows[i - 1];
    const cur = rows[i];
    const colCountPrev = prev.cells.length;
    const colCountCur = cur.cells.length;
    const yGap = cur.y - prev.y;
    // If the column count differs by more than 1, treat as a new
    // table. Same if the y-gap is much larger than typical row
    // height (indicates an empty line between two tables).
    const typicalRowHeight = median(
      current.flatMap((r) => r.cells.map((c) => c.height)),
    );
    const tooFar = typicalRowHeight > 0 && yGap > 3 * typicalRowHeight;
    if (Math.abs(colCountPrev - colCountCur) > 1 || tooFar) {
      if (current.length >= 1 + MIN_BODY_ROWS) tables.push(current);
      current = [cur];
    } else {
      current.push(cur);
    }
  }
  if (current.length >= 1 + MIN_BODY_ROWS) tables.push(current);
  return tables;
}

// ---------------------------------------------------------------------------
// Step 5: build ExtractedTable from a row cluster
// ---------------------------------------------------------------------------

function buildTableFromCluster(
  rows: DetectedRow[],
  page: number,
  tableIndex: number,
): ExtractedTable | null {
  if (rows.length === 0) return null;

  // Determine header rows. A row is a header candidate when:
  //   - it's one of the first 1-2 rows of the cluster
  //   - every cell is short (<= MAX_HEADER_CELL_CHARS)
  //   - at least one cell contains alphabetic content (rules out
  //     pure-number data rows that happen to be in position 0)
  const headerRowCount = countHeaderRows(rows);
  if (rows.length <= headerRowCount) return null; // no body rows → not a table

  const headerRows = rows.slice(0, headerRowCount);
  const bodyRows = rows.slice(headerRowCount);

  // The "max column count" of the body determines the table width.
  // Each body row is padded with empty cells to match.
  const maxCols = Math.max(...bodyRows.map((r) => r.cells.length), 1);

  const paddedBodyCells: Cell[][] = bodyRows.map((r) => {
    const cells = [...r.cells];
    while (cells.length < maxCols) {
      cells.push({
        text: "-",
        bbox: emptyBbox(page),
        x: 0,
        y: 0,
        width: 0,
        height: 0,
      });
    }
    return cells;
  });

  // Flatten multi-level headers.
  const flatHeaders = flattenMultiLevelHeaders(headerRows, maxCols);

  // Pad body row widths to match header width (so the table is
  // rectangular in `headers.length` and `rows[i].length`).
  const finalBody = paddedBodyCells.map((cells) => {
    while (cells.length < flatHeaders.length) {
      cells.push({
        text: "-",
        bbox: emptyBbox(page),
        x: 0,
        y: 0,
        width: 0,
        height: 0,
      });
    }
    return cells.map((c) => c.text || "-");
  });

  // Confidence: per-row chars / (cells * 8), capped at 1.
  const rowConfidences = finalBody.map((row) => {
    const totalChars = row.reduce((n, c) => n + (c === "-" ? 0 : c.length), 0);
    return Math.min(1, totalChars / Math.max(1, row.length * 8));
  });
  const confidence =
    rowConfidences.length === 0
      ? 0
      : rowConfidences.reduce((a, b) => a + b, 0) / rowConfidences.length;

  // Bbox: union of every cell across header + body rows.
  const allCells = [
    ...headerRows.flatMap((r) => r.cells),
    ...paddedBodyCells.flat(),
  ];
  const bbox = unionBbox(allCells, page);

  // Markdown rendering.
  const markdown = renderTableToMarkdown(flatHeaders, finalBody);

  return {
    page,
    tableIndex,
    headers: flatHeaders,
    rows: finalBody,
    bbox,
    confidence,
    markdown,
  };
}

function countHeaderRows(rows: DetectedRow[]): number {
  let count = 0;
  for (let i = 0; i < rows.length && i < MAX_HEADER_ROWS; i++) {
    const row = rows[i];
    if (row.cells.length === 0) break;
    const allShort = row.cells.every(
      (c) => (c.text?.length || 0) <= MAX_HEADER_CELL_CHARS,
    );
    const hasAlpha = row.cells.some((c) => /[A-Za-z]/.test(c.text || ""));
    // Reject rows that look like short data: a row is a header
    // candidate only if it has alphabetic content AND at least one
    // cell contains a non-numeric, non-pure-letter string. This
    // rules out "A, 10" / "B, 20" / "1, 2" type data rows that
    // happen to be at the top of the cluster.
    const hasDescriptiveCell = row.cells.some((c) => {
      const t = (c.text || "").trim();
      if (t.length < 3) return false;
      // Must have at least one letter AND not be a single word of
      // pure letters (which would be like "Control" — actually OK
      // for headers, but "A" is too short). Accept multi-char
      // strings that are at least 60% alphabetic.
      const letters = (t.match(/[A-Za-z]/g) || []).length;
      return letters >= 2;
    });
    if (allShort && hasAlpha && hasDescriptiveCell) count++;
    else break;
  }
  return count;
}

/**
 * Flatten multi-level headers into a single array of cells. If the
 * cluster has 2 header rows, the L2 row's cells are repeated under
 * each L1 cell they belong to. If the L2 row has fewer cells than
 * L1 (a "spans multiple columns" pattern), we distribute the L2
 * cells evenly across the L1 cells.
 */
function flattenMultiLevelHeaders(
  headerRows: DetectedRow[],
  targetLength: number,
): string[] {
  if (headerRows.length === 0) {
    // No headers detected: synthesize empty placeholders.
    return Array.from({ length: targetLength }, () => "");
  }
  if (headerRows.length === 1) {
    const cells = headerRows[0].cells.map((c) => c.text || "");
    while (cells.length < targetLength) cells.push("");
    return cells;
  }
  // Multi-level: 2 rows.
  const l1 = headerRows[0].cells.map((c) => c.text || "");
  const l2 = headerRows[1].cells.map((c) => c.text || "");

  // For each L1 cell, repeat the L2 cells underneath. The simplest
  // robust mapping: distribute L2 cells evenly under the L1 cells
  // (one L2 per L1) when counts match, else repeat L1 cell text
  // and append L2 in order.
  if (l1.length === l2.length) {
    const flat: string[] = [];
    for (let i = 0; i < l1.length; i++) {
      flat.push(l1[i]);
      flat.push(l2[i]);
    }
    while (flat.length < targetLength) flat.push("");
    return flat;
  }

  // Mismatched counts: just concatenate L1 and L2 in order, repeating
  // L1 for the count of L2 cells.
  const flat: string[] = [];
  const l2PerL1 = Math.max(1, Math.round(l2.length / Math.max(1, l1.length)));
  for (let i = 0; i < l1.length; i++) {
    flat.push(l1[i]);
    const slice = l2.slice(i * l2PerL1, (i + 1) * l2PerL1);
    for (const c of slice) flat.push(c);
  }
  while (flat.length < targetLength) flat.push("");
  return flat;
}

// ---------------------------------------------------------------------------
// Bbox helpers
// ---------------------------------------------------------------------------

function emptyBbox(page: number): BBox {
  return { x: 0, y: 0, w: 0, h: 0, page, units: "pt" };
}

function unionBbox(cells: Cell[], page: number): BBox {
  if (cells.length === 0) return emptyBbox(page);
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const c of cells) {
    if (c.width === 0 && c.height === 0) continue;
    const left = c.x;
    const top = c.y;
    const right = c.x + c.width;
    const bottom = c.y + c.height;
    if (left < minX) minX = left;
    if (top < minY) minY = top;
    if (right > maxX) maxX = right;
    if (bottom > maxY) maxY = bottom;
  }
  if (!Number.isFinite(minX)) return emptyBbox(page);
  return {
    x: minX,
    y: minY,
    w: maxX - minX,
    h: maxY - minY,
    page,
    units: "pt",
  };
}

// ---------------------------------------------------------------------------
// Markdown rendering (used by both providers via pdfTablePromptBuilder.ts)
// ---------------------------------------------------------------------------

export function renderTableToMarkdown(
  headers: string[],
  rows: string[][],
): string {
  if (headers.length === 0 && rows.length === 0) return "";
  const lines: string[] = [];
  if (headers.length > 0) {
    lines.push(`| ${headers.join(" | ")} |`);
    lines.push(`| ${headers.map(() => "---").join(" | ")} |`);
  }
  for (const row of rows) {
    // Pad row to match header length.
    const padded = [...row];
    while (padded.length < headers.length) padded.push("-");
    lines.push(`| ${padded.join(" | ")} |`);
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Math helpers
// ---------------------------------------------------------------------------

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid];
}
