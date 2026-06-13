/**
 * Unit tests for the prompt builder.
 */

import { describe, expect, it } from "bun:test";
import type { ExtractedTable } from "../pdfTableExtractor";
import { buildTablesPromptSection } from "../pdfTablePromptBuilder";

function makeTable(overrides: Partial<ExtractedTable>): ExtractedTable {
  return {
    page: 1,
    tableIndex: 0,
    headers: ["A", "B"],
    rows: [["1", "2"]],
    bbox: { x: 0, y: 0, w: 100, h: 50, page: 1, units: "pt" },
    confidence: 0.5,
    markdown: "",
    ...overrides,
  };
}

describe("pdfTablePromptBuilder — buildTablesPromptSection", () => {
  it("returns '' for an empty input", () => {
    expect(buildTablesPromptSection([])).toBe("");
  });

  it("emits a tables: header line", () => {
    const out = buildTablesPromptSection([makeTable({})]);
    expect(out.startsWith("tables:")).toBe(true);
  });

  it("emits page=N table=M labels for each table", () => {
    const out = buildTablesPromptSection([
      makeTable({ page: 2, tableIndex: 1, headers: ["x"], rows: [["y"]] }),
    ]);
    expect(out).toContain("page=2 table=1");
  });

  it("renders the header row in pipe format", () => {
    const out = buildTablesPromptSection([
      makeTable({ headers: ["Treatment", "Yield"], rows: [["A", "10"]] }),
    ]);
    expect(out).toContain("| Treatment | Yield |");
    expect(out).toContain("| --- | --- |");
  });

  it("renders data rows in pipe format", () => {
    const out = buildTablesPromptSection([
      makeTable({
        headers: ["x", "y"],
        rows: [
          ["1", "2"],
          ["3", "4"],
        ],
      }),
    ]);
    expect(out).toContain("| 1 | 2 |");
    expect(out).toContain("| 3 | 4 |");
  });

  it("normalizes empty cells to '-'", () => {
    const out = buildTablesPromptSection([
      makeTable({ headers: ["a", "b"], rows: [["", "x"]] }),
    ]);
    expect(out).toContain("| - | x |");
  });

  it("orders tables by (page, tableIndex) ascending", () => {
    const t1 = makeTable({
      page: 2,
      tableIndex: 0,
      headers: ["a"],
      rows: [["x"]],
    });
    const t2 = makeTable({
      page: 1,
      tableIndex: 5,
      headers: ["b"],
      rows: [["y"]],
    });
    const t3 = makeTable({
      page: 1,
      tableIndex: 0,
      headers: ["c"],
      rows: [["z"]],
    });
    const out = buildTablesPromptSection([t1, t2, t3]);
    // Find the order of the page= labels.
    const cIdx = out.indexOf("page=1 table=0");
    const bIdx = out.indexOf("page=1 table=5");
    const aIdx = out.indexOf("page=2 table=0");
    expect(cIdx).toBeLessThan(bIdx);
    expect(bIdx).toBeLessThan(aIdx);
  });

  it("handles multi-level headers (flattened) without crashing", () => {
    // The detector flattens multi-level headers before they reach
    // the prompt builder, so the prompt builder sees a flat array.
    // The builder just renders whatever it's given.
    const out = buildTablesPromptSection([
      makeTable({
        headers: ["L1A", "L1B", "L2A", "L2B", "L2C"],
        rows: [["1", "2", "3", "4", "5"]],
      }),
    ]);
    expect(out).toContain("| L1A | L1B | L2A | L2B | L2C |");
    expect(out).toContain("| --- | --- | --- | --- | --- |");
    expect(out).toContain("| 1 | 2 | 3 | 4 | 5 |");
  });

  it("pads short body rows with '-' to match the header length", () => {
    const out = buildTablesPromptSection([
      makeTable({ headers: ["a", "b", "c"], rows: [["1"]] }),
    ]);
    expect(out).toContain("| 1 | - | - |");
  });

  it("emits no header row when headers is empty (markdown-only tables from Mistral)", () => {
    const out = buildTablesPromptSection([
      makeTable({ headers: [], rows: [] }),
    ]);
    // No " | --- |" separator because there's no header row.
    expect(out).not.toContain("| --- |");
  });
});
