/**
 * Quality gate for the local table extraction output.
 *
 * Pure function. Decides whether the local provider's output is
 * "good enough" to skip the Mistral fallback. The decision is
 * driven by two signals:
 *   - `low_table_count`: fewer than `MIN_TABLES` (3) tables.
 *   - `low_row_confidence`: average row confidence < `MIN_AVG_CONFIDENCE` (0.5).
 *
 * When the gate fails, the orchestrator calls Mistral. When it
 * passes, the orchestrator persists the local result and returns.
 *
 * The thresholds are exported as constants so tests and operators
 * can reference them.
 */

import type { ExtractedTable } from "./pdfTableExtractor";

export const MIN_TABLES = 3;
export const MIN_AVG_CONFIDENCE = 0.5;

export type QualityGateDecision =
  | {
      action: "pass";
      reason: "passed";
      tables: number;
      avgConfidence: number;
    }
  | {
      action: "fallback";
      reason: "low_table_count";
      tables: number;
      avgConfidence: number;
    }
  | {
      action: "fallback";
      reason: "low_row_confidence";
      tables: number;
      avgConfidence: number;
    };

/**
 * Evaluate the quality of a list of extracted tables. Returns the
 * decision the orchestrator should act on, plus the diagnostic
 * numbers (table count, average row confidence) that drove it.
 */
export function evaluateQualityGate(
  tables: ExtractedTable[],
): QualityGateDecision {
  const tableCount = tables.length;

  const rowConfidences: number[] = [];
  for (const t of tables) {
    for (const row of t.rows) {
      rowConfidences.push(rowConfidence(row));
    }
  }

  const avgConfidence =
    rowConfidences.length === 0
      ? 0
      : rowConfidences.reduce((a, b) => a + b, 0) / rowConfidences.length;

  if (tableCount < MIN_TABLES) {
    return {
      action: "fallback",
      reason: "low_table_count",
      tables: tableCount,
      avgConfidence,
    };
  }
  if (avgConfidence < MIN_AVG_CONFIDENCE) {
    return {
      action: "fallback",
      reason: "low_row_confidence",
      tables: tableCount,
      avgConfidence,
    };
  }
  return {
    action: "pass",
    reason: "passed",
    tables: tableCount,
    avgConfidence,
  };
}

/**
 * Per-row confidence: `min(1, totalChars / (numCells * 8))`. Empty
 * cells (`"-"`) count as 0 chars. This is the same formula used by
 * the local provider when computing the table-level confidence; the
 * gate uses it on the post-extraction rows to keep the two signals
 * aligned.
 */
export function rowConfidence(row: string[]): number {
  const totalChars = row.reduce(
    (n, cell) => n + (cell === "-" || !cell ? 0 : cell.length),
    0,
  );
  return Math.min(1, totalChars / Math.max(1, row.length * 8));
}
