/**
 * Pure helper that turns a list of `ExtractedTable` into the
 * `tables:` block injected into the bioprospecting LLM prompt.
 *
 * Output format (per spec):
 *
 *   tables:
 *     page=1 table=0
 *     | Treatment | Yield [mg/mL] |
 *     | --- | --- |
 *     | A | 10 |
 *     | B | 20 |
 *     page=1 table=1
 *     | ...
 *
 * The block is grouped by `(page, tableIndex)` ascending. Empty
 * cells in `rows` are normalized to `"-"` (the spec says empty
 * cells in extracted tables render as `-`).
 *
 * If the input list is empty, returns `""` — the caller checks
 * for empty and skips the injection in that case.
 */

import type { ExtractedTable } from "./pdfTableExtractor";

export function buildTablesPromptSection(tables: ExtractedTable[]): string {
  if (!tables || tables.length === 0) return "";

  const grouped = [...tables].sort(
    (a, b) => a.page - b.page || a.tableIndex - b.tableIndex,
  );

  const lines: string[] = ["tables:"];

  for (const table of grouped) {
    lines.push(`  page=${table.page} table=${table.tableIndex}`);

    const headers = table.headers.map(normalizeCell);
    if (headers.length > 0) {
      lines.push(renderHeaderRow(headers));
      lines.push(renderSeparator(headers.length));
    }

    for (const row of table.rows) {
      const padded = [...row];
      while (padded.length < headers.length) padded.push("-");
      const normalized = padded.map(normalizeCell);
      lines.push(renderDataRow(normalized));
    }
  }

  return lines.join("\n");
}

function normalizeCell(cell: string | null | undefined): string {
  if (cell == null) return "-";
  const trimmed = String(cell).trim();
  return trimmed === "" ? "-" : trimmed;
}

function renderHeaderRow(cells: string[]): string {
  return `    | ${cells.join(" | ")} |`;
}

function renderDataRow(cells: string[]): string {
  return `    | ${cells.join(" | ")} |`;
}

function renderSeparator(n: number): string {
  return `    | ${Array.from({ length: n }, () => "---").join(" | ")} |`;
}
