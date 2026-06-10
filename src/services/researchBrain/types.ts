export type ResearchSourceKind =
  | "paper"
  | "dataset"
  | "external_result"
  | "artifact";

export type ResearchTrustTier = "internal" | "external";

export type ResearchClaimStatus =
  | "supported"
  | "partial"
  | "contradicted"
  | "hypothesis"
  | "open_question";

export type ResearchSource = {
  id: string;
  source_kind: ResearchSourceKind;
  trust_tier: ResearchTrustTier;
  source_scope: string;
  title: string;
  doi?: string | null;
  url?: string | null;
  file_path?: string | null;
  content_hash?: string | null;
  file_size?: number | null;
  last_modified_at?: string | null;
  extraction_status: string;
  extraction_error?: string | null;
  bioprospecting_status?: string;
  bioprospecting_error?: string | null;
  bioprospecting_fact_count?: number;
  bioprospecting_extracted_at?: string | null;
  metadata?: Record<string, unknown>;
  created_at?: string;
  updated_at?: string;
};

export type ResearchEvidenceChunk = {
  id: string;
  source_id: string;
  document_id?: string | null;
  content: string;
  section?: string | null;
  page?: number | null;
  chunk_index?: number | null;
  metadata?: Record<string, unknown>;
  created_at?: string;
};

export type ResearchClaim = {
  id: string;
  claim: string;
  claim_type: string;
  status: ResearchClaimStatus;
  confidence: string;
  source_id?: string | null;
  chunk_id?: string | null;
  doi?: string | null;
  trust_tier: ResearchTrustTier;
  metadata?: Record<string, unknown>;
  created_at?: string;
  updated_at?: string;
  source?: ResearchSource;
  chunk?: ResearchEvidenceChunk;
};

export type EvidencePackClaim = {
  id: string;
  claim: string;
  claimType: string;
  status: ResearchClaimStatus;
  confidence: string;
  trustTier: ResearchTrustTier;
  sourceId?: string | null;
  sourceTitle?: string | null;
  doi?: string | null;
  url?: string | null;
  doiUrl?: string | null;
  paperUrl?: string | null;
  evidenceUrl?: string | null;
  chunkId?: string | null;
  chunkIndex?: number | null;
  section?: string | null;
  page?: number | null;
  snippet?: string;
};

export type EvidencePackEntityCorrection = {
  correctedAt?: string | null;
  correctedBy?: string | null;
  fields: Record<string, { before?: string | null; after?: string | null }>;
};

export type EvidencePackBioprospectingFact = {
  id: string;
  status: ResearchClaimStatus;
  confidence: string;
  trustTier: ResearchTrustTier;
  reviewStatus:
    | "unreviewed"
    | "verified"
    | "needs_review"
    | "incorrect"
    | "quarantined";
  reviewNote?: string | null;
  reviewedBy?: string | null;
  reviewedAt?: string | null;
  lastEntityCorrection?: EvidencePackEntityCorrection | null;
  entityCorrectionHistory?: EvidencePackEntityCorrection[];
  matchType:
    | "direct_species"
    | "same_genus"
    | "genus_level"
    | "same_family"
    | "compound_or_activity"
    | "ecological_analogy"
    | "keyword_match";
  evidenceStrength: "direct" | "indirect" | "hypothesis" | "unknown";
  evidenceLabel: string;
  queryMatches: string[];
  speciesTaxonId?: string | null;
  genusTaxonId?: string | null;
  familyTaxonId?: string | null;
  sourceId?: string | null;
  sourceTitle?: string | null;
  doi?: string | null;
  url?: string | null;
  doiUrl?: string | null;
  paperUrl?: string | null;
  evidenceUrl?: string | null;
  chunkId?: string | null;
  chunkIndex?: number | null;
  page?: number | null;
  species?: string | null;
  genus?: string | null;
  family?: string | null;
  higherTaxon?: string | null;
  organismGroup?: string | null;
  geography?: string | null;
  ecosystem?: string | null;
  organismPart?: string | null;
  compound?: string | null;
  compoundClass?: string | null;
  moleculeType?: string | null;
  bioactivity?: string | null;
  applicationArea?: string | null;
  assayModel?: string | null;
  resultSummary?: string | null;
  measurementValue?: number | null;
  measurementUnit?: string | null;
  measurementDirection?: string | null;
  measurementMin?: number | null;
  measurementMax?: number | null;
  timepoint?: string | null;
  condition?: string | null;
  pValue?: number | null;
  sampleSize?: number | null;
  statisticalTest?: string | null;
  evidenceType?: string | null;
  relationType: string;
  quote?: string | null;
  snippet?: string;
};

export type EvidencePackSource = {
  id: string;
  title: string;
  trustTier: ResearchTrustTier;
  kind: ResearchSourceKind;
  doi?: string | null;
  url?: string | null;
  doiUrl?: string | null;
  paperUrl?: string | null;
};

export type BioprospectingQuestionType =
  | "species_exploration"
  | "molecule_exploration"
  | "activity_search"
  | "comparison"
  | "application_search"
  | "evidence_audit"
  | "quantitative_search"
  | "reef_context"
  | "unknown";

export type EvidencePackQueryPlan = {
  questionType: BioprospectingQuestionType;
  intentLabel: string;
  strategy: string;
  answerSections: string[];
  shouldUseExternalLiterature: boolean;
  cautions: string[];
};

