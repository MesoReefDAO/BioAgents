/**
 * Mistral OCR table extraction provider.
 *
 * Pure `fetch` HTTP client for the Mistral OCR endpoint. Activated by
 * the orchestrator when the local provider's output fails the quality
 * gate, OR when the `TABLE_EXTRACTION_PROVIDER=mistral` env var is set.
 *
 * Endpoint:
 *   POST https://api.mistral.ai/v1/ocr
 *   Authorization: Bearer ${MISTRAL_API_KEY}
 *   Content-Type: application/json
 *
 * Request:
 *   { model: "mistral-ocr-latest", document: { type: "document_url",
 *     document_url: "<data:application/pdf;base64,...>" },
 *     include_image_base64: false }
 *
 * Response (paraphrased):
 *   { pages: [{ index, markdown, tables?: [...], images?: [{ bbox, caption }] }] }
 *
 * Strategy:
 *   - If Mistral returns structured `pages[i].tables`, use them and
 *     derive a markdown mirror via `renderTableToMarkdown`.
 *   - If Mistral only returns `pages[i].markdown`, store the markdown
 *     and return best-effort empty rows. The orchestrator's
 *     `buildTablesPromptSection` will use the markdown directly.
 *   - Bbox is in pixels relative to Mistral's OCR rasterization
 *     resolution. We divide by `DPI/72` to convert to PDF points.
 *   - Per-row confidence defaults to 0.5 when Mistral does not
 *     provide a per-block confidence (per the spec).
 */

import type {
  BBox,
  ExtractedFigure,
  ExtractedTable,
  TableExtractionProvider,
} from "../pdfTableExtractor";
import { TableExtractionProviderError } from "../pdfTableExtractor";
import { renderTableToMarkdown } from "./localPdfTableProvider";

const MISTRAL_OCR_URL = "https://api.mistral.ai/v1/ocr";
const MISTRAL_MODEL = "mistral-ocr-latest";

/**
 * Default Mistral OCR rasterization DPI. Mistral's docs do not pin
 * a single value; 200 DPI is the typical default and matches what
 * their playground uses for table bbox output.
 */
const MISTRAL_DEFAULT_DPI = 200;
const PDFJS_PT_PER_INCH = 72;
const DEFAULT_PIXEL_TO_PT = PDFJS_PT_PER_INCH / MISTRAL_DEFAULT_DPI;

type MistralResponsePage = {
  index?: number;
  markdown?: string;
  tables?: Array<{
    headers?: string[];
    rows?: string[][];
    bbox?: { x: number; y: number; w: number; h: number };
    confidence?: number;
  }>;
  images?: Array<{
    bbox?: { x: number; y: number; w: number; h: number };
    caption?: string;
  }>;
};

type MistralResponse = {
  pages?: MistralResponsePage[];
};

export class MistralTableExtractionProvider implements TableExtractionProvider {
  readonly name = "mistral" as const;

  private readonly apiKey: string | null;
  private readonly dpi: number;

  constructor(opts?: { apiKey?: string; dpi?: number }) {
    this.apiKey = opts?.apiKey ?? process.env.MISTRAL_API_KEY ?? null;
    this.dpi =
      opts?.dpi ?? readPositiveInt("MISTRAL_OCR_DPI", MISTRAL_DEFAULT_DPI);
  }

  async extract(pdf: Uint8Array): Promise<ExtractedTable[]> {
    const response = await this.callOcr(pdf);
    const pixelToPt = PDFJS_PT_PER_INCH / this.dpi;
    const tables: ExtractedTable[] = [];

    const pages = response.pages || [];
    for (const page of pages) {
      const pageNum = (page.index ?? 0) + 1; // Mistral is 0-indexed
      const pageTables = page.tables || [];

      if (pageTables.length === 0) {
        // Markdown-only fallback: emit a single best-effort table
        // carrying the page markdown. Rows are empty; the LLM will
        // use the markdown directly via the prompt builder.
        if (page.markdown) {
          const bbox = pageBboxFromMarkdown(page, pixelToPt, pageNum);
          tables.push({
            page: pageNum,
            tableIndex: 0,
            headers: [],
            rows: [],
            bbox,
            confidence: 0.5,
            markdown: page.markdown,
          });
        }
        continue;
      }

      for (let i = 0; i < pageTables.length; i++) {
        const pt = pageTables[i];
        const headers = Array.isArray(pt.headers) ? pt.headers : [];
        const rows = Array.isArray(pt.rows)
          ? pt.rows.map((r) =>
              Array.isArray(r)
                ? r.map((c) => (typeof c === "string" ? c : String(c ?? "")))
                : [],
            )
          : [];
        const bbox: BBox = pt.bbox
          ? {
              x: pt.bbox.x * pixelToPt,
              y: pt.bbox.y * pixelToPt,
              w: pt.bbox.w * pixelToPt,
              h: pt.bbox.h * pixelToPt,
              page: pageNum,
              units: "pt",
            }
          : { x: 0, y: 0, w: 0, h: 0, page: pageNum, units: "pt" };
        const confidence =
          typeof pt.confidence === "number"
            ? Math.max(0, Math.min(1, pt.confidence))
            : 0.5;
        const markdown = page.markdown ?? renderTableToMarkdown(headers, rows);
        tables.push({
          page: pageNum,
          tableIndex: i,
          headers,
          rows,
          bbox,
          confidence,
          markdown,
        });
      }
    }

    return tables;
  }

