import { getServiceClient } from "../../db/client";
import logger from "../../utils/logger";
import type {
  BioprospectingFact,
  CompoundAuthorityAuditEvent,
  CompoundStatus,
  ExtractedBioprospectingFact,
  ResearchCompound,
  ResearchCompoundAlias,
} from "./types";

/**
 * Compound authority service module. Mirrors the structural template
 * of `taxonomy.ts` (status enum + alias table + JSONB audit pattern)
 * adapted for chemistry: a `research_compounds` canonical table, a
 * `research_compound_aliases` alias table, a `compound_authority_audit`
 * edge table, and a `CompoundStatus` lifecycle.
 *
 * PR #1 ships the synchronous (extract-time) resolution path:
 *   - `looksLikeExtract`          — pure regex predicate
 *   - `normalizeForCompoundLookup` — NFKD + diacritic + lowercase
 *   - `resolveInitialStatus`       — extract-time resolver (no IO)
 *   - `attachCompoundAuthority`   — stamp the in-memory fact
 *   - `loadAliasMap`               — one-shot alias map loader
 *   - `attachCanonicalToFact`      — transactional write + audit
 *   - `searchCompoundsByName`     — case-insensitive search
 *   - `getCanonicalById`           — get canonical + aliases
 *   - `addAlias`                   — manual alias add
 *   - `promoteFactToPending`       — admin re-promote
 *
 * PR #2 adds the async backfill path: PubChem client, rate gate,
 * retry counter, and the `normalizeBioprospectingCompounds` driver.
 */

const supabase = new Proxy({} as ReturnType<typeof getServiceClient>, {
  get(_target, prop) {
    const client = getServiceClient() as unknown as Record<
      string | symbol,
      unknown
    >;
    const value = client[prop];
    return typeof value === "function" ? value.bind(client) : value;
  },
}) as ReturnType<typeof getServiceClient>;

/**
 * Reasons passed to `attachCanonicalToFact` and recorded in
 * `compound_authority_audit.reason`. Kept as a typed const tuple so
 * tests + the API layer can reference them by name.
 */
export const COMPOUND_AUTHORITY_REASONS = {
  pubchemResolved: "pubchem_resolved",
  pubchemMiss: "pubchem_miss",
  extractDetected: "extract_detected",
  adminPromote: "admin_promote",
  adminAliasAdded: "admin_alias_added",
  compoundTextChanged: "compound_text_changed",
} as const;

export type CompoundAuthorityReason =
  (typeof COMPOUND_AUTHORITY_REASONS)[keyof typeof COMPOUND_AUTHORITY_REASONS];

/**
 * In-memory shape used by the synchronous extract-time path. The
 * extractor stamps these four fields on every fact before persistence.
 * `compound_canonical_id` is `string | null` (not `undefined`) to make
 * the JSON column on the fact row explicit.
 */
export type CompoundAuthorityStamp = {
  compound_canonical_id: string | null;
  compound_authority_status: CompoundStatus;
  compound_authority_at: string | null;
  compound_authority_error: string | null;
};

const EMPTY_STAMP: CompoundAuthorityStamp = {
  compound_canonical_id: null,
  compound_authority_status: "pending",
  compound_authority_at: null,
  compound_authority_error: null,
};

// ---------------------------------------------------------------------------
// looksLikeExtract — pure regex predicate
// ---------------------------------------------------------------------------

/**
 * Lexical cues that mark a compound value as an extract / mixture
 * (and therefore ineligible for canonical resolution). Mirrors the
 * spec's required cue set:
 *   extract, oil, fraction, tincture, juice, powder, infusion,
 *   decoction, TME, essential oil, resin, formulation, preparation,
 *   solution, suspension, emulsion, blend, mixture, combination
 *
 * The match is case-insensitive and word-boundary-aware. Multi-word
 * cues (e.g. "essential oil") are matched as a phrase. "TME" is an
 * acronym for "Tumour-Mimetic Extract" (a class of bioprospecting
 * fractions); matched as a word.
 *
 * Pure function: no IO, no LLM, no PubChem. Safe to call inline on
 * every fact in every batch.
 */
