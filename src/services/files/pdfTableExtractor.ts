/**
 * PDF Table Extractor — provider abstraction + orchestrator.
 *
 * Public surface:
 *   - `TableExtractionProvider` — the interface every provider implements
 *   - `LocalTableExtractionProvider` / `MistralTableExtractionProvider`
 *     — the two shipped providers
 *   - `extractPDFTables(sourceId, pdf)` — cache-aware, quality-gated
 *     orchestrator that picks the right provider
 *   - `loadTablesForSource` / `loadFiguresForSource` — read wrappers
 *   - `persistExtractedTables` / `persistExtractedFigures` — write helpers
 *   - `buildTablesPromptSection(tables)` — pure LLM prompt helper
 *   - `TableExtractionProviderError` — error type
 *
 * Cache model: the orchestrator checks `research_evidence_tables` for the
 * source first. A non-empty result short-circuits and returns `provider:
 * "cache"`. Otherwise it runs the local provider, evaluates the quality
 * gate, and (in `auto` mode) falls back to Mistral when the gate fails.
 *
 * Coordinate space: bboxes are stored in PDF point space (origin
 * bottom-left, units = pt). The viewer at 1.5x scale multiplies by 1.5
 * to land in canvas pixel space.
 */

import { getServiceClient } from "../../db/client";
import logger from "../../utils/logger";
import { loadPdfjsLegacy } from "./loaders/pdfjsLegacy";
import { LocalTableExtractionProvider } from "./providers/localPdfTableProvider";
import { MistralTableExtractionProvider } from "./providers/mistralOcrProvider";
import { evaluateQualityGate } from "./qualityGate";

// Re-export the prompt helper from the dedicated module so existing
// callers (the bioprospecting extractor and tests) can keep importing
// it from this file. The helper itself is pure and lives in its own
// module to keep the orchestrator module-load time small.
export { buildTablesPromptSection } from "./pdfTablePromptBuilder";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Bounding box in PDF point space. Origin is bottom-left, units are
 * `pt` (1/72 in). The viewer at 1.5x scale multiplies each field by
 * 1.5 to land in canvas pixel space; that constant is the only knob.
 */
export interface BBox {
  x: number;
  y: number;
  w: number;
  h: number;
  page: number;
  units: "pt";
}

/**
 * One extracted table. The `headers` array is FLATTENED per the
 * multi-level rule: if the source had 2 header rows with 2 columns
 * each (a 2x2 hierarchy), `headers` is `[L1_1, L1_2, L2_a, L2_b]`
 * where `L2_a` is the L2 header under `L1_1`, etc. Empty cells in
 * `rows` are normalized to `"-"` at output time.
 */
export interface ExtractedTable {
  page: number;
  tableIndex: number;
  headers: string[];
  rows: string[][];
  bbox: BBox;
  confidence: number;
  markdown: string;
}

export interface ExtractedFigure {
  page: number;
  figureIndex: number;
  bbox: BBox;
  caption: string | null;
}

/**
 * Provider abstraction. Each provider knows how to walk a PDF buffer
 * and return detected tables (and optionally figures). The local
 * provider is in-process; the Mistral provider is HTTP.
 */
export interface TableExtractionProvider {
  readonly name: "local" | "mistral";
  extract(pdf: Uint8Array): Promise<ExtractedTable[]>;
  extractFigures?(pdf: Uint8Array): Promise<ExtractedFigure[]>;
}

export class TableExtractionProviderError extends Error {
  constructor(
    message: string,
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = "TableExtractionProviderError";
  }
}

// ---------------------------------------------------------------------------
// Persistence row shapes
// ---------------------------------------------------------------------------

export type ResearchEvidenceTableRow = {
  id: string;
  source_id: string;
  page: number;
  table_index: number;
  headers: string[];
  rows: string[][];
  markdown: string;
  bbox: BBox;
  extraction_provider: "local" | "mistral";
  extraction_confidence: number;
  created_at?: string;
};

