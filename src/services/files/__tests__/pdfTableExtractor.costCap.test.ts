/**
 * Unit tests for the cost-cap fallback in `pdfTableExtractor`
 * (api-cost-guard-rails PR #2).
 *
 * Coverage matrix (one test per spec scenario from
 * `openspec/changes/cost-guard-rails/specs/pdf-table-extraction/spec.md`):
 *
 *   (a) pre-check `wouldHitDaily=true` → local + `mistral_disabled_today` + `provider: 'local'`
 *   (b) post-call `capHit='day'` → Mistral discarded, local persisted
 *   (c) `globalThis.__mistralOcrDisabledToday__` set → skips `checkCap`, calls local
 *   (d) `MISTRAL_OCR_ENABLED=false` → `TableExtractionProviderError`, local fallback
 *
 * Strategy: set `TABLE_EXTRACTION_PROVIDER=mistral` so the
 * orchestrator skips the local pass and goes straight to Mistral.
 * The local provider is NOT mocked (avoiding `mock.module`
 * pollution of the real module). The Mistral provider IS mocked
 * because the real one would attempt an HTTP call; we replace
 * the class with a deterministic fake that mirrors the real
 * provider's cost-cap wrap.
 *
 * The costService module is also mocked so the cap math is
 * controlled. Supabase client is mocked for the persistence path.
 */

import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  mock,
} from "bun:test";

// ---------------------------------------------------------------------------
// globalThis hooks for the cost-service mock
// ---------------------------------------------------------------------------

declare global {
  // eslint-disable-next-line no-var
  var __costCapTestCheckCap:
    | ((input: unknown) => Promise<unknown>)
    | undefined;
  // eslint-disable-next-line no-var
  var __costCapTestRecordApiCall:
    | ((input: unknown) => Promise<unknown>)
    | undefined;
  // eslint-disable-next-line no-var
  var __costCapTestIsProviderDisabled: ((provider: string) => boolean) | undefined;
  // eslint-disable-next-line no-var
  var __costCapTestError: Error | undefined;
}

function setCheckCap(
  fn: (input: unknown) => Promise<unknown> | unknown,
): void {
  globalThis.__costCapTestCheckCap = fn as never;
}

function setRecordApiCall(
  fn: (input: unknown) => Promise<unknown> | unknown,
): void {
  globalThis.__costCapTestRecordApiCall = fn as never;
}

function setIsProviderDisabled(
  fn: (provider: string) => boolean,
): void {
  globalThis.__costCapTestIsProviderDisabled = fn as never;
}

function setInjectedError(err: Error | undefined): void {
  globalThis.__costCapTestError = err;
}

// Mock costService before importing the SUT. The mock reads from
// globalThis so individual tests can swap behavior per-case.
mock.module("../../researchBrain/costService", () => {
  class MockCostCapExceededError extends Error {
    readonly scope: string;
    readonly provider: string;
    constructor(opts: { scope: string; provider: string }) {
      super(
        `Cost cap exceeded for ${opts.provider} (scope=${opts.scope})`,
      );
      this.name = "MockCostCapExceededError";
      this.scope = opts.scope;
      this.provider = opts.provider;
    }
  }
  return {
    CostCapExceededError: MockCostCapExceededError,
    checkCap: async (input: unknown) => {
      const fn = globalThis.__costCapTestCheckCap;
      if (!fn) {
        return {
          allowed: true,
          wouldHitDaily: false,
          wouldHitMonthly: false,
          wouldHitPerSource: false,
          wouldHitPerRun: false,
        };
      }
      return await fn(input);
    },
    recordApiCall: async (input: unknown) => {
      const fn = globalThis.__costCapTestRecordApiCall;
      if (!fn) {
        return {
          capHit: null,
          currentDailyCost: 0,
          currentMonthlyCost: 0,
          currentSourceCost: 0,
          currentRunCost: 0,
        };
      }
      return await fn(input);
    },
    isProviderDisabled: (provider: string) => {
      const fn = globalThis.__costCapTestIsProviderDisabled;
      if (!fn) return false;
      return fn(provider);
    },
    disableProviderToday: () => undefined,
    disableProviderThisMonth: () => undefined,
    resetDailyFlags: () => undefined,
    getCostConfig: () => ({
      mistralOcrDailyCapUsd: 50,
      mistralOcrMonthlyCapUsd: 1000,
      mistralOcrPerSourceCapUsd: 2,
      pubchemDailyRequestCap: 200_000,
      costAlertHardBlock: true,
      costAlertSoftThreshold: 0.8,
      mistralOcrEnabled: true,
      pubchemEnabled: true,
    }),
  };
});

