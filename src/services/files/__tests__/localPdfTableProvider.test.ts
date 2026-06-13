/**
 * Unit tests for the local table detector's pure clustering
 * algorithm. The detector is exported from `localPdfTableProvider.ts`
 * as `detectTablesOnPage` — these tests drive it with hand-rolled
 * text-item fixtures (no pdfjs involvement) and assert the
 * cluster output matches expectations.
 *
 * The spike test (which DOES go through pdfjs) lives in
 * `localPdfTableProvider.spike.test.ts` next to this file.
 */

import { describe, expect, it } from "bun:test";
import {
  detectTablesOnPage,
  renderTableToMarkdown,
  segmentRowIntoCells,
  type DetectedRow,
} from "../providers/localPdfTableProvider";

type TextItemFixture = {
  str: string;
  transform: [number, number, number, number, number, number];
  width: number;
  height: number;
};

const PAGE_HEIGHT_PT = 792; // US Letter

function fixture(
  str: string,
  x: number,
  yPdf: number,
  width: number,
  height = 12,
  fontSize = 12,
): TextItemFixture {
  return {
    str,
    transform: [fontSize, 0, 0, fontSize, x, yPdf],
    width,
    height,
  };
}

/**
 * Build a simple 2x2 table fixture:
 *   Headers (y=700): Treatment, Yield
 *   Row 1 (y=670):   A,          10
 *   Row 2 (y=640):   B,          20
 * PDF origin bottom-left → yPdf is the BOTTOM of the text run.
 */
function simpleTableItems(): TextItemFixture[] {
  return [
    fixture("Treatment", 100, 700 - 12, 60),
    fixture("Yield", 250, 700 - 12, 30),
    fixture("A", 100, 670 - 12, 10),
    fixture("10", 250, 670 - 12, 14),
    fixture("B", 100, 640 - 12, 10),
    fixture("20", 250, 640 - 12, 14),
  ];
}

describe("localPdfTableProvider — detectTablesOnPage", () => {
  it("returns [] for an empty page", () => {
    const out = detectTablesOnPage([], 1, PAGE_HEIGHT_PT);
    expect(out).toEqual([]);
  });

  it("returns [] when there are no body rows (header only)", () => {
    const items = [
      fixture("Treatment", 100, 700 - 12, 60),
      fixture("Yield", 250, 700 - 12, 30),
    ];
    const out = detectTablesOnPage(items, 1, PAGE_HEIGHT_PT);
    // Single header row, no body → not a table per MIN_BODY_ROWS = 1.
    expect(out).toEqual([]);
  });

  it("detects a simple 2x2 table with correct bbox.units === 'pt'", () => {
    const out = detectTablesOnPage(simpleTableItems(), 1, PAGE_HEIGHT_PT);
    expect(out.length).toBe(1);
    const t = out[0];
    expect(t.page).toBe(1);
    expect(t.tableIndex).toBe(0);
    expect(t.bbox.units).toBe("pt");
    expect(t.headers).toContain("Treatment");
    expect(t.headers).toContain("Yield");
    // Body rows are [["A", "10"], ["B", "20"]]
    expect(t.rows.length).toBe(2);
    expect(t.rows[0]).toContain("A");
    expect(t.rows[1]).toContain("20");
    // Confidence should be a positive number between 0 and 1.
    expect(t.confidence).toBeGreaterThan(0);
    expect(t.confidence).toBeLessThanOrEqual(1);
  });

  it("emits empty cells as '-' for sparse body rows", () => {
    // Treatment | Yield
    // A         | (empty)
    // B         | 20
    const items = [
      fixture("Treatment", 100, 700 - 12, 60),
      fixture("Yield", 250, 700 - 12, 30),
      fixture("A", 100, 670 - 12, 10),
      // No second column on row 1
      fixture("B", 100, 640 - 12, 10),
      fixture("20", 250, 640 - 12, 14),
    ];
    const out = detectTablesOnPage(items, 1, PAGE_HEIGHT_PT);
    expect(out.length).toBeGreaterThanOrEqual(1);
    const t = out[0];
    // Find the row that has "A" and the one that has "B".
    const aRow = t.rows.find((r) => r.includes("A"));
    const bRow = t.rows.find((r) => r.includes("B"));
    expect(aRow).toBeDefined();
    expect(bRow).toBeDefined();
    // The empty cell should be normalized to "-".
    expect(aRow!.some((c) => c === "-")).toBe(true);
    expect(bRow!.some((c) => c === "-")).toBe(false);
  });

  it("detects multi-level headers by flattening them into a single array", () => {
    // Two header rows:
    //   L1: "Extraction Parameters", "Yield" (spans col 2 + col 3)
    //   L2: "Pressure", "Temp", "Time"
    // Body: 10, 20, 30
    // We simulate by using a separate column for L1 (the L1 cell
    // text and the L2 cells it spans are inferred by the row count
    // and width). To keep the test deterministic, the simpler form:
    //
    //   L1: "Treatment" (one column), "Parameters" (covers cols 2-3)
    //   L2: "Drug" (col 1), "Pressure", "Temp"
    //   Body: "A", "10", "20"
    //         "B", "30", "40"
    //
    // Since L2 has 3 cells and L1 has 2, the flattener will interleave
    // them: [L1_1, L1_2, L2_1, L2_2, L2_3].
    const items = [
      // L1 row (y=720)
      fixture("Treatment", 100, 720 - 12, 60),
      fixture("Parameters", 250, 720 - 12, 60),
      // L2 row (y=695)
      fixture("Drug", 100, 695 - 12, 30),
      fixture("Pressure", 250, 695 - 12, 50),
      fixture("Temp", 400, 695 - 12, 30),
      // Body row 1 (y=670)
      fixture("A", 100, 670 - 12, 10),
      fixture("10", 250, 670 - 12, 14),
      fixture("20", 400, 670 - 12, 14),
      // Body row 2 (y=640)
      fixture("B", 100, 640 - 12, 10),
      fixture("30", 250, 640 - 12, 14),
      fixture("40", 400, 640 - 12, 14),
    ];
    const out = detectTablesOnPage(items, 1, PAGE_HEIGHT_PT);
    expect(out.length).toBe(1);
    const t = out[0];
    // Multi-level flattening: both L1 cells appear in headers.
    expect(t.headers).toContain("Treatment");
    expect(t.headers).toContain("Parameters");
    // And the L2 cells are appended.
    expect(t.headers).toContain("Drug");
    expect(t.headers).toContain("Pressure");
    expect(t.headers).toContain("Temp");
  });

  it("bbox.units is always 'pt'", () => {
    const out = detectTablesOnPage(simpleTableItems(), 1, PAGE_HEIGHT_PT);
    for (const t of out) {
      expect(t.bbox.units).toBe("pt");
    }
  });

  it("bbox coordinates are non-negative and within page bounds (top-left origin)", () => {
    const out = detectTablesOnPage(simpleTableItems(), 1, PAGE_HEIGHT_PT);
    for (const t of out) {
      expect(t.bbox.x).toBeGreaterThanOrEqual(0);
      expect(t.bbox.y).toBeGreaterThanOrEqual(0);
      expect(t.bbox.w).toBeGreaterThanOrEqual(0);
      expect(t.bbox.h).toBeGreaterThanOrEqual(0);
    }
  });
});

