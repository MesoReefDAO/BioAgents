/**
 * Bioprospecting Worker
 * Extracts bioprospecting facts from a processed source using LLM analysis.
 * Called after document ingestion completes for a file.
 */

import { Worker, Job } from "bullmq";
import { getBullMQConnection } from "../connection";
import { notifyIngestionProgress, notifyIngestionCompleted, notifyIngestionFailed, notifyRunCancelled } from "../notify";
import type { BioprospectingJobData } from "../types";
import logger from "../../../utils/logger";
import { getServiceClient } from "../../../db/client";
import { recordLlmCall, calculateCost } from "../../researchBrain/llm-cost";
import { resolveResearchBrainLLM } from "../../researchBrain/llm";

const supabase = getServiceClient();

/**
 * Check if run was cancelled
 */
async function isRunCancelled(runId: string): Promise<boolean> {
  const { data: run } = await supabase
    .from("research_ingestion_runs")
    .select("cancelled_at")
    .eq("id", runId)
    .single();

  return !!(run as any)?.cancelled_at;
}

/**
 * Process a bioprospecting job
 */
async function processBioprospectingJob(job: Job<BioprospectingJobData, any>): Promise<any> {
  const { runId, sourceId, options } = job.data;

  logger.info({ jobId: job.id, runId, sourceId }, "bioprospecting_job_started");

  // Check if run was cancelled before starting
  if (await isRunCancelled(runId)) {
    logger.info({ jobId: job.id, runId, sourceId }, "bioprospecting_job_skipped_cancelled");
    await notifyRunCancelled(runId);
    return { sourceId, status: "cancelled" };
  }

  const startTime = Date.now();

  try {
    // Extract bioprospecting facts from the source
    const { extractBioprospectingFactsForSource } = await import("../../../services/researchBrain");
    await extractBioprospectingFactsForSource(sourceId);

    // Record LLM cost estimate
    const { providerName, model } = resolveResearchBrainLLM();
    if (providerName && model) {
      const elapsed = Date.now() - startTime;
      // Estimate ~500 tokens input + ~800 tokens output per extraction (typical for this task)
      const inputTokens = 500;
      const outputTokens = 800;
      const costUsd = calculateCost(providerName, model, inputTokens, outputTokens);
      await recordLlmCall(runId, {
        provider: providerName,
        model,
        inputTokens,
        outputTokens,
        costUsd,
        latencyMs: elapsed,
        timestamp: new Date().toISOString(),
      });
    }

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
