/**
 * Bioprospecting Worker
 * Extracts bioprospecting facts from a processed source using LLM analysis.
 * Called after document ingestion completes for a file.
 */

import { Worker, Job } from "bullmq";
import { getBullMQConnection } from "../connection";
import { notifyIngestionProgress, notifyIngestionCompleted, notifyIngestionFailed } from "../notify";
import type { BioprospectingJobData } from "../types";
import logger from "../../../utils/logger";
import { getServiceClient } from "../../../db/client";

const supabase = getServiceClient();

/**
 * Get current run counters
 */
async function getRunCounters(runId: string): Promise<{ processed: number; skipped: number; failed: number }> {
  const { data: run } = await supabase
    .from("research_ingestion_runs")
    .select("processed_files, skipped_files, failed_files, total_files")
    .eq("id", runId)
    .single();

  if (!run) return { processed: 0, skipped: 0, failed: 0 };
  return {
    processed: (run as any).processed_files || 0,
    skipped: (run as any).skipped_files || 0,
    failed: (run as any).failed_files || 0,
  };
}

/**
 * Check if all jobs for a run are complete
 */
async function isRunComplete(runId: string): Promise<boolean> {
  const { data: run } = await supabase
    .from("research_ingestion_runs")
    .select("processed_files, skipped_files, failed_files, total_files")
    .eq("id", runId)
    .single();

  if (!run) return false;

  const processed = (run as any).processed_files || 0;
  const skipped = (run as any).skipped_files || 0;
  const failed = (run as any).failed_files || 0;
  const total = (run as any).total_files || 0;

  return processed + skipped + failed >= total;
}

/**
 * Finish the run (mark as completed or completed_with_errors)
 */
async function finishRun(
  runId: string,
  counters: { processed: number; skipped: number; failed: number },
): Promise<void> {
  const status = counters.failed > 0 ? "completed_with_errors" : "completed";

  try {
    await supabase
      .from("research_ingestion_runs")
      .update({
        status,
        finished_at: new Date().toISOString(),
      })
      .eq("id", runId);
  } catch (error) {
    logger.warn({ err: error, runId }, "finish_run_failed");
  }
}

/**
 * Process a bioprospecting job
 */
async function processBioprospectingJob(job: Job<BioprospectingJobData, any>): Promise<any> {
  const { runId, sourceId, options } = job.data;

  logger.info({ jobId: job.id, runId, sourceId }, "bioprospecting_job_started");

  try {
    // Extract bioprospecting facts from the source
    const { extractBioprospectingFactsForSource } = await import("../../../services/researchBrain");
    await extractBioprospectingFactsForSource(sourceId);

    logger.info({ jobId: job.id, runId, sourceId }, "bioprospecting_job_completed");

    return { sourceId, status: "completed" };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : "Unknown error";

    logger.error({ jobId: job.id, runId, sourceId, error: errorMessage }, "bioprospecting_job_failed");

    return { sourceId, status: "failed", error: errorMessage };
  }
}

/**
 * Create and start the bioprospecting worker
 */
export function createBioprospectingWorker(): Worker<BioprospectingJobData, any> {
  const connection = getBullMQConnection();
  const concurrency = parseInt(process.env.BIOPROSPECTING_CONCURRENCY || "1", 10);

  const worker = new Worker<BioprospectingJobData, any>(
    "bioprospecting",
    processBioprospectingJob,
    {
      connection,
      concurrency,
      lockDuration: 300000, // 5 minutes for LLM extraction
    },
  );

  // Event handlers
  worker.on("completed", (job, result) => {
    logger.info(
      { jobId: job.id, sourceId: result.sourceId, status: result.status },
      "bioprospecting_worker_job_completed",
    );
  });

  worker.on("failed", (job, error) => {
    logger.error(
      { jobId: job?.id, error: error.message },
      "bioprospecting_worker_job_failed",
    );
  });

  worker.on("error", (error) => {
    logger.error({ error: error.message }, "bioprospecting_worker_error");
  });

  logger.info({ concurrency }, "bioprospecting_worker_started");

  return worker;
}
