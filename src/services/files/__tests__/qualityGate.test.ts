/**
 * Unit tests for the quality gate.
 */

import { describe, expect, it } from "bun:test";
import type { ExtractedTable } from "../pdfTableExtractor";
import {
  evaluateQualityGate,
  MIN_AVG_CONFIDENCE,
  MIN_TABLES,
  rowConfidence,
} from "../qualityGate";

function makeTable(rows: string[][], page = 1, tableIndex = 0): ExtractedTable {
  return {
    page,
    tableIndex,
    headers: ["Col1", "Col2"],
    rows,
    bbox: { x: 0, y: 0, w: 100, h: 50, page, units: "pt" },
    confidence: 0.5,
    markdown: "",
  };
}

describe("qualityGate — evaluateQualityGate", () => {
  it("returns low_table_count for an empty list", () => {
    const decision = evaluateQualityGate([]);
    expect(decision.action).toBe("fallback");
    expect(decision.reason).toBe("low_table_count");
    expect(decision.tables).toBe(0);
    expect(decision.avgConfidence).toBe(0);
  });

  it(`returns low_table_count for ${MIN_TABLES - 1} tables`, () => {
    const tables = [makeTable([["A", "B"]]), makeTable([["C", "D"]], 1, 1)];
    const decision = evaluateQualityGate(tables);
    expect(decision.action).toBe("fallback");
    expect(decision.reason).toBe("low_table_count");
    expect(decision.tables).toBe(2);
  });

  it(`returns passed for exactly ${MIN_TABLES} tables with avg confidence >= ${MIN_AVG_CONFIDENCE}`, () => {
    // 3 tables, 2 rows each. Each cell is 8 chars → row confidence
    // = 16/16 = 1 → avg = 1 ≥ 0.5 → pass.
    const tables = [
      makeTable([
        ["12345678", "abcdefgh"],
        ["ijklmnop", "qrstuvwx"],
      ]),
      makeTable([
        ["12345678", "abcdefgh"],
        ["ijklmnop", "qrstuvwx"],
      ]),
      makeTable([
        ["12345678", "abcdefgh"],
        ["ijklmnop", "qrstuvwx"],
      ]),
    ];
    const decision = evaluateQualityGate(tables);
    expect(decision.action).toBe("pass");
    expect(decision.reason).toBe("passed");
    expect(decision.tables).toBe(3);
  });

  it("returns low_row_confidence when avg confidence < 0.5", () => {
    const tables = [
      makeTable([
        ["-", "-"],
        ["-", "-"],
      ]),
      makeTable([
        ["-", "-"],
        ["-", "-"],
      ]),
      makeTable([
        ["-", "-"],
        ["-", "-"],
      ]),
      makeTable([
        ["-", "-"],
        ["-", "-"],
      ]),
    ];
    const decision = evaluateQualityGate(tables);
    expect(decision.action).toBe("fallback");
    expect(decision.reason).toBe("low_row_confidence");
    // Empty cells → confidence 0 → avg 0
    expect(decision.avgConfidence).toBe(0);
  });

  it("table_count is checked BEFORE row_confidence (precedence)", () => {
    // 2 tables with high confidence (would pass row_confidence
    // individually) but low table count → still fallback.
    const tables = [
      makeTable([
        ["long text here", "more text"],
        ["still more", "and more"],
      ]),
      makeTable([
        ["long text here", "more text"],
        ["still more", "and more"],
      ]),
    ];
    const decision = evaluateQualityGate(tables);
    expect(decision.action).toBe("fallback");
    expect(decision.reason).toBe("low_table_count");
  });

  it("avgConfidence aggregates across all tables and rows", () => {
    // 3 tables, 2 rows each. Rows have varying character counts.
    // Each row's confidence = totalChars / (numCells * 8).
    const tables = [
      // row 1: 6 chars / 16 = 0.375; row 2: 6 / 16 = 0.375
      makeTable([
        ["abc", "def"],
        ["ghi", "jkl"],
      ]),
      // row 3: 8 / 16 = 0.5; row 4: 8 / 16 = 0.5
      makeTable([
        ["mnop", "qrst"],
        ["uvwx", "yz12"],
      ]),
      // row 5: 2 / 16 = 0.125; row 6: 2 / 16 = 0.125
      makeTable([
        ["3", "4"],
        ["5", "6"],
      ]),
    ];
    const decision = evaluateQualityGate(tables);
    // 0.333 < 0.5 → low_row_confidence
    expect(decision.action).toBe("fallback");
    expect(decision.reason).toBe("low_row_confidence");
    // avg = (0.375 + 0.375 + 0.5 + 0.5 + 0.125 + 0.125) / 6 = 0.333
    expect(decision.avgConfidence).toBeCloseTo(0.333, 2);
  });
});

describe("qualityGate — rowConfidence", () => {
  it("returns 0 for an empty row", () => {
    expect(rowConfidence([])).toBe(0);
  });

  it("returns 0 for a row of all empty cells", () => {
    expect(rowConfidence(["-", "-", "-"])).toBe(0);
  });

  it("returns 1 for a fully populated row (>= 8 chars per cell)", () => {
    expect(rowConfidence(["12345678", "abcdefgh"])).toBe(1);
  });

  it("scales linearly below the 8-chars-per-cell threshold", () => {
    // 8 chars in 2 cells, target 16 → 0.5
    expect(rowConfidence(["abcd", "efgh"])).toBeCloseTo(0.5, 5);
  });

  it("treats '-' as 0 chars", () => {
    // 4 chars + 0 from "-" in 2 cells → 0.25
    expect(rowConfidence(["abcd", "-"])).toBeCloseTo(0.25, 5);
  });
});