// Minimal in-memory supabase mock that echoes INSERT payloads.
type Call = { method: string; args: unknown[] };
type Terminal =
  | { kind: "single"; data: unknown; error: unknown }
  | { kind: "many"; data: unknown[]; error: unknown };

const BUILDER_METHODS = [
  "from",
  "select",
  "insert",
  "update",
  "delete",
  "eq",
  "order",
];

const TERMINAL_METHODS = ["maybeSingle", "single"];

function scriptedMock(script: Terminal[], calls: Call[]) {
  let cursor = 0;
  let lastInsert: unknown[] = [];
  const target: any = {};
  const next = (): Terminal => {
    if (cursor >= script.length) {
      return { kind: "many", data: [], error: null };
    }
    return script[cursor++];
  };
  for (const method of BUILDER_METHODS) {
    target[method] = (...args: unknown[]) => {
      calls.push({ method, args });
      if (method === "insert") {
        lastInsert = args[0] as unknown[];
      }
      return target;
    };
  }
  for (const method of TERMINAL_METHODS) {
    target[method] = (...args: unknown[]) => {
      calls.push({ method, args });
      const t = next();
      if (t.kind === "single") {
        return Promise.resolve({ data: t.data, error: t.error });
      }
      return Promise.resolve({ data: t.data, error: t.error });
    };
  }
  Object.defineProperty(target, "then", {
    get() {
      return (onFulfilled: any, onRejected: any) => {
        calls.push({ method: "then", args: [] });
        const recentCall = calls.slice(-3);
        const hadInsert = recentCall.some((c) => c.method === "insert");
        if (hadInsert) {
          const echoed = (lastInsert as Array<Record<string, unknown>>).map(
            (row, i) => ({
              id: `mock-id-${i}`,
              ...row,
            }),
          );
          return Promise.resolve({ data: echoed, error: null }).then(
            onFulfilled,
            onRejected,
          );
        }
        const t = next();
        const data = t.kind === "single" ? t.data : t.data;
        return Promise.resolve({ data, error: t.error }).then(
          onFulfilled,
          onRejected,
        );
      };
    },
  });
  return target;
}

let calls: Call[];
let client: any;

// Force the orchestrator to skip the local pass and go straight
// to Mistral. The local provider is not mocked (avoiding
// `mock.module` pollution of `localPdfTableProvider.ts`).
let previousTableExtractionProvider: string | undefined;
previousTableExtractionProvider = process.env.TABLE_EXTRACTION_PROVIDER;
process.env.TABLE_EXTRACTION_PROVIDER = "mistral";
// Clear the cached mode so the new env takes effect.
delete (globalThis as any).__bioprospectingTableExtractionMode;

beforeEach(() => {
  calls = [];
  client = scriptedMock(
    [
      { kind: "many", data: [], error: null },
      { kind: "many", data: [], error: null },
      { kind: "many", data: [], error: null },
      { kind: "many", data: [], error: null },
      { kind: "many", data: [], error: null },
      { kind: "many", data: [], error: null },
      { kind: "many", data: [], error: null },
    ],
    calls,
  );
  setCheckCap(undefined);
  setRecordApiCall(undefined);
  setIsProviderDisabled(() => false);
  setInjectedError(undefined);
  // Reset env to allow Mistral to run by default.
  delete process.env.MISTRAL_OCR_ENABLED;
  process.env.MISTRAL_API_KEY = "test-key";
  // Reset globalThis disabled flags.
  (globalThis as any).__mistralOcrDisabledToday__ = false;
  (globalThis as any).__mistralOcrDisabledThisMonth__ = false;
  // Reset the Mistral provider's enabled-flag cache.
  delete (globalThis as any).__mistralOcrEnabled__;
  // Reset fetch mock state.
  fetchCalls.length = 0;
  fetchResponse = {
    ok: true,
    status: 200,
    body: JSON.stringify({
      pages: [
        {
          index: 0,
          markdown: "row1\nrow2",
          tables: [
            {
              headers: ["A", "B"],
              rows: [["x", "y"]],
              bbox: { x: 0, y: 0, w: 100, h: 50 },
              confidence: 0.9,
            },
          ],
        },
      ],
    }),
  };
  (globalThis as any).fetch = mockFetch;
});

