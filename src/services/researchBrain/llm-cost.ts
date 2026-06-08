/**
 * LLM Cost Tracking for Research Brain Ingestion
 *
 * Provides:
 * - Provider pricing map (OpenAI, Anthropic, Google, OpenRouter)
 * - calculateCost() to compute USD cost from token counts
 * - recordLlmCall() to persist a call record via Supabase RPC
 */

import { getServiceClient } from "../../db/client";
import logger from "../../utils/logger";

// Provider pricing: input cost per 1M tokens, output cost per 1M tokens
const LLM_PRICING: Record<string, { inputPer1M: number; outputPer1M: number }> = {
  // OpenAI
  "gpt-4o": { inputPer1M: 3.0, outputPer1M: 12.0 },
  "gpt-4o-mini": { inputPer1M: 0.15, outputPer1M: 0.6 },
  "gpt-4-turbo": { inputPer1M: 10.0, outputPer1M: 30.0 },
  "gpt-4": { inputPer1M: 30.0, outputPer1M: 60.0 },
  "gpt-3.5-turbo": { inputPer1M: 0.5, outputPer1M: 1.5 },
  // Anthropic
  "claude-opus-4": { inputPer1M: 18.0, outputPer1M: 90.0 },
  "claude-sonnet-4": { inputPer1M: 3.0, outputPer1M: 15.0 },
  "claude-3-5-sonnet": { inputPer1M: 1.5, outputPer1M: 7.5 },
  "claude-3-opus": { inputPer1M: 15.0, outputPer1M: 75.0 },
  "claude-3-sonnet": { inputPer1M: 3.0, outputPer1M: 15.0 },
  "claude-3-haiku": { inputPer1M: 0.25, outputPer1M: 1.25 },
  // Google
  "gemini-2.5-pro": { inputPer1M: 1.25, outputPer1M: 10.0 },
  "gemini-2.5-flash": { inputPer1M: 0.075, outputPer1M: 0.3 },
  "gemini-2.0-pro": { inputPer1M: 0.0, outputPer1M: 0.0 }, // free
  "gemini-1.5-pro": { inputPer1M: 1.25, outputPer1M: 5.0 },
  "gemini-1.5-flash": { inputPer1M: 0.075, outputPer1M: 0.3 },
  // OpenRouter (varies by underlying provider, use a blended estimate)
  "openrouter/gpt-4o-mini": { inputPer1M: 0.15, outputPer1M: 0.6 },
  "openrouter/claude-3-haiku": { inputPer1M: 0.25, outputPer1M: 1.25 },
};

export interface LlmCallEntry {
  provider: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  latencyMs: number;
  timestamp: string;
}

/**
 * Calculate USD cost for an LLM call
 */
export function calculateCost(
  provider: string,
  model: string,
  inputTokens: number,
  outputTokens: number,
): number {
  const key = `${provider}/${model}`;
  const pricing = LLM_PRICING[key] ?? LLM_PRICING[model];

  if (!pricing) {
    logger.warn({ provider, model }, "llm_cost_unknown_pricing");
    return 0;
  }

  const inputCost = (inputTokens / 1_000_000) * pricing.inputPer1M;
  const outputCost = (outputTokens / 1_000_000) * pricing.outputPer1M;
  return Math.round((inputCost + outputCost) * 1_000_000) / 1_000_000; // 6 decimal places
}

/**
 * Record an LLM call to the run's llm_calls JSONB and accumulate cost
 * Uses the record_llm_call Supabase RPC for atomicity
 */
export async function recordLlmCall(
  runId: string,
  entry: LlmCallEntry,
): Promise<void> {
  try {
    const supabase = getServiceClient();
    const { error } = await supabase.rpc("record_llm_call", {
      p_run_id: runId,
      p_provider: entry.provider,
      p_model: entry.model,
      p_input_tokens: entry.inputTokens,
      p_output_tokens: entry.outputTokens,
      p_cost_usd: entry.costUsd,
      p_latency_ms: entry.latencyMs,
    });

    if (error) {
      logger.error({ err: error, runId }, "record_llm_call_failed");
    }
  } catch (error) {
    logger.error({ err: error, runId }, "record_llm_call_exception");
  }
}
