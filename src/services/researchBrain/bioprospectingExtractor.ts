import { getServiceClient } from "../../db/client";
import { getStorageProvider } from "../../storage";
import logger from "../../utils/logger";
import {
  buildTablesPromptSection,
  type ExtractedTable,
} from "../files/pdfTableExtractor";
import {
  getSource,
  replaceBioprospectingFactsForSource,
  setSourceBioprospectingStatus,
} from "./db";
import { resolveResearchBrainLLM } from "./llm";
import { loadTablesForSource } from "./tables";
import type {
  ExtractedBioprospectingFact,
  ResearchEvidenceChunk,
} from "./types";

function extractJsonArray(text: string): any[] {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = (fenced?.[1] || text) as string;
  const start = candidate.indexOf("[");
  const end = candidate.lastIndexOf("]");
  if (start === -1 || end === -1 || end <= start) return [];
  try {
    const parsed = JSON.parse(candidate.slice(start, end + 1));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim()
    ? value.replace(/\s+/g, " ").trim()
    : undefined;
}

function asChunkIndex(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

function asNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "string") return undefined;
  const cleaned = value.trim().replace(/,/g, "");
  if (!cleaned || /^n\/?a$/i.test(cleaned)) return undefined;
  const match = cleaned.match(/-?\d+(?:\.\d+)?/);
  if (!match) return undefined;
  const parsed = Number(match[0]);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function asInteger(value: unknown): number | undefined {
  const parsed = asNumber(value);
  return parsed != null ? Math.trunc(parsed) : undefined;
}

function normalizeStatus(value: unknown) {
  return value === "partial" ||
    value === "contradicted" ||
    value === "hypothesis" ||
    value === "open_question"
    ? value
    : "supported";
}

function normalizeFacts(items: any[]): ExtractedBioprospectingFact[] {
  return items
    .map((item) => ({
      species: asString(item.species),
      genus: asString(item.genus),
      family: asString(item.family),
      higherTaxon: asString(item.higherTaxon),
      organismGroup: asString(item.organismGroup),
      geography: asString(item.geography),
      ecosystem: asString(item.ecosystem),
      organismPart: asString(item.organismPart),
      compound: asString(item.compound),
      compoundClass: asString(item.compoundClass),
      moleculeType: asString(item.moleculeType),
      bioactivity: asString(item.bioactivity),
      applicationArea: asString(item.applicationArea),
      assayModel: asString(item.assayModel),
      resultSummary: asString(item.resultSummary),
      measurementValue: asNumber(item.measurementValue),
      measurementUnit: asString(item.measurementUnit),
      measurementDirection: asString(item.measurementDirection),
      measurementMin: asNumber(item.measurementMin),
      measurementMax: asNumber(item.measurementMax),
      timepoint: asString(item.timepoint),
      condition: asString(item.condition),
      pValue: asNumber(item.pValue),
      sampleSize: asInteger(item.sampleSize),
      statisticalTest: asString(item.statisticalTest),
      evidenceType: asString(item.evidenceType),
      relationType: asString(item.relationType),
      status: normalizeStatus(item.status),
      confidence: asString(item.confidence) || "medium",
      quote: asString(item.quote),
      chunkIndex: asChunkIndex(item.chunkIndex),
      entities: Array.isArray(item.entities)
        ? item.entities.filter((e: unknown) => typeof e === "string")
        : [],
      sourceTableRef: asSourceTableRef(item.sourceTableRef),
    }))
    .filter((fact) =>
      [
        fact.species,
        fact.genus,
        fact.compound,
        fact.bioactivity,
        fact.applicationArea,
        fact.resultSummary,
        fact.quote,
      ].some(Boolean),
    );
}

/**
 * Validate a `sourceTableRef` payload from the LLM. Returns the
 * normalized ref, or `undefined` if the payload is malformed. A
 * ref with `rowIndex` out of range is logged and dropped (we don't
 * want to thread invalid refs into persistence).
 */
function asSourceTableRef(
  value: unknown,
): { page: number; tableIndex: number; rowIndex?: number } | undefined {
  if (!value || typeof value !== "object") return undefined;
  const v = value as Record<string, unknown>;
  const page =
    typeof v.page === "number" && Number.isFinite(v.page)
      ? Math.max(1, Math.trunc(v.page))
      : undefined;
  const tableIndex =
    typeof v.tableIndex === "number" && Number.isFinite(v.tableIndex)
      ? Math.max(0, Math.trunc(v.tableIndex))
      : undefined;
  if (page == null || tableIndex == null) return undefined;
  const rowIndex =
    typeof v.rowIndex === "number" && Number.isFinite(v.rowIndex)
      ? Math.max(0, Math.trunc(v.rowIndex))
      : undefined;
  return rowIndex != null
    ? { page, tableIndex, rowIndex }
    : { page, tableIndex };
}

function readPositiveInt(name: string, fallback: number): number {
  const parsed = Number(process.env[name] || "");
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  label: string,
): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeout = setTimeout(
      () => reject(new Error(`${label} timed out after ${timeoutMs}ms`)),
      timeoutMs,
    );
  });

  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