export type EvidencePack = {
  question: string;
  queryPlan: EvidencePackQueryPlan;
  bioprospectingFacts: EvidencePackBioprospectingFact[];
  supportedClaims: EvidencePackClaim[];
  partialClaims: EvidencePackClaim[];
  contradictions: EvidencePackClaim[];
  openQuestions: EvidencePackClaim[];
  sources: EvidencePackSource[];
  contradictionWarnings: EvidencePackContradiction[];
};

export type ExtractedClaim = {
  claim: string;
  claimType?: string;
  status?: ResearchClaimStatus;
  confidence?: string;
  chunkIndex?: number;
  entities?: string[];
};

export type BioprospectingFact = {
  id: string;
  source_id?: string | null;
  chunk_id?: string | null;
  claim_id?: string | null;
  species_taxon_id?: string | null;
  genus_taxon_id?: string | null;
  family_taxon_id?: string | null;
  taxonomy_status?: "pending" | "normalized" | "skipped" | "failed";
  taxonomy_normalized_at?: string | null;
  taxonomy_error?: string | null;
  species?: string | null;
  genus?: string | null;
  family?: string | null;
  higher_taxon?: string | null;
  organism_group?: string | null;
  geography?: string | null;
  ecosystem?: string | null;
  organism_part?: string | null;
  compound?: string | null;
  compound_class?: string | null;
  molecule_type?: string | null;
  bioactivity?: string | null;
  application_area?: string | null;
  assay_model?: string | null;
  result_summary?: string | null;
  measurement_value?: number | string | null;
  measurement_unit?: string | null;
  measurement_direction?: string | null;
  measurement_min?: number | string | null;
  measurement_max?: number | string | null;
  timepoint?: string | null;
  condition?: string | null;
  p_value?: number | string | null;
  sample_size?: number | null;
  statistical_test?: string | null;
  evidence_type?: string | null;
  relation_type: string;
  status: ResearchClaimStatus;
  confidence: string;
  review_status?:
    | "unreviewed"
    | "verified"
    | "needs_review"
    | "incorrect"
    | "quarantined";
  review_note?: string | null;
  reviewed_by?: string | null;
  reviewed_at?: string | null;
  quote?: string | null;
  doi?: string | null;
  page?: number | null;
  metadata?: Record<string, unknown>;
  created_at?: string;
  updated_at?: string;
  /**
   * Database-generated identity key (5-tuple
   * species|compound|bioactivity|organism_part|geography, normalized).
   * Populated by `buildIdentityKey`/the `identity_key` GENERATED column.
   * Read-only; the source of truth is the database.
   */
  identity_key?: string | null;
  /**
   * Set on non-canonical rows: the id of the canonical fact that this
   * row was merged into. `null`/undefined for canonical and standalone
   * facts. Inverse of `research_bioprospecting_fact_edges.merged_fact_id`.
   */
  merged_into_fact_id?: string | null;
  source?: ResearchSource;
  chunk?: ResearchEvidenceChunk;
};

/**
 * Lineage edge between a canonical fact and a fact that was collapsed
 * into it by deduplication. Mirrors the schema of
 * `public.research_bioprospecting_fact_edges`.
 */
export type BioprospectingFactEdge = {
  canonical_fact_id: string;
  merged_fact_id: string;
  match_rule: "identity_key" | "embedding";
  merged_at: string;
};

export type ResearchTaxonRank = "species" | "genus" | "family" | "higher_taxon";

export type ResearchTaxon = {
  id: string;
  rank: ResearchTaxonRank;
  canonical_name: string;
  normalized_name: string;
  parent_id?: string | null;
  status: string;
  external_ids?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
  created_at?: string;
  updated_at?: string;
};

export type ResearchTaxonAlias = {
  id: string;
  taxon_id: string;
  alias: string;
  normalized_alias: string;
  source: string;
  metadata?: Record<string, unknown>;
  created_at?: string;
};

export type ExtractedBioprospectingFact = {
  species?: string;
  genus?: string;
  family?: string;
  higherTaxon?: string;
  organismGroup?: string;
  geography?: string;
  ecosystem?: string;
  organismPart?: string;
  compound?: string;
  compoundClass?: string;
  moleculeType?: string;
  bioactivity?: string;
  applicationArea?: string;
  assayModel?: string;
  resultSummary?: string;
  measurementValue?: number;
  measurementUnit?: string;
  measurementDirection?: string;
  measurementMin?: number;
  measurementMax?: number;
  timepoint?: string;
  condition?: string;
  pValue?: number;
  sampleSize?: number;
  statisticalTest?: string;
  evidenceType?: string;
  relationType?: string;
  status?: ResearchClaimStatus;
  confidence?: string;
  quote?: string;
  chunkIndex?: number;
  entities?: string[];
};

export type ResearchBioprospectingContradiction = {
  id: string;
  source_id: string;
  source_fact_id: string;
  conflicting_fact_id: string;
  contradiction_type: string;
  evidence_pack: {
    source_a: { fact_id: string; source: string; value: string; provenance: string };
    source_b: { fact_id: string; source: string; value: string; provenance: string };
    conflict_summary: string;
  };
  rule_version: string | null;
  llm_version: string | null;
  resolution_status: string;
  resolved_by: string | null;
  resolved_at: string | null;
  created_at: string;
  updated_at: string;
};

export type EvidencePackContradiction = {
  id: string;
  contradictionType: string;
  sourceA: {
    factId: string;
    claim: string;
    sourceTitle: string | null;
    doi: string | null;
    value: string;
    provenance: string;
  };
  sourceB: {
    factId: string;
    claim: string;
    sourceTitle: string | null;
    doi: string | null;
    value: string;
    provenance: string;
  };
  conflictSummary: string;
  resolutionStatus: "unresolved" | "resolved" | "dismissed";
};