afterEach(() => {
  setCheckCap(undefined);
  setRecordApiCall(undefined);
  setIsProviderDisabled(undefined);
  setInjectedError(undefined);
  (globalThis as any).__mistralOcrDisabledToday__ = false;
  (globalThis as any).__mistralOcrDisabledThisMonth__ = false;
  delete (globalThis as any).__mistralOcrEnabled__;
  // Restore env defaults so subsequent tests aren't polluted.
  delete process.env.MISTRAL_OCR_COST_PER_PAGE_USD;
  delete process.env.MISTRAL_OCR_ENABLED;
  delete process.env.MISTRAL_API_KEY;
  if (previousTableExtractionProvider === undefined) {
    delete process.env.TABLE_EXTRACTION_PROVIDER;
  } else {
    process.env.TABLE_EXTRACTION_PROVIDER = previousTableExtractionProvider;
  }
  previousTableExtractionProvider = undefined;
  delete (globalThis as any).__bioprospectingTableExtractionMode;
  (globalThis as any).fetch = realFetch;
});

mock.module("../../../db/client", () => ({
  getServiceClient: () => client,
  getAnonClient: () => client,
  getSupabaseClient: () => client,
  resetClients: () => undefined,
  default: () => client,
}));

// We do NOT mock the Mistral provider here. Instead we stub
// `globalThis.fetch` so the real provider's HTTP call returns a
// scripted response, and let the real provider's cost-cap wrap run
// against the mocked `costService` (registered above). This avoids
// `mock.module` pollution of `mistralOcrProvider.ts` — the real
// implementation is reused across this test file and the dedicated
// `mistralOcrProvider.costWrap.test.ts`.

const fetchCalls: Array<{ url: string; init: RequestInit }> = [];
let fetchResponse: { ok: boolean; status: number; body: string } = {
  ok: true,
  status: 200,
  body: JSON.stringify({ pages: [] }),
};

const realFetch = globalThis.fetch;
const mockFetch = (async (
  url: string | URL | Request,
  init?: RequestInit,
) => {
  const u = typeof url === "string" ? url : url.toString();
  fetchCalls.push({ url: u, init: init ?? {} });
  return {
    ok: fetchResponse.ok,
    status: fetchResponse.status,
    async text() {
      return fetchResponse.body;
    },
    async json() {
      return JSON.parse(fetchResponse.body);
    },
  } as unknown as Response;
}) as typeof fetch;

// SUT
const SUT = await import("../pdfTableExtractor");
const { extractPDFTables } = SUT;
const { MistralTableExtractionProvider } = await import(
  "../providers/mistralOcrProvider"
);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makePdf(bytes = 100_000): Uint8Array {
  return new Uint8Array(bytes);
}

const SOURCE_ID = "00000000-0000-0000-0000-0000000000aa";
const RUN_ID = "00000000-0000-0000-0000-0000000000b1";

// ---------------------------------------------------------------------------
// (a) Pre-check wouldHitDaily=true → local + mistral_disabled_today
// ---------------------------------------------------------------------------

describe("pdfTableExtractor.costCap — (a) pre-check wouldHitDaily=true", () => {
  it("falls back to local with provider='local'", async () => {
    setCheckCap(async () => ({
      allowed: false,
      wouldHitDaily: true,
      wouldHitMonthly: false,
      wouldHitPerSource: false,
      wouldHitPerRun: false,
    }));

    const result = await extractPDFTables(
      SOURCE_ID,
      makePdf(),
      { runId: RUN_ID, sourceId: SOURCE_ID },
    );

    // The orchestrator's pre-check (NOT the provider's) short-
    // circuits to local. In `mistral` mode the local pass was
    // skipped, so `localTables` is empty and the fallback returns
    // an empty local result with `provider: 'local'`. (The auto-
    // mode local-fallback-with-persistence path is covered
    // separately in `bioprospectingExtractor.tables.test.ts`.)
    expect(result.provider).toBe("local");
  });
});

// ---------------------------------------------------------------------------
// (b) Post-call capHit='day' → Mistral discarded, local persisted
// ---------------------------------------------------------------------------