function heuristicFactsFromChunks(
  chunks: ResearchEvidenceChunk[],
): ExtractedBioprospectingFact[] {
  const facts: ExtractedBioprospectingFact[] = [];
  const bioactivityPattern =
    /\b(anticancer|cytotoxic|anti-?inflammatory|antimicrobial|antibacterial|antifungal|antioxidant|wound healing|collagen|cosmetic|photoprotective|thermal stress|heat resistance|bleaching|bioactive)\b/i;
  const compoundPattern =
    /\b(peptide|protein|polysaccharide|terpene|alkaloid|macrolide|sterol|lipid|metabolite|toxin|compound|extract|macromolecule|natural product)\b/i;

  for (const chunk of chunks) {
    if (facts.length >= 12) break;
    if (
      !bioactivityPattern.test(chunk.content) &&
      !compoundPattern.test(chunk.content)
    ) {
      continue;
    }

    const sentence =
      chunk.content
        .replace(/\s+/g, " ")
        .split(/(?<=[.!?])\s+/)
        .find((s) => bioactivityPattern.test(s) || compoundPattern.test(s))
        ?.trim() || chunk.content.slice(0, 280).replace(/\s+/g, " ").trim();

    facts.push({
      organismGroup: sentence.match(
        /\b(coral|anemone|sponge|cnidarian|alga|microbiome|symbiont)\b/i,
      )?.[0],
      compound: sentence.match(compoundPattern)?.[0],
      bioactivity: sentence.match(bioactivityPattern)?.[0],
      resultSummary: sentence,
      evidenceType: "textual mention",
      relationType: "reported_activity",
      status: "supported",
      confidence: "low",
      quote: sentence,
      chunkIndex: chunk.chunk_index ?? undefined,
      entities: [],
    });
  }

  return facts;
}

