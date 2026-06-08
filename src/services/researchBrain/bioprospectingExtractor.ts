import { getServiceClient } from "../../db/client";
import logger from "../../utils/logger";
import {
  getSource,
  replaceBioprospectingFactsForSource,
  setSourceBioprospectingStatus,
} from "./db";
import { resolveResearchBrainLLM } from "./llm";
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
): Promise<ExtractedBioprospectingFact[]> {
  const { llm, model } = resolveResearchBrainLLM();
  if (!llm || !model) return [];

  const context = chunks
    .map(
      (chunk) =>
        `[chunk_index=${chunk.chunk_index ?? 0}${chunk.page ? ` page=${chunk.page}` : ""}]\n${chunk.content.slice(0, 2200)}`,
    )
    .join("\n\n---\n\n");

  const prompt = `Extract marine bioprospecting facts from the paper chunks below.

Return ONLY a valid JSON array. Each object may include:
species, genus, family, higherTaxon, organismGroup, geography, ecosystem, organismPart,
compound, compoundClass, moleculeType, bioactivity, applicationArea, assayModel,
resultSummary, measurementValue, measurementUnit, measurementDirection,
measurementMin, measurementMax, timepoint, condition, pValue, sampleSize,
statisticalTest, evidenceType, relationType, status, confidence, quote, chunkIndex, entities.

Strict rules:
- Extract only facts explicitly supported by the chunks.
- Use "supported" only when the quote directly supports the fact.
- Use "hypothesis" only for explicit speculation in the source text.
- quote must be a short verbatim snippet from the chunk.
- chunkIndex must match the supporting chunk_index.
- Only fill measurementValue, measurementUnit, measurementDirection, measurementMin,
  measurementMax, timepoint, condition, pValue, sampleSize, or statisticalTest when
  the quote or immediately adjacent text explicitly supports them.
- measurementDirection must be one of: increase, decrease, no_change, mixed.
- measurementUnit should preserve the paper unit, for example %, fold-change, cells/mL.
- If the number is ambiguous, leave numeric fields out and keep it in resultSummary.
- Do not infer species-compound-activity links unless they are in the same local context.
- Prefer facts useful for: anticancer, anti-inflammatory, antimicrobial, antioxidant,
  cosmetic, biomaterials, thermal resistance, coral reef/anemone/cnidarian bioprospecting.
- Skip generic background with no organism, molecule, activity, application, or assay.
- Prefer 0-8 high-signal facts per batch.

Paper title: ${title}
DOI: ${doi || "unknown"}

Chunks:
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
  batchNumber: number;
}): Promise<ExtractedBioprospectingFact[]> {
  const timeoutMs = readPositiveInt("BIOPROSPECTING_BATCH_TIMEOUT_MS", 120000);
  const retries = readPositiveInt("BIOPROSPECTING_BATCH_RETRIES", 1);
  let lastError: unknown;

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await withTimeout(
        llmFactsForChunkBatch(params.title, params.doi, params.chunks),
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
      { sourceId, factCount: saved.length },
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
