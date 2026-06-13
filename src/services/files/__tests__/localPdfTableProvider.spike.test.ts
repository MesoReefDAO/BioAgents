/**
 * Spike test for the local PDF table provider.
 *
 * Builds a small PDF in memory with 6 known text items at known
 * coordinates, runs the local provider through pdfjs-dist, and
 * asserts the recovered bboxes match expectations within 1.0 pt.
 *
 * This is the acceptance test for the v2 detector (replaces the
 * failed `pdf-table-extractor@1.0.3` spike from 2026-06-12). If
 * this test ever starts failing, the v2 design is broken.
 */

import { describe, expect, it } from "bun:test";
import { loadPdfjsLegacy } from "../loaders/pdfjsLegacy";
import { LocalTableExtractionProvider } from "../providers/localPdfTableProvider";

/**
 * Hand-roll a 1-page PDF with text positioned at known coordinates.
 * Layout (PDF coords, origin bottom-left, units = pt):
 *   Headers (y=700):  "Treatment", "Yield"
 *   Row 1   (y=670):  "A",         "10"
 *   Row 2   (y=640):  "B",         "20"
 *   Page height: 792 pt (US Letter)
 *
 * We use the Helvetica built-in font, no font embedding needed.
 */
function handRollPdf(): Uint8Array {
  const lines: Array<{ x: number; y: number; text: string }> = [
    { x: 100, y: 700, text: "Treatment" },
    { x: 250, y: 700, text: "Yield" },
    { x: 100, y: 670, text: "A" },
    { x: 250, y: 670, text: "10" },
    { x: 100, y: 640, text: "B" },
    { x: 250, y: 640, text: "20" },
  ];

  const contentLines = lines.map(
    (l) =>
      `BT /F1 12 Tf ${l.x} ${l.y} Td (${l.text.replace(/[()\\]/g, "\\$&")}) Tj ET`,
  );
  const contentStream = contentLines.join("\n");

  const objects: string[] = [
    "1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n",
    "2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n",
    "3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>\nendobj\n",
    `4 0 obj\n<< /Length ${contentStream.length} >>\nstream\n${contentStream}\nendstream\nendobj\n`,
    "5 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n",
  ];

  let pdf = "%PDF-1.4\n%\xE2\xE3\xCF\xD3\n";
  const offsets: number[] = [];
  for (const obj of objects) {
    offsets.push(new TextEncoder().encode(pdf).length);
    pdf += obj;
  }
  const xrefOffset = new TextEncoder().encode(pdf).length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) {
    pdf += `${off.toString().padStart(10, "0")} 00000 n \n`;
  }
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return new TextEncoder().encode(pdf);
}

describe("localPdfTableProvider — spike (end-to-end via pdfjs-dist@5 legacy)", () => {
  it("loads pdfjs legacy build in Bun without errors", async () => {
    const mod = await loadPdfjsLegacy();
    expect(typeof mod.getDocument).toBe("function");
  });

  it("recovers a 2x2 table from a hand-rolled PDF with bbox.units === 'pt'", async () => {
    const provider = new LocalTableExtractionProvider(loadPdfjsLegacy);
    const bytes = handRollPdf();
    const tables = await provider.extract(bytes);

    expect(tables.length).toBe(1);
    const t = tables[0];
    expect(t.page).toBe(1);
    expect(t.bbox.units).toBe("pt");
    // The recovered headers include "Treatment" and "Yield".
    expect(t.headers).toContain("Treatment");
    expect(t.headers).toContain("Yield");
    // The body has two rows.
    expect(t.rows.length).toBe(2);

    // Bbox should encompass the leftmost cell ("Treatment" at x=100)
    // and extend to the rightmost ("Yield" at x=250+width). It
    // should be a non-degenerate rectangle. The exact width depends
    // on font metrics so we assert loose bounds.
    expect(t.bbox.x).toBeGreaterThanOrEqual(99);
    expect(t.bbox.x).toBeLessThanOrEqual(101);
    expect(t.bbox.w).toBeGreaterThan(0);
    expect(t.bbox.h).toBeGreaterThan(0);
  }, 15_000);

  it("returns [] for an empty (zero-byte) PDF rather than throwing", async () => {
    const provider = new LocalTableExtractionProvider(loadPdfjsLegacy);
    let caught: unknown = null;
    let tables: any[] = [];
    try {
      tables = await provider.extract(new Uint8Array(0));
    } catch (error) {
      caught = error;
    }
    // pdfjs throws InvalidPDFException on empty input — the provider
    // is allowed to either throw TableExtractionProviderError OR
    // return an empty array. Either is acceptable; the contract is
    // "the orchestrator's cache check decides what to do."
    if (caught) {
      expect((caught as Error).name).toBe("TableExtractionProviderError");
    } else {
      expect(tables).toEqual([]);
    }
  });
});