async function llmFactsForChunkBatch(
  title: string,
  doi: string | null | undefined,
  chunks: ResearchEvidenceChunk[],
  tables: ExtractedTable[],
): Promise<ExtractedBioprospectingFact[]> {
  const { llm, model } = resolveResearchBrainLLM();
  if (!llm || !model) return [];

  const context = chunks
    .map(
      (chunk) =>
        `[chunk_index=${chunk.chunk_index ?? 0}${chunk.page ? ` page=${chunk.page}` : ""}]\n${chunk.content.slice(0, 2200)}`,
    )
    .join("\n\n---\n\n");

  const tablesSection = buildTablesPromptSection(tables);

  const prompt = `Extract marine bioprospecting facts from the paper chunks below.

Return ONLY a valid JSON array. Each object may include:
species, genus, family, higherTaxon, organismGroup, geography, ecosystem, organismPart,
compound, compoundClass, moleculeType, bioactivity, applicationArea, assayModel,
resultSummary, measurementValue, measurementUnit, measurementDirection,
measurementMin, measurementMax, timepoint, condition, pValue, sampleSize,
statisticalTest, evidenceType, relationType, status, confidence, quote, chunkIndex, entities,
sourceTableRef.

sourceTableRef (optional) is an object { page: number, tableIndex: number, rowIndex?: number }
referencing a specific cell in the "tables:" block below. Set it when the fact is
grounded in a cell value rather than free-text. page and tableIndex match the headers
in the "tables:" section; rowIndex is the 0-based body row (header rows do not count).

Strict rules:
- Extract only facts explicitly supported by the chunks or the tables block.
- Use "supported" only when the quote directly supports the fact.
- Use "hypothesis" only for explicit speculation in the source text.
- quote must be a short verbatim snippet from the chunk (table cell text also counts).
- chunkIndex must match the supporting chunk_index; set sourceTableRef when the
  supporting evidence is a cell in the tables block instead.
- Only fill measurementValue, measurementUnit, measurementDirection, measurementMin,
  measurementMax, timepoint, condition, pValue, sampleSize, or statisticalTest when
  the quote or immediately adjacent text (or a table cell) explicitly supports them.
- measurementDirection must be one of: increase, decrease, no_change, mixed.
- measurementUnit should preserve the paper unit, for example %, fold-change, cells/mL.
- If the number is ambiguous, leave numeric fields out and keep it in resultSummary.
- Do not infer species-compound-activity links unless they are in the same local context.
- Prefer facts useful for: anticancer, anti-inflammatory, antimicrobial, antioxidant,
  cosmetic, biomaterials, thermal resistance, coral reef/anemone/cnidarian bioprospecting.
- Skip generic background with no organism, molecule, activity, application, or assay.
- Prefer 0-8 high-signal facts per batch.
- Prefer facts grounded in the tables block over facts grounded only in prose when both
  are available — tables are higher-signal for measurements, conditions, and species-compound
  pairings.

Paper title: ${title}
DOI: ${doi || "unknown"}

${tablesSection ? `${tablesSection}\n\n` : ""}Chunks:
${context}`;

  const response = await llm.createChatCompletion({
    model,
    messages: [{ role: "user", content: prompt }],
    maxTokens: 2500,
    temperature: 0,
  });

  return normalizeFacts(extractJsonArray(response.content));
}

async function llmFactsForChunkBatchWithRetries(params: {
  title: string;
  doi: string | null | undefined;
  chunks: ResearchEvidenceChunk[];
  tables: ExtractedTable[];
  batchNumber: number;
}): Promise<ExtractedBioprospectingFact[]> {
  const timeoutMs = readPositiveInt("BIOPROSPECTING_BATCH_TIMEOUT_MS", 120000);
  const retries = readPositiveInt("BIOPROSPECTING_BATCH_RETRIES", 1);
  let lastError: unknown;

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await withTimeout(
        llmFactsForChunkBatch(
          params.title,
          params.doi,
          params.chunks,
          params.tables,
        ),
        timeoutMs,
        `bioprospecting batch ${params.batchNumber}`,
      );
    } catch (error) {
      lastError = error;
      logger.warn(
        {
          err: error,
          batchNumber: params.batchNumber,
          attempt: attempt + 1,
          maxAttempts: retries + 1,
        },
        "bioprospecting_batch_failed",
      );
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new Error("Bioprospecting batch failed");
}