export type ResearchEvidenceFigureRow = {
  id: string;
  source_id: string;
  page: number;
  figure_index: number;
  bbox: BBox;
  caption: string | null;
  created_at?: string;
};

// ---------------------------------------------------------------------------
// Provider mode resolution (TDZ-safe via globalThis)
// ---------------------------------------------------------------------------

const MODE_KEY = "__bioprospectingTableExtractionMode";

function resolveMode(): "auto" | "local" | "mistral" {
  const cached = (globalThis as any)[MODE_KEY] as
    | "auto"
    | "local"
    | "mistral"
    | undefined;
  if (cached) return cached;
  const raw = (process.env.TABLE_EXTRACTION_PROVIDER || "auto").toLowerCase();
  const mode =
    raw === "local" || raw === "mistral" || raw === "auto"
      ? (raw as "auto" | "local" | "mistral")
      : "auto";
  (globalThis as any)[MODE_KEY] = mode;
  return mode;
}

/**
 * Returns the active mode. Memoized via `globalThis` so Bun workers
 * (which have different module-init order than the main process)
 * do not hit TDZ on `process.env.TABLE_EXTRACTION_PROVIDER`.
 */
export function getTableExtractionProviderMode(): "auto" | "local" | "mistral" {
  return resolveMode();
}

// ---------------------------------------------------------------------------
// Provider instances (also memoized via globalThis)
// ---------------------------------------------------------------------------

const LOCAL_PROVIDER_KEY = "__bioprospectingLocalTableExtractionProvider";
const MISTRAL_PROVIDER_KEY = "__bioprospectingMistralTableExtractionProvider";

function getLocalProvider(): LocalTableExtractionProvider {
  let p = (globalThis as any)[LOCAL_PROVIDER_KEY] as
    | LocalTableExtractionProvider
    | undefined;
  if (p) return p;
  p = new LocalTableExtractionProvider(loadPdfjsLegacy);
  (globalThis as any)[LOCAL_PROVIDER_KEY] = p;
  return p;
}

function getMistralProvider(): MistralTableExtractionProvider {
  let p = (globalThis as any)[MISTRAL_PROVIDER_KEY] as
    | MistralTableExtractionProvider
    | undefined;
  if (p) return p;
  p = new MistralTableExtractionProvider();
  (globalThis as any)[MISTRAL_PROVIDER_KEY] = p;
  return p;
}

// ---------------------------------------------------------------------------
// Read helpers (cache check + downstream callers)
// ---------------------------------------------------------------------------

/**
 * Look up persisted tables for a source. Returns `[]` if the source
 * has no extracted tables yet. Order is `(page, table_index)` ASC.
 */
export async function loadTablesForSource(
  sourceId: string,
): Promise<ResearchEvidenceTableRow[]> {
  if (!sourceId) return [];
  const sb = getServiceClient();
  const { data, error } = await sb
    .from("research_evidence_tables")
    .select("*")
    .eq("source_id", sourceId)
    .order("page", { ascending: true })
    .order("table_index", { ascending: true });
  if (error) {
    logger.warn({ err: error, sourceId }, "pdf_table_load_tables_failed");
    return [];
  }
  return (data || []) as ResearchEvidenceTableRow[];
}

/**
 * Look up persisted figures for a source. Order is
 * `(page, figure_index)` ASC.
 */
export async function loadFiguresForSource(
  sourceId: string,
): Promise<ResearchEvidenceFigureRow[]> {
  if (!sourceId) return [];
  const sb = getServiceClient();
  const { data, error } = await sb
    .from("research_evidence_figures")
    .select("*")
    .eq("source_id", sourceId)
    .order("page", { ascending: true })
    .order("figure_index", { ascending: true });
  if (error) {
    logger.warn({ err: error, sourceId }, "pdf_table_load_figures_failed");
    return [];
  }
  return (data || []) as ResearchEvidenceFigureRow[];
}