export function looksLikeExtract(value: string | null | undefined): boolean {
  if (!value) return false;
  if (typeof value !== "string") return false;
  // Multi-word phrases first (longest match wins implicitly because
  // alternation in JS regex tries left-to-right).
  const pattern =
    /\b(?:extract|essential\s+oil|oil|fraction|tincture|juice|powder|infusion|decoction|TME|resin|formulation|preparation|solution|suspension|emulsion|blend|mixture|combination)\b/i;
  return pattern.test(value);
}

// ---------------------------------------------------------------------------
// normalizeForCompoundLookup — canonicalization for matching
// ---------------------------------------------------------------------------

/**
 * Canonicalize a compound name for matching against the alias table
 * and the canonical `normalized_name` column. Pipeline:
 *   1. NFKD decompose
 *   2. Strip diacritics
 *   3. Collapse non-alphanumeric runs to a single space
 *   4. Lowercase
 *   5. Trim + collapse whitespace
 *
 * Examples:
 *   normalizeForCompoundLookup("Curcumín")     -> "curcumin"
 *   normalizeForCompoundLookup("  EPA  ")      -> "epa"
 *   normalizeForCompoundLookup("quercetin-3-O-glucoside") -> "quercetin 3 o glucoside"
 */
export function normalizeForCompoundLookup(value: string | null | undefined): string {
  if (!value) return "";
  return value
    .normalize("NFKD")
    .replace(/\p{Diacritic}/gu, "")
    .replace(/[^a-zA-Z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

// ---------------------------------------------------------------------------
// resolveInitialStatus — extract-time resolution
// ---------------------------------------------------------------------------

/**
 * Resolve a freshly-extracted compound value to a canonical id and a
 * status. The contract:
 *   1. `looksLikeExtract(value)` true  -> `{ canonicalId: null, status: 'skipped', at: null, error: 'extract_or_mixture' }`
 *   2. aliasMap hit                    -> `{ canonicalId: <id>, status: 'verified', at: <now ISO>, error: null }`
 *   3. otherwise                       -> `{ canonicalId: null, status: 'pending', at: null, error: null }`
 *
 * No PubChem call. No SQL — the alias map is preloaded once per
 * source by the extractor. Safe to call inline on every fact in
 * every batch.
 */
export function resolveInitialStatus(
  value: string | null | undefined,
  aliasMap: Map<string, string>,
): {
  canonicalId: string | null;
  status: CompoundStatus;
  at: string | null;
  error: string | null;
} {
  if (!value || typeof value !== "string") {
    return {
      canonicalId: null,
      status: "pending",
      at: null,
      error: null,
    };
  }
  if (looksLikeExtract(value)) {
    return {
      canonicalId: null,
      status: "skipped",
      at: new Date().toISOString(),
      error: "extract_or_mixture",
    };
  }
  const normalized = normalizeForCompoundLookup(value);
  if (!normalized) {
    return {
      canonicalId: null,
      status: "pending",
      at: null,
      error: null,
    };
  }
  const canonicalId = aliasMap.get(normalized);
  if (canonicalId) {
    return {
      canonicalId,
      status: "verified",
      at: new Date().toISOString(),
      error: null,
    };
  }
  return {
    canonicalId: null,
    status: "pending",
    at: null,
    error: null,
  };
}

// ---------------------------------------------------------------------------
// loadAliasMap — one-shot alias map loader (per source)
// ---------------------------------------------------------------------------

/**
 * Load the full alias -> compound_id map for in-process lookups.
 * One SQL query (SELECT normalized_alias, compound_id) covers both
 * the alias table and the canonical `normalized_name` column so a
 * freshly-inserted canonical row is also findable.
 *
 * Returns an empty map on read error (caller logs and continues with
 * all facts falling through to `pending`).
 */
export async function loadAliasMap(): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  const [{ data: aliasRows, error: aliasError }, { data: compoundRows, error: compoundError }] =
    await Promise.all([
      supabase
        .from("research_compound_aliases")
        .select("normalized_alias, compound_id"),
      supabase
        .from("research_compounds")
        .select("normalized_name, id"),
    ]);
  if (aliasError) {
    logger.warn({ err: aliasError }, "compound_authority_alias_map_failed");
  }
  if (compoundError) {
    logger.warn({ err: compoundError }, "compound_authority_canonical_map_failed");
  }
  for (const row of (compoundRows || []) as Array<{
    normalized_name: string;
    id: string;
  }>) {
    if (row.normalized_name && row.id) {
      // Canonical names win on collision (seeded curated rows are
      // more authoritative than the same string appearing as an
      // alias of a different canonical). We process canonicals
      // BEFORE aliases to enforce this deterministically.
      map.set(row.normalized_name, row.id);
    }
  }
  for (const row of (aliasRows || []) as Array<{
    normalized_alias: string;
    compound_id: string;
  }>) {
    if (row.normalized_alias && row.compound_id) {
      // Only set if the map does not already have a canonical entry
      // for this key. This preserves the canonical-wins-on-collision
      // rule above.
      if (!map.has(row.normalized_alias)) {
        map.set(row.normalized_alias, row.compound_id);
      }
    }
  }
  return map;
}

// ---------------------------------------------------------------------------
// attachCompoundAuthority — stamp the in-memory fact
// ---------------------------------------------------------------------------

/**
 * Stamp the 4 authority fields on the in-memory fact (plus the
 * `compound_authority_attempts` counter, default 0). Called from
 * `bioprospectingExtractor` between `normalizeFacts` and
 * `replaceBioprospectingFactsForSource`.
 *
 * The DB write happens later, in `replaceBioprospectingFactsForSource`,
 * which reads these 4 fields from the fact object and writes them
 * to the persisted row.
 *
 * Idempotent on `'verified'` facts: a second call does not re-resolve
 * and does not clobber a verified state. The intent is "calling twice
 * on the same fact MUST NOT clobber a verified status with a
 * pending re-resolution" (spec scenario in the
 * research-bioprospecting delta).
 *
 * Defensive: a bad input (e.g. non-string `compound`) does NOT
 * abort the batch. The fact is stamped `'pending'` and the error
 * is logged with the fact id.
 */
export function attachCompoundAuthority(
  fact: ExtractedBioprospectingFact,
  aliasMap: Map<string, string>,
): ExtractedBioprospectingFact & {
  compound_canonical_id: string | null;
  compound_authority_status: CompoundStatus;
  compound_authority_at: string | null;
  compound_authority_error: string | null;
  compound_authority_attempts: number;
} {
  // Preserve a previously-stamped verified state. A re-call on the
  // same fact (e.g. if the extractor's pre-pass calls it twice) is a
  // no-op.
  if (fact.compound_authority_status === "verified") {
    return {
      ...fact,
      compound_canonical_id: fact.compound_canonical_id ?? null,
      compound_authority_status: "verified",
      compound_authority_at: fact.compound_authority_at ?? null,
      compound_authority_error: fact.compound_authority_error ?? null,
      compound_authority_attempts: fact.compound_authority_attempts ?? 0,
    };
  }

  try {
    const resolved = resolveInitialStatus(fact.compound, aliasMap);
    return {
      ...fact,
      compound_canonical_id: resolved.canonicalId,
      compound_authority_status: resolved.status,
      compound_authority_at: resolved.at,
      compound_authority_error: resolved.error,
      compound_authority_attempts: fact.compound_authority_attempts ?? 0,
    };
  } catch (error) {
    logger.warn(
      { err: error, compound: fact.compound },
      "compound_authority_attach_failed_falling_back_to_pending",
    );
    return {
      ...fact,
      compound_canonical_id: null,
      compound_authority_status: "pending",
      compound_authority_at: null,
      compound_authority_error: null,
      compound_authority_attempts: fact.compound_authority_attempts ?? 0,
    };
  }
}

// ---------------------------------------------------------------------------
// attachCanonicalToFact — transactional status write + audit row
// ---------------------------------------------------------------------------

export type AttachCanonicalParams = {
  factId: string;
  canonicalId: string | null;
  status: CompoundStatus;
  error?: string | null;
  userId?: string | null;
  reason: CompoundAuthorityReason;
  attempts?: number;
};

/**
 * Transactional write of authority state on a fact + matching
 * `compound_authority_audit` row. Mirrors the spec contract:
 *   - updates `compound_canonical_id`, `compound_authority_status`,
 *     `compound_authority_at = NOW()`, `compound_authority_error`
 *     (and `compound_authority_attempts` when `attempts` is passed)
 *   - inserts a `status_change` audit row with
 *     `old_value` = previous authority state of the fact
 *     `new_value` = new state
 *     `user_id` = caller (or NULL for system/worker)
 *     `reason` = caller-supplied
 *   - idempotent on identical state: if `old_value` and `new_value`
 *     are structurally equal, the function still updates the row
 *     (the caller is responsible for not re-issuing) and writes
 *     exactly one audit row
 *
 * The function is intentionally NOT wrapped in a Supabase RPC
 * transaction (the project's Supabase client is postgREST, not the
 * server-side driver). Instead, the update is issued first; on
 * success, the audit insert is issued. If the audit insert throws,
 * the update is rolled back by issuing a compensating update that
 * restores the pre-call state. This mirrors the existing pattern in
 * `taxonomy.ts` and is acceptable because the audit table is the
 * only side effect — there is no cross-row invariant to preserve.
 *
 * Defensive: if the rollback itself throws, the error is logged and
 * re-thrown (the caller decides whether to swallow).
 */
export async function attachCanonicalToFact(
  params: AttachCanonicalParams,
): Promise<void> {
  const {
    factId,
    canonicalId,
    status,
    error: errorMessage = null,
    userId = null,
    reason,
    attempts,
  } = params;

  // 1) Read the previous state (for the audit old_value).
  const { data: previous, error: readError } = await supabase
    .from("research_bioprospecting_facts")
    .select(
      "compound_canonical_id, compound_authority_status, compound_authority_error",
    )
    .eq("id", factId)
    .maybeSingle();
  if (readError) {
    logger.error(
      { err: readError, factId },
      "compound_authority_attach_read_failed",
    );
    throw readError;
  }
  const previousRow = (previous || {}) as {
    compound_canonical_id?: string | null;
    compound_authority_status?: CompoundStatus | null;
    compound_authority_error?: string | null;
  };
  const oldValue = {
    compound_canonical_id: previousRow.compound_canonical_id ?? null,
    compound_authority_status:
      previousRow.compound_authority_status ?? "pending",
    compound_authority_error: previousRow.compound_authority_error ?? null,
  };
  const newValue = {
    compound_canonical_id: canonicalId,
    compound_authority_status: status,
    compound_authority_error: errorMessage,
  };

  // 2) Update the fact row.
  const updatePayload: Record<string, unknown> = {
    compound_canonical_id: canonicalId,
    compound_authority_status: status,
    compound_authority_at: new Date().toISOString(),
    compound_authority_error: errorMessage,
  };
  if (typeof attempts === "number") {
    updatePayload.compound_authority_attempts = attempts;
  }
  const { error: updateError } = await supabase
    .from("research_bioprospecting_facts")
    .update(updatePayload)
    .eq("id", factId);
  if (updateError) {
    logger.error(
      { err: updateError, factId, status },
      "compound_authority_attach_update_failed",
    );
    throw updateError;
  }

  // 3) Insert the audit row. If this throws, compensate by
  //    restoring the previous state.
  const auditPayload = {
    fact_id: factId,
    event_type: "status_change" as const,
    old_value: oldValue,
    new_value: newValue,
    user_id: userId,
    reason,
  };
  const { error: insertError } = await supabase
    .from("compound_authority_audit")
    .insert(auditPayload);
  if (insertError) {
    logger.error(
      { err: insertError, factId, reason },
      "compound_authority_audit_insert_failed_rolling_back",
    );
    // Compensating update: restore the previous state. If THIS
    // also throws, re-throw the audit error so the caller sees
    // the root cause.
    const { error: rollbackError } = await supabase
      .from("research_bioprospecting_facts")
      .update({
        compound_canonical_id: oldValue.compound_canonical_id,
        compound_authority_status: oldValue.compound_authority_status,
        compound_authority_error: oldValue.compound_authority_error,
        // NOTE: we do NOT restore compound_authority_at. The spec
        // treats `at` as the timestamp of the last authority
        // action; on a rollback, the prior update is "undone" but
        // the timestamp of the failed attempt is useful audit
        // signal.
      })
      .eq("id", factId);
    if (rollbackError) {
      logger.error(
        { err: rollbackError, factId },
        "compound_authority_rollback_failed",
      );
    }
    throw insertError;
  }
}

// ---------------------------------------------------------------------------
// searchCompoundsByName — case-insensitive search
// ---------------------------------------------------------------------------

/**
 * Case-insensitive name search across canonical + alias names. Rank
 * order:
 *   1. exact-normalized canonical match
 *   2. alias hit
 *   3. canonical prefix
 *   4. canonical substring
 * Ties break by canonical_name ASC.
 *
 * Read-only. Default limit 25, max 100. Implemented as a single
 * `or(...)` query that returns candidates; the in-process ranking
 * applies the spec's tie-breakers. For ~10k rows the per-call cost
 * is dominated by the network round-trip, not the sort.
 */
export async function searchCompoundsByName(
  query: string,
  limit: number = 25,
): Promise<ResearchCompound[]> {
  const safeLimit = Math.max(1, Math.min(100, Math.trunc(limit) || 25));
  const trimmed = (query || "").trim();
  if (!trimmed) return [];

  const escaped = trimmed.replace(/[%_]/g, (match) => `\\${match}`);

  // Fetch a wide candidate set; we re-rank in-process.
  const { data, error } = await supabase
    .from("research_compounds")
    .select("*")
    .or(
      `canonical_name.ilike.%${escaped}%,inchi_key.ilike.%${escaped}%`,
    )
    .order("canonical_name", { ascending: true })
    .limit(safeLimit * 4);
  if (error) throw error;

  const canonicals = ((data || []) as ResearchCompound[]).slice(
    0,
    safeLimit * 4,
  );
  if (canonicals.length === 0) return [];

  // Alias pass: include canonicals that match the query through an
  // alias but not through canonical_name / inchi_key.
  const ids = canonicals.map((c) => c.id);
  const { data: aliasRows, error: aliasError } = await supabase
    .from("research_compound_aliases")
    .select("compound_id, alias, normalized_alias")
    .in("compound_id", ids)
    .ilike("normalized_alias", `%${normalizeForCompoundLookup(escaped)}%`)
    .limit(safeLimit * 2);
  if (aliasError) {
    logger.warn(
      { err: aliasError },
      "compound_authority_search_alias_pass_failed",
    );
  }

  const aliased = new Set(
    ((aliasRows || []) as Array<{ compound_id: string }>).map(
      (r) => r.compound_id,
    ),
  );

  const queryNorm = normalizeForCompoundLookup(trimmed);
  const ranked = [...canonicals].sort((a, b) => {
    const aNorm = normalizeForCompoundLookup(a.canonical_name);
    const bNorm = normalizeForCompoundLookup(b.canonical_name);
    const aExact = aNorm === queryNorm ? 0 : 1;
    const bExact = bNorm === queryNorm ? 0 : 1;
    if (aExact !== bExact) return aExact - bExact;

    const aAlias = aliased.has(a.id) ? 0 : 1;
    const bAlias = aliased.has(b.id) ? 0 : 1;
    if (aAlias !== bAlias) return aAlias - bAlias;

    const aPrefix = aNorm.startsWith(queryNorm) ? 0 : 1;
    const bPrefix = bNorm.startsWith(queryNorm) ? 0 : 1;
    if (aPrefix !== bPrefix) return aPrefix - bPrefix;

    return a.canonical_name.localeCompare(b.canonical_name);
  });

  return ranked.slice(0, safeLimit);
}

// ---------------------------------------------------------------------------
// getCanonicalById — get canonical + aliases
// ---------------------------------------------------------------------------

/**
 * Fetch a single canonical compound by id along with all of its
 * aliases. Returns `null` when the canonical does not exist.
 */
export async function getCanonicalById(
  canonicalId: string,
): Promise<(ResearchCompound & { aliases: ResearchCompoundAlias[] }) | null> {
  if (!canonicalId) return null;
  const [{ data: compoundRow, error: compoundError }, { data: aliasRows, error: aliasError }] =
    await Promise.all([
      supabase
        .from("research_compounds")
        .select("*")
        .eq("id", canonicalId)
        .maybeSingle(),
      supabase
        .from("research_compound_aliases")
        .select("*")
        .eq("compound_id", canonicalId)
        .order("alias", { ascending: true }),
    ]);
  if (compoundError) throw compoundError;
  if (aliasError) throw aliasError;
  if (!compoundRow) return null;
  return {
    ...(compoundRow as ResearchCompound),
    aliases: (aliasRows || []) as ResearchCompoundAlias[],
  };
}

// ---------------------------------------------------------------------------
// addAlias — manual alias add (admin)
// ---------------------------------------------------------------------------

export type AddAliasParams = {
  canonicalId: string;
  alias: string;
  source?: "manual" | "curated";
  confidence: "high" | "medium" | "low";
  userId: string;
};

export type AddAliasResult = { id: string };

/**
 * Manually add an alias to a canonical compound and write a
 * `manual_alias_add` audit row in the same logical operation.
 *
 * Idempotency: if a row with the same `(compound_id, normalized_alias)`
 * already exists, the function is a no-op (no new alias, no new audit
 * row). This is what the spec's "Re-submitting the same alias is a
 * no-op" scenario requires.
 *
 * Errors (e.g. missing canonical, malformed alias) throw. The
 * function does NOT auto-resolve; the worker handles that on the
 * next backfill cycle.
 */
export async function addAlias(params: AddAliasParams): Promise<AddAliasResult> {
  const aliasTrimmed = (params.alias || "").trim();
  if (!aliasTrimmed) {
    throw new Error("alias is required");
  }
  const normalized = normalizeForCompoundLookup(aliasTrimmed);
  if (!normalized) {
    throw new Error("alias is required");
  }

  // 1) Look up existing alias (idempotency check). If present, return
  //    the existing id and DO NOT write a new audit row.
  const { data: existing, error: existingError } = await supabase
    .from("research_compound_aliases")
    .select("id")
    .eq("compound_id", params.canonicalId)
    .eq("normalized_alias", normalized)
    .maybeSingle();
  if (existingError) throw existingError;
  if (existing) {
    return { id: (existing as { id: string }).id };
  }

  // 2) Insert the alias. If the canonical doesn't exist, the FK
  //    constraint will reject the insert and we surface the error.
  const { data: inserted, error: insertError } = await supabase
    .from("research_compound_aliases")
    .insert({
      compound_id: params.canonicalId,
      alias: aliasTrimmed,
      normalized_alias: normalized,
      source: params.source ?? "manual",
      confidence: params.confidence,
    })
    .select("id")
    .single();
  if (insertError) throw insertError;
  const aliasId = (inserted as { id: string }).id;

  // 3) Write the audit row. If this throws, compensate by deleting
  //    the alias we just inserted. `fact_id` is NULL for alias-only
  //    events; the canonical id lives in `new_value.compound_id`.
  //    The spec author defers this FK relaxation to design — see
  //    the migration header comment.
  const { error: auditError } = await supabase
    .from("compound_authority_audit")
    .insert({
      fact_id: null,
      event_type: "manual_alias_add" as const,
      old_value: null,
      new_value: {
        compound_id: params.canonicalId,
        alias: aliasTrimmed,
        normalized_alias: normalized,
        source: params.source ?? "manual",
        confidence: params.confidence,
      },
      user_id: params.userId,
      reason: COMPOUND_AUTHORITY_REASONS.adminAliasAdded,
    });
  if (auditError) {
    logger.error(
      { err: auditError, aliasId, canonicalId: params.canonicalId },
      "compound_authority_alias_audit_insert_failed_rolling_back",
    );
    const { error: rollbackError } = await supabase
      .from("research_compound_aliases")
      .delete()
      .eq("id", aliasId);
    if (rollbackError) {
      logger.error(
        { err: rollbackError, aliasId },
        "compound_authority_alias_rollback_failed",
      );
    }
    throw auditError;
  }

  return { id: aliasId };
}

// ---------------------------------------------------------------------------
// promoteFactToPending — admin re-promote (failed -> pending)
// ---------------------------------------------------------------------------

export type PromoteFactParams = {
  factId: string;
  userId: string;
  reason: string;
};

/**
 * Move a fact from `'failed'` back to `'pending'` for one more
 * backfill cycle. The function refuses to operate on facts whose
 * current status is not `'failed'`: it throws `Error("not in failed
 * state")` and does NOT mutate the fact.
 *
 * The compound_authority_attempts counter is NOT reset (PR #3 design
 * will revisit). The error message is cleared; the canonical id is
 * preserved so the worker can pick it up if PubChem now finds it.
 */
export async function promoteFactToPending(
  params: PromoteFactParams,
): Promise<void> {
  // 1) Read the current state. If not failed, throw without writing.
  const { data: current, error: readError } = await supabase
    .from("research_bioprospecting_facts")
    .select(
      "compound_canonical_id, compound_authority_status, compound_authority_error",
    )
    .eq("id", params.factId)
    .maybeSingle();
  if (readError) {
    logger.error(
      { err: readError, factId: params.factId },
      "compound_authority_promote_read_failed",
    );
    throw readError;
  }
  if (!current) {
    throw new Error("fact not found");
  }
  const currentRow = current as {
    compound_canonical_id?: string | null;
    compound_authority_status?: CompoundStatus | null;
    compound_authority_error?: string | null;
  };
  if (currentRow.compound_authority_status !== "failed") {
    throw new Error("not in failed state");
  }
  const oldValue = {
    compound_canonical_id: currentRow.compound_canonical_id ?? null,
    compound_authority_status: "failed" as CompoundStatus,
    compound_authority_error: currentRow.compound_authority_error ?? null,
  };
  const newValue = {
    compound_canonical_id: currentRow.compound_canonical_id ?? null,
    compound_authority_status: "pending" as CompoundStatus,
    compound_authority_error: null,
  };

  // 2) Update the fact.
  const { error: updateError } = await supabase
    .from("research_bioprospecting_facts")
    .update({
      compound_authority_status: "pending",
      compound_authority_at: null,
      compound_authority_error: null,
    })
    .eq("id", params.factId);
  if (updateError) throw updateError;

  // 3) Write the audit row. If this throws, restore the prior state.
  const { error: auditError } = await supabase
    .from("compound_authority_audit")
    .insert({
      fact_id: params.factId,
      event_type: "status_change" as const,
      old_value: oldValue,
      new_value: newValue,
      user_id: params.userId,
      reason: params.reason,
    });
  if (auditError) {
    logger.error(
      { err: auditError, factId: params.factId },
      "compound_authority_promote_audit_insert_failed_rolling_back",
    );
    const { error: rollbackError } = await supabase
      .from("research_bioprospecting_facts")
      .update({
        compound_authority_status: "failed",
        compound_authority_error: oldValue.compound_authority_error,
      })
      .eq("id", params.factId);
    if (rollbackError) {
      logger.error(
        { err: rollbackError, factId: params.factId },
        "compound_authority_promote_rollback_failed",
      );
    }
    throw auditError;
  }
}

// ---------------------------------------------------------------------------
// emptyStamp — re-exported for tests
// ---------------------------------------------------------------------------

/** Default authority stamp for fresh inserts. Exported for tests. */
export const emptyStamp: CompoundAuthorityStamp = { ...EMPTY_STAMP };
