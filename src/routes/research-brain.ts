import { Elysia } from "elysia";
import { mkdir } from "fs/promises";
import path from "path";
import { authResolver } from "../middleware/authResolver";
import {
  backfillBioprospectingMeasurements,
  extractBioprospectingFactsForSource,
  extractClaimsForSource,
  getClaim,
  getSourceClaims,
  getSourceEvidenceChunk,
  listResearchTaxa,
  listSources,
  normalizeBioprospectingTaxonomy,
  researchBrainSearch,
  searchBioprospectingFacts,
  updateBioprospectingFactEntities,
  updateBioprospectingFactReview,
  updateBioprospectingFactsReviewBulk,
} from "../services/researchBrain";
import { getServiceClient } from "../db/client";
import { getDocumentIngestionQueue } from "../services/queue/queues";
import { isJobQueueEnabled } from "../services/queue/connection";
import { DocumentProcessor } from "../embeddings/documentProcessor";
import logger from "../utils/logger";

function getDocsPath(): string {
  return process.env.KNOWLEDGE_DOCS_PATH || "docs";
}

function safeUploadPath(filename: string): string {
  const docsRoot = path.resolve(getDocsPath());
  const safeName = path.basename(filename).replace(/[^\w.\- ()]/g, "_");
  return path.resolve(docsRoot, safeName);
}

