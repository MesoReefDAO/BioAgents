/**
 * Compound Authority Worker
 *
 * Drives the periodic PubChem backfill. On each tick (BullMQ repeatable
 * `compound-authority` job) it calls
 * `normalizeBioprospectingCompounds`, which:
 *   - re-checks each pending fact against the in-memory alias map
 *   - on miss, calls PubChem at 4 rps (gate-enforced)
 *   - writes canonical/alias rows and stamps the fact with
 *     `verified` / `pending` / `failed`
 *
 * The worker runs with `concurrency: 1` so a single in-process gate
 * is sufficient for rate-limiting. BullMQ's built-in limiter is not
 * used — it cannot honor PubChem's per-response `Retry-After` header.
 *
 * Spawned from `src/worker.ts` alongside the other workers.
 */

import { Worker, Job } from "bullmq";
import { getBullMQConnection } from "../connection";
import type { CompoundAuthorityJobData, CompoundAuthorityJobResult } from "../types";
import logger from "../../../utils/logger";
import { normalizeBioprospectingCompounds } from "../../researchBrain/compoundAuthority";

/**
 * Create and start the compound-authority worker. Returns the
 * Worker handle so the caller can wire it into graceful shutdown.
 */
export function createCompoundAuthorityWorker(): Worker<
  CompoundAuthorityJobData,
  CompoundAuthorityJobResult
> {
  const connection = getBullMQConnection();
  // Concurrency is fixed at 1 — the in-process RateGate enforces the
  // 4 rps cap on PubChem, and multiple workers would defeat the
  // closure-based gate. Override via env for emergency scaling only.
  const concurrency = 1;

  const worker = new Worker<
    CompoundAuthorityJobData,
    CompoundAuthorityJobResult
  >("compound-authority", processCompoundAuthorityJob, {
    connection,
    concurrency,
    lockDuration: 300_000, // 5 minutes — backfill is synchronous and bounded
  });

  worker.on("completed", (job, result) => {
    logger.info(
      {
        jobId: job.id,
        result,
      },
      "compound_authority_worker_job_completed",
    );
  });

  worker.on("failed", (job, error) => {
    logger.error(
      {
        jobId: job?.id,
        error: error instanceof Error ? error.message : String(error),
      },
      "compound_authority_worker_job_failed",
    );
  });

  worker.on("error", (error) => {
    logger.error(
      { error: error instanceof Error ? error.message : String(error) },
      "compound_authority_worker_error",
    );
  });

  logger.info({ concurrency }, "compound_authority_worker_started");

  return worker;
}

async function processCompoundAuthorityJob(
  job: Job<CompoundAuthorityJobData, CompoundAuthorityJobResult>,
): Promise<CompoundAuthorityJobResult> {
  logger.info({ jobId: job.id }, "compound_authority_job_started");
  try {
    const summary = await normalizeBioprospectingCompounds({});
    logger.info(
      {
        jobId: job.id,
        scannedFacts: summary.scannedFacts,
        aliasHits: summary.aliasHits,
        pubchemHits: summary.pubchemHits,
        pubchemMisses: summary.pubchemMisses,
        retriesScheduled: summary.retriesScheduled,
        failed: summary.failed,
        elapsedMs: summary.elapsed,
      },
      "compound_authority_run_summary",
    );
    return summary;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error(
      { jobId: job.id, error: message },
      "compound_authority_job_failed",
    );
    throw err;
  }
}