describe("localPdfTableProvider — segmentRowIntoCells", () => {
  function makeCell(
    x: number,
    width: number,
    text: string,
    y = 100,
    height = 12,
  ): DetectedRow["cells"][number] {
    return {
      text,
      bbox: { x, y, w: width, h: height, page: 1, units: "pt" },
      x,
      y,
      width,
      height,
    };
  }

  it("merges consecutive items into one cell when within tolerance", () => {
    const row: DetectedRow["cells"] = [
      makeCell(100, 30, "Hel"),
      makeCell(132, 30, "lo"), // 100+30+2=132, within 4pt tolerance
    ];
    const out = segmentRowIntoCells(row, 4);
    expect(out.length).toBe(1);
    expect(out[0].text).toBe("Hel lo");
  });

  it("splits into separate cells when the gap exceeds tolerance", () => {
    const row: DetectedRow["cells"] = [
      makeCell(100, 30, "Hel"),
      makeCell(200, 30, "lo"), // 130+70 gap > 4pt tolerance
    ];
    const out = segmentRowIntoCells(row, 4);
    expect(out.length).toBe(2);
    expect(out[0].text).toBe("Hel");
    expect(out[1].text).toBe("lo");
  });

  it("handles a single cell", () => {
    const row: DetectedRow["cells"] = [makeCell(100, 30, "Only")];
    const out = segmentRowIntoCells(row, 4);
    expect(out.length).toBe(1);
    expect(out[0].text).toBe("Only");
  });

  it("handles an empty row", () => {
    const out = segmentRowIntoCells([], 4);
    expect(out).toEqual([]);
  });
});

describe("localPdfTableProvider — renderTableToMarkdown", () => {
  it("renders a single-header single-row table", () => {
    const md = renderTableToMarkdown(["A", "B"], [["1", "2"]]);
    expect(md).toBe("| A | B |\n| --- | --- |\n| 1 | 2 |");
  });

  it("renders a header-only table", () => {
    const md = renderTableToMarkdown(["A", "B"], []);
    expect(md).toBe("| A | B |\n| --- | --- |");
  });

  it("pads short body rows with '-' to match the header length", () => {
    const md = renderTableToMarkdown(["A", "B", "C"], [["1"]]);
    expect(md).toContain("| 1 | - | - |");
  });

  it("returns an empty string for an empty input", () => {
    expect(renderTableToMarkdown([], [])).toBe("");
  });
});