export const researchBrainRoute = new Elysia({ prefix: "/api/research-brain" })
  .get(
    "/sources",
    async ({ set }) => {
      try {
        return { sources: await listSources() };
      } catch (error: any) {
        logger.error({ err: error }, "research_brain_sources_failed");
        set.status = 500;
        return {
          error: "Failed to list Research Brain sources",
          message: error?.message,
        };
      }
    },
    { beforeHandle: authResolver({ required: false }) },
  )
  .get(
    "/sources/:id/claims",
    async ({ params, set }) => {
      try {
        return { claims: await getSourceClaims(params.id) };
      } catch (error: any) {
        logger.error(
          { err: error, sourceId: params.id },
          "research_brain_source_claims_failed",
        );
        set.status = 500;
        return {
          error: "Failed to list source claims",
          message: error?.message,
        };
      }
    },
    { beforeHandle: authResolver({ required: false }) },
  )
  .get(
    "/sources/:id/chunks/:chunkIndex",
    async ({ params, set }) => {
      const chunkIndex = Number(params.chunkIndex);
      if (!Number.isFinite(chunkIndex)) {
        set.status = 400;
        return { error: "Invalid chunk index" };
      }

      try {
        const chunk = await getSourceEvidenceChunk(params.id, chunkIndex);
        if (!chunk) {
          set.status = 404;
          return { error: "Evidence fragment not found" };
        }
        return { chunk };
      } catch (error: any) {
        logger.error(
          { err: error, sourceId: params.id, chunkIndex },
          "research_brain_source_chunk_failed",
        );
        set.status = 500;
        return {
          error: "Failed to load evidence fragment",
          message: error?.message,
        };
      }
    },
    { beforeHandle: authResolver({ required: false }) },
  )
  .post(
    "/search",
    async ({ body, set }) => {
      const parsed = (body || {}) as {
        query?: string;
        trustTier?: "internal" | "external" | "all";
        includeExternal?: boolean;
        limit?: number;
        measurementMin?: number;
        measurementMax?: number;
        measurementUnit?: string;
        measurementDirection?: "increase" | "decrease" | "no_change" | "mixed";
        condition?: string;
        reviewStatus?:
          | "unreviewed"
          | "verified"
          | "needs_review"
          | "incorrect"
          | "quarantined"
          | "all";
        evidenceStrength?:
          | "direct"
          | "indirect"
          | "hypothesis"
          | "unknown"
          | "all";
        sourceId?: string;
        sourceTrustTier?: "internal" | "external" | "all";
      };

      if (!parsed.query || !parsed.query.trim()) {
        set.status = 400;
        return { error: "Missing query" };
      }

      try {
        const evidencePack = await researchBrainSearch({
          query: parsed.query,
          trustTier: parsed.trustTier,
          includeExternal: parsed.includeExternal,
          limit: parsed.limit,
          measurementMin: parsed.measurementMin,
          measurementMax: parsed.measurementMax,
          measurementUnit: parsed.measurementUnit,
          measurementDirection: parsed.measurementDirection,
          condition: parsed.condition,
          reviewStatus: parsed.reviewStatus,
          evidenceStrength: parsed.evidenceStrength,
          sourceId: parsed.sourceId,
          sourceTrustTier: parsed.sourceTrustTier,
        });
        return { evidencePack };
      } catch (error: any) {
        logger.error(
          { err: error, query: parsed.query },
          "research_brain_search_failed",
        );
        set.status = 500;
        return {
          error: "Failed to search Research Brain",
          message: error?.message,
        };
      }
    },
    { beforeHandle: authResolver({ required: false }) },
  )
  .post(
    "/bioprospecting/search",
    async ({ body, set }) => {
      const parsed = (body || {}) as {
        query?: string;
        limit?: number;
        measurementMin?: number;
        measurementMax?: number;
        measurementUnit?: string;
        measurementDirection?: "increase" | "decrease" | "no_change" | "mixed";
        condition?: string;
        reviewStatus?:
          | "unreviewed"
          | "verified"
          | "needs_review"
          | "incorrect"
          | "quarantined"
          | "all";
        sourceId?: string;
        sourceTrustTier?: "internal" | "external" | "all";
      };

      if (!parsed.query || !parsed.query.trim()) {
        set.status = 400;
        return { error: "Missing query" };
      }

      try {
        return {
          facts: await searchBioprospectingFacts({
            query: parsed.query,
            limit: parsed.limit,
            measurementMin: parsed.measurementMin,
            measurementMax: parsed.measurementMax,
            measurementUnit: parsed.measurementUnit,
            measurementDirection: parsed.measurementDirection,
            condition: parsed.condition,
            reviewStatus: parsed.reviewStatus,
            sourceId: parsed.sourceId,
            sourceTrustTier: parsed.sourceTrustTier,
          }),
        };
      } catch (error: any) {
        logger.error(
          { err: error, query: parsed.query },
          "bioprospecting_search_failed",
        );
        set.status = 500;
        return {
          error: "Failed to search bioprospecting facts",
          message: error?.message,
        };
      }
    },
    { beforeHandle: authResolver({ required: false }) },
  )
  .post(
    "/bioprospecting/measurements/backfill",
    async ({ body, set }) => {
      const parsed = (body || {}) as {
        limit?: number;
        dryRun?: boolean;
      };

      try {
        return await backfillBioprospectingMeasurements({
          limit: parsed.limit,
          dryRun: parsed.dryRun,
        });
      } catch (error: any) {
        logger.error(
          { err: error },
          "bioprospecting_measurement_backfill_failed",
        );
        set.status = 500;
        return {
          error: "Failed to backfill bioprospecting measurements",
          message: error?.message,
        };
      }
    },
    { beforeHandle: authResolver({ required: true }) },
  )
  .patch(
    "/bioprospecting/facts/:id/review",
    async ({ params, body, request, set }) => {
      const parsed = (body || {}) as {
        reviewStatus?: string;
        reviewNote?: string | null;
      };
      const allowedStatuses = new Set([
        "unreviewed",
        "verified",
        "needs_review",
        "incorrect",
        "quarantined",
      ]);

      if (!parsed.reviewStatus || !allowedStatuses.has(parsed.reviewStatus)) {
        set.status = 400;
        return { error: "Invalid review status" };
      }

      try {
        return {
          fact: await updateBioprospectingFactReview({
            factId: params.id,
            reviewStatus: parsed.reviewStatus as any,
            reviewNote: parsed.reviewNote,
            reviewedBy: (request as any).auth?.userId,
          }),
        };
      } catch (error: any) {
        logger.error(
          { err: error, factId: params.id },
          "bioprospecting_review_update_failed",
        );
        set.status = 500;
        return {
          error: "Failed to update bioprospecting fact review",
          message: error?.message,
        };
      }
    },
    { beforeHandle: authResolver({ required: true }) },
  )
  .patch(
    "/bioprospecting/facts/review-bulk",
    async ({ body, request, set }) => {
      const parsed = (body || {}) as {
        factIds?: string[];
        reviewStatus?: string;
        reviewNote?: string | null;
      };
      const allowedStatuses = new Set([
        "unreviewed",
        "verified",
        "needs_review",
        "incorrect",
        "quarantined",
      ]);
      const factIds = Array.isArray(parsed.factIds)
        ? parsed.factIds.filter(Boolean)
        : [];

      if (factIds.length === 0) {
        set.status = 400;
        return { error: "Missing fact ids" };
      }
      if (factIds.length > 250) {
        set.status = 400;
        return { error: "Bulk review is limited to 250 facts per request" };
      }
      if (!parsed.reviewStatus || !allowedStatuses.has(parsed.reviewStatus)) {
        set.status = 400;
        return { error: "Invalid review status" };
      }

      try {
        const facts = await updateBioprospectingFactsReviewBulk({
          factIds,
          reviewStatus: parsed.reviewStatus as any,
          reviewNote: parsed.reviewNote,
          reviewedBy: (request as any).auth?.userId,
        });
        return { facts, updated: facts.length };
      } catch (error: any) {
        logger.error({ err: error }, "bioprospecting_bulk_review_failed");
        set.status = 500;
        return {
          error: "Failed to bulk update bioprospecting fact reviews",
          message: error?.message,
        };
      }
    },
    { beforeHandle: authResolver({ required: true }) },
  )
  .patch(
    "/bioprospecting/facts/:id/entities",
    async ({ params, body, request, set }) => {
      const parsed = (body || {}) as {
        species?: string | null;
        genus?: string | null;
        family?: string | null;
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
        condition?: string | null;
      };

      try {
        return {
          fact: await updateBioprospectingFactEntities({
            factId: params.id,
            correctedBy: (request as any).auth?.userId,
            patch: {
              species: parsed.species,
              genus: parsed.genus,
              family: parsed.family,
              organism_group: parsed.organismGroup,
              geography: parsed.geography,
              ecosystem: parsed.ecosystem,
              organism_part: parsed.organismPart,
              compound: parsed.compound,
              compound_class: parsed.compoundClass,
              molecule_type: parsed.moleculeType,
              bioactivity: parsed.bioactivity,
              application_area: parsed.applicationArea,
              assay_model: parsed.assayModel,
              condition: parsed.condition,
            },
          }),
        };
      } catch (error: any) {
        logger.error(
          { err: error, factId: params.id },
          "bioprospecting_entity_update_failed",
        );
        set.status = 500;
        return {
          error: "Failed to update bioprospecting fact entities",
          message: error?.message,
        };
      }
    },
    { beforeHandle: authResolver({ required: true }) },
  )
  .get(
    "/taxonomy",
    async ({ query, set }) => {
      const parsed = query as {
        rank?: "species" | "genus" | "family" | "higher_taxon";
        q?: string;
        limit?: string;
      };

      try {
        return {
          taxa: await listResearchTaxa({
            rank: parsed.rank,
            query: parsed.q,
            limit: parsed.limit ? Number(parsed.limit) : undefined,
          }),
        };
      } catch (error: any) {
        logger.error({ err: error }, "research_taxonomy_list_failed");
        set.status = 500;
        return {
          error: "Failed to list normalized taxonomy",
          message: error?.message,
        };
      }
    },
    { beforeHandle: authResolver({ required: false }) },
  )
  .post(
    "/taxonomy/normalize",
    async ({ body, set }) => {
      const parsed = (body || {}) as {
        limit?: number;
        dryRun?: boolean;
        onlyMissing?: boolean;
        useWoRMS?: boolean;
      };

      try {
        return await normalizeBioprospectingTaxonomy({
          limit: parsed.limit,
          dryRun: parsed.dryRun,
          onlyMissing: parsed.onlyMissing,
          useWoRMS: parsed.useWoRMS,
        });
      } catch (error: any) {
        logger.error({ err: error }, "research_taxonomy_normalize_failed");
        set.status = 500;
        return {
          error: "Failed to normalize taxonomy",
          message: error?.message,
        };
      }
    },
    { beforeHandle: authResolver({ required: true }) },
  )
  .post(
    "/sources/:id/extract",
    async ({ params, set }) => {
      try {
        return await extractClaimsForSource(params.id);
      } catch (error: any) {
        logger.error(
          { err: error, sourceId: params.id },
          "research_brain_extract_failed",
        );
        set.status = 500;
        return {
          error: "Failed to extract source claims",
          message: error?.message,
        };
      }
    },
    { beforeHandle: authResolver({ required: true }) },
  )
  .post(
    "/sources/:id/extract-bioprospecting",
    async ({ params, set }) => {
      try {
        return await extractBioprospectingFactsForSource(params.id);
      } catch (error: any) {
        logger.error(
          { err: error, sourceId: params.id },
          "bioprospecting_extract_failed",
        );
        set.status = 500;
        return {
          error: "Failed to extract bioprospecting facts",
          message: error?.message,
        };
      }
    },
    { beforeHandle: authResolver({ required: true }) },
  )
  .get(
    "/claims/:id",
    async ({ params, set }) => {
      try {
        const claim = await getClaim(params.id);
        if (!claim) {
          set.status = 404;
          return { error: "Claim not found" };
        }
        return { claim };
      } catch (error: any) {
        logger.error(
          { err: error, claimId: params.id },
          "research_brain_claim_failed",
        );
        set.status = 500;
        return { error: "Failed to load claim", message: error?.message };
      }
    },
    { beforeHandle: authResolver({ required: false }) },
  )
  .post(
    "/sources/upload",
    async ({ body, set }) => {
      const parsed = body as any;
      const file = parsed?.file instanceof File ? parsed.file : null;
      if (!file) {
        set.status = 400;
        return { error: "Missing file" };
      }

      const destination = safeUploadPath(file.name);
      const docsRoot = path.resolve(getDocsPath());
      if (
        destination !== docsRoot &&
        !destination.startsWith(docsRoot + path.sep)
      ) {
        set.status = 400;
        return { error: "Invalid filename" };
      }

      try {
        await mkdir(docsRoot, { recursive: true });
        await Bun.write(destination, file);

        const { VectorSearchWithDocuments } =
          await import("../embeddings/vectorSearchWithDocs");
        let vectorSearch = (globalThis as any).__knowledgeVectorSearch;
        if (!vectorSearch) {
          vectorSearch = new VectorSearchWithDocuments();
          (globalThis as any).__knowledgeVectorSearch = vectorSearch;
        }

        const added = await vectorSearch.addFile(destination);

        logger.info(
          { filename: file.name, destination, sourceId: added.sourceId },
          "research_brain_source_uploaded",
        );

        return {
          ok: true,
          title: added.title,
          chunkCount: added.chunkCount,
          sourceId: added.sourceId,
        };
      } catch (error: any) {
        logger.error(
          { err: error, filename: file.name },
          "research_brain_upload_failed",
        );
        set.status = 500;
        return { error: "Failed to upload source", message: error?.message };
      }
    },
    { beforeHandle: authResolver({ required: true }) },
  )
  .post(
    "/ingestion/start",
    async ({ body, set }) => {
      const parsed = (body || {}) as {
        docsPath?: string;
        options?: {
          force?: boolean;
          extractBioprospecting?: boolean;
        };
      };

      if (!parsed.docsPath) {
        set.status = 400;
        return { error: "Missing docsPath" };
      }

      const docsPath = path.resolve(parsed.docsPath);
      const force = parsed.options?.force ?? false;
      const extractBioprospecting = parsed.options?.extractBioprospecting ?? false;

      // Check if directory exists and is accessible
      try {
        await mkdir(docsPath, { recursive: true });
      } catch {
        set.status = 400;
        return { error: "Directory not accessible" };
      }

      const supabase = getServiceClient();

      // List all files in the directory
      const documentProcessor = new DocumentProcessor();
      const ignorePatterns = (process.env.KNOWLEDGE_INGEST_IGNORE || "research-brain.md")
        .split(",")
        .map((p) => p.trim())
        .filter((p) => p.length > 0);

      let files: string[] = [];
      try {
        files = await documentProcessor.listSupportedFiles(docsPath, { ignorePatterns });
      } catch {
        set.status = 400;
        return { error: "Directory not accessible" };
      }

      if (files.length === 0) {
        set.status = 400;
        return { error: "No supported files found in directory" };
      }

      // Create ingestion run record
      let runId: string | null = null;
      try {
        const { data, error } = await supabase
          .from("research_ingestion_runs")
          .insert({
            docs_path: docsPath,
            status: "running",
            total_files: files.length,
            metadata: {
              force,
              extractBioprospecting,
            },
          })
          .select("id")
          .single();

        if (error) throw error;
        runId = (data as any).id;
      } catch (error: any) {
        logger.error({ err: error }, "ingestion_start_run_create_failed");
        set.status = 500;
        return { error: "Failed to create ingestion run", message: error?.message };
      }

      // If job queue is disabled, return error (sequential mode not supported for API)
      if (!isJobQueueEnabled()) {
        set.status = 400;
        return { error: "Job queue is not enabled. Set USE_JOB_QUEUE=true to use ingestion API." };
      }

      // Enqueue jobs for each file
      try {
        const queue = getDocumentIngestionQueue();
        for (const filePath of files) {
          await queue.add("document-ingestion", {
            runId,
            filePath,
            options: {
              force,
              extractBioprospecting,
            },
          });
        }

        logger.info({ runId, fileCount: files.length }, "ingestion_jobs_enqueued");
      } catch (error: any) {
        logger.error({ err: error, runId }, "ingestion_jobs_enqueue_failed");
        set.status = 500;
        return { error: "Failed to enqueue ingestion jobs", message: error?.message };
      }

      return {
        runId,
        status: "running",
        totalFiles: files.length,
      };
    },
    { beforeHandle: authResolver({ required: false }) },
  )
  .get(
    "/ingestion/runs",
    async ({ query, set }) => {
      const supabase = getServiceClient();
      const parsed = query as { status?: string; limit?: string; offset?: string };

      const limit = Math.min(Math.max(parseInt(parsed.limit || "20", 10) || 20, 1), 100);
      const offset = parseInt(parsed.offset || "0", 10) || 0;
      const status = parsed.status;

      try {
        let dbQuery = supabase
          .from("research_ingestion_runs")
          .select("id, docs_path, status, total_files, processed_files, skipped_files, failed_files, llm_cost, started_at, finished_at, cancelled_at", { count: "exact" })
          .order("started_at", { ascending: false })
          .range(offset, offset + limit - 1);

        if (status) {
          dbQuery = dbQuery.eq("status", status);
        }

        const { data: runs, error, count } = await dbQuery;

        if (error) throw error;

        return {
          runs: (runs || []).map((run: any) => ({
            runId: run.id,
            docsPath: run.docs_path,
            status: run.status,
            totalFiles: run.total_files,
            processedFiles: run.processed_files,
            skippedFiles: run.skipped_files,
            failedFiles: run.failed_files,
            llmCost: parseFloat(run.llm_cost || "0"),
            startedAt: run.started_at,
            finishedAt: run.finished_at,
            cancelledAt: run.cancelled_at,
          })),
          total: count || 0,
          limit,
          offset,
        };
      } catch (error: any) {
        logger.error({ err: error }, "ingestion_runs_list_failed");
        set.status = 500;
        return { error: "Failed to list runs", message: error?.message };
      }
    },
    { beforeHandle: authResolver({ required: true, role: "admin" }) },
  )
  .post(
    "/ingestion/runs/:id/cancel",
    async ({ params, set }) => {
      const supabase = getServiceClient();

      try {
        const { data: run, error: runError } = await supabase
          .from("research_ingestion_runs")
          .select("id, status")
          .eq("id", params.id)
          .single();

        if (runError || !run) {
          set.status = 404;
          return { error: "Run not found" };
        }

        if (run.status === "completed" || run.status === "failed" || run.status === "cancelled") {
          set.status = 409;
          return { error: "Cannot cancel completed run" };
        }

        const cancelledAt = new Date().toISOString();
        await supabase
          .from("research_ingestion_runs")
          .update({ status: "cancelled", cancelled_at: cancelledAt })
          .eq("id", params.id);

        return {
          runId: params.id,
          status: "cancelled",
          cancelledAt,
        };
      } catch (error: any) {
        logger.error({ err: error, runId: params.id }, "ingestion_run_cancel_failed");
        set.status = 500;
        return { error: "Failed to cancel run", message: error?.message };
      }
    },
    { beforeHandle: authResolver({ required: true, role: "admin" }) },
  )
  .get(
    "/ingestion/runs/:id",
    async ({ params, set }) => {
      const supabase = getServiceClient();

      try {
        const { data: run, error } = await supabase
          .from("research_ingestion_runs")
          .select("*")
          .eq("id", params.id)
          .single();

        if (error || !run) {
          set.status = 404;
          return { error: "Run not found" };
        }

 return {
          runId: (run as any).id,
          docsPath: (run as any).docs_path,
          status: (run as any).status,
          totalFiles: (run as any).total_files,
          processedFiles: (run as any).processed_files,
          skippedFiles: (run as any).skipped_files,
          failedFiles: (run as any).failed_files,
          llmCost: parseFloat((run as any).llm_cost || "0"),
          llmCallsCount: ((run as any).llm_calls || []).length,
          startedAt: (run as any).started_at,
          finishedAt: (run as any).finished_at,
          cancelledAt: (run as any).cancelled_at,
        };
      } catch (error: any) {
        logger.error({ err: error, runId: params.id }, "ingestion_run_status_failed");
        set.status = 500;
        return { error: "Failed to get run status", message: error?.message };
      }
    },
       { beforeHandle: authResolver({ required: true, role: "admin" }) },
  )
  .get(
    "/ingestion/runs/:id/files",
    async ({ params, set }) => {
      const supabase = getServiceClient();

      try {
        const { data: run, error } = await supabase
          .from("research_ingestion_runs")
          .select("file_statuses")
          .eq("id", params.id)
          .single();

        if (error || !run) {
          set.status = 404;
          return { error: "Run not found" };
        }

        const fileStatuses: any[] = (run as any).file_statuses || [];

        return {
          runId: params.id,
          files: fileStatuses.map((f) => ({
            filePath: f.filePath,
            status: f.status,
            chunksInserted: f.chunksInserted,
            sourceId: f.sourceId,
            error: f.error,
            reason: f.reason,
          })),
        };
      } catch (error: any) {
        logger.error({ err: error, runId: params.id }, "ingestion_run_files_failed");
        set.status = 500;
        return { error: "Failed to get file statuses", message: error?.message };
      }
    },
    { beforeHandle: authResolver({ required: false }) },
  )
  .post(
    "/ingestion/runs/:id/retry-failed",
    async ({ params, set }) => {
      const supabase = getServiceClient();

      // Get the run and filter for failed files
      const { data: run, error: runError } = await supabase
        .from("research_ingestion_runs")
        .select("file_statuses, metadata")
        .eq("id", params.id)
        .single();

      if (runError || !run) {
        set.status = 404;
        return { error: "Run not found" };
      }

      const fileStatuses: any[] = (run as any).file_statuses || [];
      const failedFiles = fileStatuses.filter((f) => f.status === "failed");

      if (failedFiles.length === 0) {
        return {
          runId: params.id,
          retriedFiles: 0,
          status: (run as any).status,
        };
      }

      // Update run status to running
      await supabase
        .from("research_ingestion_runs")
        .update({ status: "running" })
        .eq("id", params.id);

      // Re-enqueue failed jobs
      if (isJobQueueEnabled()) {
        const queue = getDocumentIngestionQueue();
        const metadata = (run as any).metadata || {};

        for (const file of failedFiles) {
          await queue.add("document-ingestion", {
            runId: params.id,
            filePath: file.filePath,
            options: {
              force: metadata.force ?? false,
              extractBioprospecting: metadata.extractBioprospecting ?? false,
            },
          });
        }

        logger.info({ runId: params.id, retriedFiles: failedFiles.length }, "ingestion_retry_failed_enqueued");
      }

      return {
        runId: params.id,
        retriedFiles: failedFiles.length,
        status: "running",
      };
    },
    { beforeHandle: authResolver({ required: false }) },
  );

export default researchBrainRoute;
