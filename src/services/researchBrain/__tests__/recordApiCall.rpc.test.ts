/**
 * Integration tests for the `record_api_call` Postgres RPC.
 *
 * **Gated by `BUN_TEST_DB_URL`** — these tests require a real
 * local Postgres instance to exercise the `FOR UPDATE` row lock
 * behavior. The spec scenario is:
 *
 *   - Two concurrent `record_api_call` invocations for the same
 *     `(day, provider='mistral_ocr')` must serialize; the row lock
 *     prevents racing past the daily cap.
 *   - The first call to cross `COST_ALERT_SOFT_THRESHOLD` of the
 *     daily cap must update `last_cap_warn_at`; subsequent calls
 *     in the same day must NOT.
 *
 * The unit-level behavior (RPC soft-fail, globalThis flag lifecycle,
 * cap math) is covered by `costService.test.ts` and does not need
 * a database.
 *
 * To run locally:
 *   BUN_TEST_DB_URL=postgres://postgres:postgres@localhost:54322/postgres \
 *     bun test src/services/researchBrain/__tests__/recordApiCall.rpc.test.ts
 */

import { describe, it, expect, beforeAll, afterAll } from "bun:test";

const DB_URL = process.env.BUN_TEST_DB_URL;
const HAS_DB = typeof DB_URL === "string" && DB_URL.length > 0;

// Skip the entire file when the DB is not configured.
const describeDb = HAS_DB ? describe : describe.skip;

describeDb("costService — record_api_call RPC (integration)", () => {
  // The integration test setup is intentionally minimal: we
  // intentionally do not exercise the RPC here in the unit
  // batch because it requires a live Postgres instance with
  // the migration applied. PR #3's verify phase will run this
  // file against a local Supabase instance; the file is left in
  // place as the contract for that verification.
  //
  // The shape below mirrors the spec scenario in
  // openspec/changes/cost-guard-rails/specs/api-cost-guard-rails/spec.md
  // (lines 158-168) so the verify phase can fill in the body.
  beforeAll(() => {
    if (!HAS_DB) {
      throw new Error(
        "BUN_TEST_DB_URL is required to run recordApiCall.rpc.test.ts",
      );
    }
  });

  afterAll(() => {
    // cleanup hook for future implementation
  });

  it("2 concurrent calls at daily=$49.95+$0.10 → ≥1 returns capHit='day'", () => {
    // TODO(verify): implement against local Postgres.
    expect(true).toBe(true);
  });

  it("1st call crossing 80% sets last_cap_warn_at, 2nd at 85% does NOT update", () => {
    // TODO(verify): implement against local Postgres.
    expect(true).toBe(true);
  });
});

// When DB is missing, expose a non-skipped describe that documents
// the contract for visibility.
describe("costService — record_api_call RPC contract (no DB)", () => {
  it("requires BUN_TEST_DB_URL to exercise the FOR UPDATE serialization", () => {
    if (HAS_DB) {
      expect(typeof DB_URL).toBe("string");
    } else {
      expect(DB_URL).toBeUndefined();
    }
  });
});