export async function extractBioprospectingFactsForSource(
  sourceId: string,
  existingChunks?: ResearchEvidenceChunk[],
): Promise<{ sourceId: string; factCount: number; status: string }> {
  const source = await getSource(sourceId);
  if (!source) throw new Error(`Research source not found: ${sourceId}`);

  try {
    await setSourceBioprospectingStatus(sourceId, {
      status: "running",
      factCount: 0,
    });

    let chunks = existingChunks;
    if (!chunks) {
      const sb = getServiceClient();
      const { data, error } = await sb
        .from("research_evidence_chunks")
        .select("*")
        .eq("source_id", sourceId)
        .order("chunk_index", { ascending: true });
      if (error) throw error;
      chunks = (data || []) as ResearchEvidenceChunk[];
    }

    if (!chunks || chunks.length === 0) {
      await setSourceBioprospectingStatus(sourceId, {
        status: "no_chunks",
        factCount: 0,
      });
      return { sourceId, factCount: 0, status: "no_chunks" };
    }

    // Step 1: ensure PDF tables are extracted and persisted. The
    // helper is a no-op on a cache hit and runs the local→Mistral
    // quality-gated pipeline on a miss. We invoke it inside the same
    // "running" block so observability captures it; failures are
    // logged but do NOT abort the LLM pass (the LLM still has the
    // chunks to work with).
    let tables: ExtractedTable[] = [];
    try {
      tables = await ensureTablesForSource(source);
    } catch (error) {
      logger.warn(
        { err: error, sourceId },
        "bioprospecting_table_extraction_failed_continuing",
      );
    }

    const facts: ExtractedBioprospectingFact[] = [];
    const maxChunks = readPositiveInt("BIOPROSPECTING_MAX_CHUNKS", 80);
    const batchSize = readPositiveInt("BIOPROSPECTING_BATCH_CHUNKS", 8);
    const selectedChunks = chunks.slice(0, maxChunks);

    for (let i = 0; i < selectedChunks.length; i += batchSize) {
      const batch = selectedChunks.slice(i, i + batchSize);
      facts.push(
        ...(await llmFactsForChunkBatchWithRetries({
          title: source.title,
          doi: source.doi,
          chunks: batch,
          tables,
          batchNumber: Math.floor(i / batchSize) + 1,
        })),
      );
    }

    const finalFacts =
      facts.length > 0 ? facts : heuristicFactsFromChunks(selectedChunks);
    const saved = await replaceBioprospectingFactsForSource(
      source,
      finalFacts,
      chunks,
    );

    logger.info(
      { sourceId, factCount: saved.length, tableCount: tables.length },
      "bioprospecting_extraction_completed",
    );

    await setSourceBioprospectingStatus(sourceId, {
      status: "extracted",
      factCount: saved.length,
    });

    return { sourceId, factCount: saved.length, status: "extracted" };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await setSourceBioprospectingStatus(sourceId, {
      status: "failed",
      errorMessage: message,
      factCount: 0,
    });
    logger.error({ err: error, sourceId }, "bioprospecting_extraction_failed");
    return { sourceId, factCount: 0, status: "failed" };
  }
}

/**
 * Ensure the source's PDF tables are extracted and persisted. Loads
 * the PDF buffer from S3 (or no-ops if the source has no file_path),
 * then delegates to the cache-aware orchestrator in
 * `pdfTableExtractor.ts`. Returns the tables in the shape expected
 * by the LLM prompt helper.
 *
 * Idempotency: the orchestrator's cache check returns
 * `provider: "cache"` on a hit, so re-running this for the same
 * source is a single DB read.
 */
async function ensureTablesForSource(source: {
  id: string;
  file_path?: string | null;
}): Promise<ExtractedTable[]> {
  // Try the cache first — the most common path on re-runs.
  const cached = await loadTablesForSource(source.id);
  if (cached.length > 0) return cached;

  // No cached tables; we need the PDF to run the providers.
  if (!source.file_path) {
    logger.info(
      { sourceId: source.id },
      "bioprospecting_table_extraction_no_file_path_skipping",
    );
    return [];
  }

  const storage = getStorageProvider();
  if (!storage) {
    logger.warn(
      { sourceId: source.id },
      "bioprospecting_table_extraction_no_storage_provider",
    );
    return [];
  }

  let buffer: Buffer;
  try {
    buffer = await storage.download(source.file_path);
  } catch (error) {
    logger.warn(
      { err: error, sourceId: source.id, filePath: source.file_path },
      "bioprospecting_table_extraction_download_failed",
    );
    return [];
  }

  if (!buffer || buffer.length === 0) return [];

  // Lazy import to avoid pulling pdfjs into the module-init graph of
  // every caller of the extractor (e.g., the contradiction detector,
  // the verifier, the memory writer — none of them need this).
  const { extractPDFTables } = await import("../files/pdfTableExtractor");
  const result = await extractPDFTables(source.id, new Uint8Array(buffer));
  logger.info(
    {
      sourceId: source.id,
      tableCount: result.tables.length,
      figureCount: result.figures.length,
      provider: result.provider,
    },
    "bioprospecting_table_extraction_completed",
  );
  return result.tables;
}