// ---------------------------------------------------------------------------
// Write helpers
// ---------------------------------------------------------------------------

/**
 * Persist extracted tables for a source. The unique constraint on
 * `(source_id, page, table_index)` is the authoritative idempotency
 * guard: collisions return existing rows, no overwrite.
 *
 * Returns the rows that ended up in the table (existing + inserted).
 * If a collision happens, the EXISTING row is returned (so callers
 * see stable ids even on re-runs).
 */
export async function persistExtractedTables(
  sourceId: string,
  tables: ExtractedTable[],
  provider: "local" | "mistral",
): Promise<ResearchEvidenceTableRow[]> {
  if (tables.length === 0) return [];
  const sb = getServiceClient();
  const payload = tables.map((t) => ({
    source_id: sourceId,
    page: t.page,
    table_index: t.tableIndex,
    headers: t.headers,
    rows: t.rows,
    markdown: t.markdown,
    bbox: t.bbox,
    extraction_provider: provider,
    extraction_confidence: t.confidence,
  }));

  const { data, error } = await sb
    .from("research_evidence_tables")
    .insert(payload)
    .select("*");
  if (!error) return (data || []) as ResearchEvidenceTableRow[];

  // 23505 = unique violation → some rows already exist. Re-read all
  // (source, page, table_index) tuples and return the canonical
  // set so the caller has stable ids.
  if (error.code === "23505") {
    const keys = tables.map((t) => ({
      page: t.page,
      table_index: t.tableIndex,
    }));
    const orExpr = keys
      .map((k) => `and(page.eq.${k.page},table_index.eq.${k.table_index})`)
      .join(",");
    const { data: existing, error: readError } = await sb
      .from("research_evidence_tables")
      .select("*")
      .eq("source_id", sourceId)
      .or(orExpr);
    if (readError) {
      logger.warn(
        { err: readError, sourceId },
        "pdf_table_persist_collision_re_read_failed",
      );
      return [];
    }
    return (existing || []) as ResearchEvidenceTableRow[];
  }

  throw error;
}

/**
 * Persist extracted figures for a source. Mirrors the tables
 * persistence path.
 */
export async function persistExtractedFigures(
  sourceId: string,
  figures: ExtractedFigure[],
): Promise<ResearchEvidenceFigureRow[]> {
  if (figures.length === 0) return [];
  const sb = getServiceClient();
  const payload = figures.map((f) => ({
    source_id: sourceId,
    page: f.page,
    figure_index: f.figureIndex,
    bbox: f.bbox,
    caption: f.caption,
  }));

  const { data, error } = await sb
    .from("research_evidence_figures")
    .insert(payload)
    .select("*");
  if (!error) return (data || []) as ResearchEvidenceFigureRow[];

  if (error.code === "23505") {
    const keys = figures.map((f) => ({
      page: f.page,
      figure_index: f.figureIndex,
    }));
    const orExpr = keys
      .map((k) => `and(page.eq.${k.page},figure_index.eq.${k.figure_index})`)
      .join(",");
    const { data: existing, error: readError } = await sb
      .from("research_evidence_figures")
      .select("*")
      .eq("source_id", sourceId)
      .or(orExpr);
    if (readError) {
      logger.warn(
        { err: readError, sourceId },
        "pdf_figure_persist_collision_re_read_failed",
      );
      return [];
    }
    return (existing || []) as ResearchEvidenceFigureRow[];
  }

  throw error;
}

// ---------------------------------------------------------------------------
// Main orchestrator
// ---------------------------------------------------------------------------

export interface ExtractPDFTablesResult {
  tables: ExtractedTable[];
  figures: ExtractedFigure[];
  provider: "local" | "mistral" | "cache";
}

/**
 * Extract tables (and figures, when the provider supports them) for
 * a source. Cache-aware: returns `provider: "cache"` if the source
 * already has tables. Quality-gated: in `auto` mode, the local
 * provider is run first; if its output fails the quality gate
 * (`< 3` tables or `avg row confidence < 0.5`), Mistral is consulted
 * as a fallback. The local output is NOT persisted when fallback
 * fires (only the Mistral result is saved).
 */
