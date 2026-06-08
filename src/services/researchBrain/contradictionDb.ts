import { getServiceClient } from "../../db/client";
import type {
  BioprospectingFact,
  ResearchBioprospectingContradiction,
} from "./types";

const supabase = getServiceClient();

export type ContradictionInsert = {
  sourceId: string;
  sourceFactId: string;
  conflictingFactId: string;
  contradictionType: string;
  evidencePack: {
    source_a: { fact_id: string; source: string; value: string; provenance: string };
    source_b: { fact_id: string; source: string; value: string; provenance: string };
    conflict_summary: string;
  };
  ruleVersion?: string | null;
  llmVersion?: string | null;
};

export type ContradictionSearchResult = ResearchBioprospectingContradiction & {
  source?: { id: string; title: string; doi: string | null };
  source_fact?: BioprospectingFact;
  conflicting_fact?: BioprospectingFact;
};

/**
 * Upsert a single bioprospecting contradiction.
 * Skips insert if an identical contradiction already exists (same source_fact_id,
 * conflicting_fact_id, and contradiction_type).
 */
export async function upsertBioprospectingContradiction(
  params: ContradictionInsert,
): Promise<ResearchBioprospectingContradiction | null> {
  const { data: existing } = await supabase
    .from("research_bioprospecting_contradictions")
    .select("id")
    .eq("source_fact_id", params.sourceFactId)
    .eq("conflicting_fact_id", params.conflictingFactId)
    .eq("contradiction_type", params.contradictionType)
    .maybeSingle();

  if (existing) {
    return null;
  }

  const { data, error } = await supabase
    .from("research_bioprospecting_contradictions")
    .insert({
      source_id: params.sourceId,
      source_fact_id: params.sourceFactId,
      conflicting_fact_id: params.conflictingFactId,
      contradiction_type: params.contradictionType,
      evidence_pack: params.evidencePack,
      rule_version: params.ruleVersion ?? null,
      llm_version: params.llmVersion ?? null,
      resolution_status: "unresolved",
    })
    .select("*")
    .single();

  if (error) throw error;
  return data as ResearchBioprospectingContradiction;
}

/**
 * Search for contradictions where either the source_fact_id or conflicting_fact_id
 * appears in the provided factIds list.
 * Returns only unresolved contradictions by default.
 */
export async function searchBioprospectingContradictions(params: {
  factIds: string[];
  includeResolved?: boolean;
}): Promise<ResearchBioprospectingContradiction[]> {
  if (params.factIds.length === 0) return [];

  const factIds = params.factIds.join(",");
  let query = supabase
    .from("research_bioprospecting_contradictions")
    .select(
      "*, source:research_sources(*), source_fact:research_bioprospecting_facts(*), conflicting_fact:research_bioprospecting_facts(*)",
    )
    .or(
      `source_fact_id.in.(${factIds}),conflicting_fact_id.in.(${factIds})`,
    );

  if (!params.includeResolved) {
    query = query.eq("resolution_status", "unresolved");
  }

  const { data, error } = await query;
  if (error) throw error;
  return (data || []) as ResearchBioprospectingContradiction[];
}

/**
 * Resolve or dismiss a contradiction by updating its resolution status.
 */
export async function resolveBioprospectingContradiction(params: {
  contradictionId: string;
  resolutionStatus: "resolved" | "dismissed";
  resolvedBy?: string;
}): Promise<ResearchBioprospectingContradiction> {
  const { data, error } = await supabase
    .from("research_bioprospecting_contradictions")
    .update({
      resolution_status: params.resolutionStatus,
      resolved_by: params.resolvedBy || null,
      resolved_at: new Date().toISOString(),
    })
    .eq("id", params.contradictionId)
    .select("*")
    .single();

  if (error) throw error;
  return data as ResearchBioprospectingContradiction;
}

/**
 * Get all contradictions for a given source, optionally filtered by status.
 */
export async function getContradictionsForSource(params: {
  sourceId: string;
  status?: "unresolved" | "resolved" | "dismissed" | "all";
}): Promise<ResearchBioprospectingContradiction[]> {
  let query = supabase
    .from("research_bioprospecting_contradictions")
    .select(
      "*, source:research_sources(*), source_fact:research_bioprospecting_facts(*), conflicting_fact:research_bioprospecting_facts(*)",
    )
    .eq("source_id", params.sourceId);

  if (params.status && params.status !== "all") {
    query = query.eq("resolution_status", params.status);
  }

  const { data, error } = await query;
  if (error) throw error;
  return (data || []) as ResearchBioprospectingContradiction[];
}