  async extractFigures(pdf: Uint8Array): Promise<ExtractedFigure[]> {
    const response = await this.callOcr(pdf);
    const pixelToPt = PDFJS_PT_PER_INCH / this.dpi;
    const out: ExtractedFigure[] = [];
    const pages = response.pages || [];
    for (const page of pages) {
      const pageNum = (page.index ?? 0) + 1;
      const images = page.images || [];
      for (let i = 0; i < images.length; i++) {
        const img = images[i];
        if (!img.bbox) continue;
        out.push({
          page: pageNum,
          figureIndex: i,
          bbox: {
            x: img.bbox.x * pixelToPt,
            y: img.bbox.y * pixelToPt,
            w: img.bbox.w * pixelToPt,
            h: img.bbox.h * pixelToPt,
            page: pageNum,
            units: "pt",
          },
          caption: img.caption ?? null,
        });
      }
    }
    return out;
  }

  private async callOcr(pdf: Uint8Array): Promise<MistralResponse> {
    if (!this.apiKey) {
      throw new TableExtractionProviderError(
        "MISTRAL_API_KEY is not set; cannot call Mistral OCR",
      );
    }

    const base64 = bytesToBase64(pdf);
    const documentUrl = `data:application/pdf;base64,${base64}`;

    let response: Response;
    try {
      response = await fetch(MISTRAL_OCR_URL, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: MISTRAL_MODEL,
          document: {
            type: "document_url",
            document_url: documentUrl,
          },
          include_image_base64: false,
        }),
      });
    } catch (error) {
      throw new TableExtractionProviderError(
        `Mistral OCR request failed: ${(error as Error).message ?? String(error)}`,
        error,
      );
    }

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new TableExtractionProviderError(
        `Mistral OCR returned ${response.status}: ${text.slice(0, 500)}`,
      );
    }

    try {
      return (await response.json()) as MistralResponse;
    } catch (error) {
      throw new TableExtractionProviderError(
        `Mistral OCR returned non-JSON body: ${(error as Error).message ?? String(error)}`,
        error,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function pageBboxFromMarkdown(
  page: MistralResponsePage,
  pixelToPt: number,
  pageNum: number,
): BBox {
  // Mistral markdown-only pages don't carry a bbox; default to a
  // full-page bbox so the viewer at least knows which page to show.
  if (page.images?.[0]?.bbox) {
    const b = page.images[0].bbox;
    return {
      x: b.x * pixelToPt,
      y: b.y * pixelToPt,
      w: b.w * pixelToPt,
      h: b.h * pixelToPt,
      page: pageNum,
      units: "pt",
    };
  }
  return { x: 0, y: 0, w: 0, h: 0, page: pageNum, units: "pt" };
}

function readPositiveInt(name: string, fallback: number): number {
  const parsed = Number(process.env[name] || "");
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function bytesToBase64(bytes: Uint8Array): string {
  // Use Bun's fast base64 encoder when available; fallback to
  // the manual decoder for other runtimes.
  if (typeof Buffer !== "undefined") {
    return Buffer.from(bytes).toString("base64");
  }
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  // @ts-ignore - btoa is available in browsers; not in Node
  if (typeof btoa === "function") return btoa(binary);
  // Fallback manual encoder
  const chars =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  let out = "";
  let i = 0;
  for (; i + 2 < bytes.length; i += 3) {
    const a = bytes[i];
    const b = bytes[i + 1];
    const c = bytes[i + 2];
    out += chars[a >> 2];
    out += chars[((a & 3) << 4) | (b >> 4)];
    out += chars[((b & 15) << 2) | (c >> 6)];
    out += chars[c & 63];
  }
  if (i < bytes.length) {
    const a = bytes[i];
    const b = i + 1 < bytes.length ? bytes[i + 1] : 0;
    out += chars[a >> 2];
    out += chars[((a & 3) << 4) | (b >> 4)];
    out += i + 1 < bytes.length ? chars[(b & 15) << 2] : "=";
    out += "=";
  }
  return out;
}