export async function extractPDFTables(
  sourceId: string,
  pdf: Uint8Array,
): Promise<ExtractPDFTablesResult> {
  // 1. Cache check
  const existing = await loadTablesForSource(sourceId);
  if (existing.length > 0) {
    return {
      tables: existing.map(rowToExtractedTable),
      figures: (await loadFiguresForSource(sourceId)).map(rowToExtractedFigure),
      provider: "cache",
    };
  }

  const mode = resolveMode();
  const local = getLocalProvider();
  const mistral = getMistralProvider();

  // 2. Run local provider (or jump straight to Mistral if mode = "mistral")
  let localTables: ExtractedTable[] = [];
  let localError: unknown = null;
  if (mode === "auto" || mode === "local") {
    try {
      localTables = await local.extract(pdf);
    } catch (error) {
      localError = error;
      logger.warn(
        { err: error, sourceId },
        "pdf_table_extraction_local_failed",
      );
    }
  }

  // 3. Quality gate on the local output
  const gate = evaluateQualityGate(localTables);
  logger.info(
    {
      sourceId,
      reason: gate.reason,
      tables: gate.tables,
      avgConfidence: gate.avgConfidence,
      provider: "local",
    },
    "pdf_table_extraction_quality_gate",
  );

  if (
    gate.action === "pass" ||
    mode === "local" ||
    (mode === "auto" && gate.action === "pass")
  ) {
    // Persist the local result and return.
    const persisted = await persistExtractedTables(
      sourceId,
      localTables,
      "local",
    );
    return {
      tables: persisted.map(rowToExtractedTable),
      figures: [],
      provider: "local",
    };
  }

  // 4. Fallback to Mistral (only in `auto` mode when local failed the gate,
  //    or in `mistral` mode when local was skipped)
  if (mode === "auto" || mode === "mistral") {
    try {
      const mistralTables = await mistral.extract(pdf);
      const mistralFigures = (await mistral.extractFigures?.(pdf)) ?? [];
      const persisted = await persistExtractedTables(
        sourceId,
        mistralTables,
        "mistral",
      );
      const persistedFigures = await persistExtractedFigures(
        sourceId,
        mistralFigures,
      );
      return {
        tables: persisted.map(rowToExtractedTable),
        figures: persistedFigures.map(rowToExtractedFigure),
        provider: "mistral",
      };
    } catch (error) {
      logger.error(
        {
          err: error,
          sourceId,
          localError: localError instanceof Error ? localError.message : null,
        },
        "pdf_table_extraction_mistral_failed",
      );
      // If Mistral also fails, return whatever the local provider
      // gave us (even though it failed the gate) so the LLM at
      // least has the data.
      if (localTables.length > 0) {
        const persisted = await persistExtractedTables(
          sourceId,
          localTables,
          "local",
        );
        return {
          tables: persisted.map(rowToExtractedTable),
          figures: [],
          provider: "local",
        };
      }
      return { tables: [], figures: [], provider: "local" };
    }
  }

  // Should not reach here — defensive default.
  return { tables: [], figures: [], provider: "local" };
}

// ---------------------------------------------------------------------------
// Row → ExtractedTable mappers
// ---------------------------------------------------------------------------

function rowToExtractedTable(row: ResearchEvidenceTableRow): ExtractedTable {
  return {
    page: row.page,
    tableIndex: row.table_index,
    headers: row.headers,
    rows: row.rows,
    bbox: row.bbox,
    confidence: Number(row.extraction_confidence),
    markdown: row.markdown,
  };
}

function rowToExtractedFigure(row: ResearchEvidenceFigureRow): ExtractedFigure {
  return {
    page: row.page,
    figureIndex: row.figure_index,
    bbox: row.bbox,
    caption: row.caption,
  };
}