describe("pdfTableExtractor.costCap — (b) post-call capHit='day'", () => {
  it("throws CostCapExceededError from mistral; orchestrator falls back to local", async () => {
    setCheckCap(async () => ({
      allowed: true,
      wouldHitDaily: false,
      wouldHitMonthly: false,
      wouldHitPerSource: false,
      wouldHitPerRun: false,
    }));
    setRecordApiCall(async () => ({
      capHit: "day",
      currentDailyCost: 50.05,
      currentMonthlyCost: 200,
      currentSourceCost: 0.1,
      currentRunCost: 0.05,
    }));

    const result = await extractPDFTables(
      SOURCE_ID,
      makePdf(),
      { runId: RUN_ID, sourceId: SOURCE_ID },
    );

    // The cost-cap catch path runs when the provider throws
    // `CostCapExceededError`. In `mistral` mode the local provider
    // is not called, so the fallback returns an empty local result.
    // (In `auto` mode the local pass would have run first and the
    // local fallback would persist localTables; that branch is
    // exercised by the existing auto-mode tests.)
    expect(result.provider).toBe("local");
  });
});

// ---------------------------------------------------------------------------
// (c) globalThis.__mistralOcrDisabledToday__ set → skip checkCap, local
// ---------------------------------------------------------------------------

describe("pdfTableExtractor.costCap — (c) globalThis flag set", () => {
  it("short-circuits to local without calling checkCap", async () => {
    setIsProviderDisabled((p) => p === "mistral_ocr");

    let checkCapCalls = 0;
    setCheckCap(async () => {
      checkCapCalls++;
      return {
        allowed: true,
        wouldHitDaily: false,
        wouldHitMonthly: false,
        wouldHitPerSource: false,
        wouldHitPerRun: false,
      };
    });

    const result = await extractPDFTables(
      SOURCE_ID,
      makePdf(),
      { runId: RUN_ID, sourceId: SOURCE_ID },
    );

    expect(result.provider).toBe("local");
    expect(checkCapCalls).toBe(0);
    // The pre-check was skipped; no Mistral HTTP was made. The
    // short-circuit returns the local-fallback shape with no
    // inserted rows (the local provider wasn't called in `mistral`
    // mode, so `localTables` is empty).
  });
});

// ---------------------------------------------------------------------------
// (d) MISTRAL_OCR_ENABLED=false → TableExtractionProviderError → local
// ---------------------------------------------------------------------------

describe("pdfTableExtractor.costCap — (d) MISTRAL_OCR_ENABLED=false", () => {
  it("provider throws TableExtractionProviderError; orchestrator falls back to local", async () => {
    // Set the env BEFORE clearing the provider's enabled cache so
    // the real `getEnabledFlag` short-circuits at the start of
    // `extract`.
    process.env.MISTRAL_OCR_ENABLED = "false";
    delete (globalThis as any).__mistralOcrEnabled__;

    const result = await extractPDFTables(
      SOURCE_ID,
      makePdf(),
      { runId: RUN_ID, sourceId: SOURCE_ID },
    );

    // The provider's `extract` throws `TableExtractionProviderError`
    // because the env is `false`. The orchestrator's catch path
    // (non-cost-cap) runs; in `mistral` mode with no local pass,
    // the fallback returns an empty local result.
    expect(result.provider).toBe("local");
    // No fetch was attempted.
    expect(fetchCalls.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Bonus: estimatePages / costPerPageUsd are exposed on the provider
// ---------------------------------------------------------------------------

describe("MistralTableExtractionProvider — cost-cap helpers", () => {
  it("estimatePages uses ceil(byteLength / 100_000)", () => {
    expect(MistralTableExtractionProvider.estimatePages(makePdf(0))).toBe(1);
    expect(MistralTableExtractionProvider.estimatePages(makePdf(1))).toBe(1);
    expect(MistralTableExtractionProvider.estimatePages(makePdf(100_000))).toBe(1);
    expect(MistralTableExtractionProvider.estimatePages(makePdf(100_001))).toBe(2);
    expect(MistralTableExtractionProvider.estimatePages(makePdf(500_000))).toBe(5);
    expect(MistralTableExtractionProvider.estimatePages(makePdf(5_000_000))).toBe(50);
  });

  it("costPerPageUsd returns the default 0.05 when env unset", () => {
    delete process.env.MISTRAL_OCR_COST_PER_PAGE_USD;
    expect(MistralTableExtractionProvider.costPerPageUsd()).toBe(0.05);
  });

  it("costPerPageUsd honors MISTRAL_OCR_COST_PER_PAGE_USD env override", () => {
    process.env.MISTRAL_OCR_COST_PER_PAGE_USD = "0.10";
    expect(MistralTableExtractionProvider.costPerPageUsd()).toBe(0.10);
  });
});
