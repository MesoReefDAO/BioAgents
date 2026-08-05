/**
 * Unit tests for the admin privy-users route
 *
 * Coverage matrix:
 *   1. Admin caller → 200, response includes merged users
 *   2. Non-admin caller → 401/403
 *   3. Search filters results
 *   4. Pagination works correctly
 *   5. Privy API failure → 502
 *   6. Supabase failure → 500 (graceful degradation)
 *   7. Privy not configured → 503
 */

// Set the auth env vars BEFORE any module is imported so the
// `getAuthConfig()` call inside the authResolver reads the right values.
process.env.AUTH_MODE = "jwt";
process.env.BIOAGENTS_SECRET =
  process.env.BIOAGENTS_SECRET || "test-jwt-secret-for-privy-users-tests";

// @privy-io/server-auth throws if window is defined (browser environment check)
// We need to ensure window is not defined before loading the module
const originalWindow = globalThis.window;
delete (globalThis as any).window;

import { describe, it, expect, beforeAll, beforeEach, mock } from "bun:test";

// ---------------------------------------------------------------------------
// Mocks — DB client and Privy client
// ---------------------------------------------------------------------------

type Call = { method: string; args: unknown[]; table?: string };
type Terminal =
  | { kind: "single"; data: unknown; error: unknown }
  | { kind: "many"; data: unknown[]; error: unknown };

const BUILDER_METHODS = [
  "from",
  "select",
  "eq",
  "gte",
  "lte",
  "lt",
  "gt",
  "order",
  "in",
];

declare global {
  // eslint-disable-next-line no-var
  var __privyUsersTestClient: (() => any) | undefined;
  // eslint-disable-next-line no-var
  var __privyUsersTestPrivyClient: (() => any) | undefined;
}

function setMockServiceClient(factory: () => any) {
  globalThis.__privyUsersTestClient = factory;
}

function setMockPrivyClient(factory: () => any) {
  globalThis.__privyUsersTestPrivyClient = factory;
}

function scriptedQueryClient(script: Terminal[]): any {
  const calls: Call[] = [];
  let cursor = 0;
  const builder: any = {};
  for (const m of BUILDER_METHODS) {
    builder[m] = (...args: unknown[]) => {
      calls.push({ method: m, args });
      return builder;
    };
  }
  Object.defineProperty(builder, "then", {
    get() {
      return (onFulfilled: any) => {
        calls.push({ method: "then", args: [] });
        const t = script[cursor++] ?? { kind: "many", data: [], error: null };
        const data = t.kind === "single" ? t.data : t.data;
        const error = t.error;
        return Promise.resolve({ data, error }).then(onFulfilled);
      };
    },
  });
  return { client: builder, calls };
}

// Mock the DB client
mock.module("../../../db/client", () => ({
  getServiceClient: () =>
    (globalThis.__privyUsersTestClient ?? (() => null))(),
  getAnonClient: () =>
    (globalThis.__privyUsersTestClient ?? (() => null))(),
  getSupabaseClient: () =>
    (globalThis.__privyUsersTestClient ?? (() => null))(),
  resetClients: () => undefined,
  default: () =>
    (globalThis.__privyUsersTestClient ?? (() => null))(),
}));

// Mock the privy-auth module entirely to avoid importing @privy-io/server-auth
mock.module("../../../services/privy-auth", () => ({
  getPrivyClient: () =>
    (globalThis.__privyUsersTestPrivyClient ?? (() => null))(),
  isPrivyConfigured: () => true,
  isCoralGptEnabled: () => true,
  verifyPrivyAccessToken: async () => ({ userId: "mock" }),
  fetchPrivyUser: async () => ({}),
}));

// SUT import (post-mock)
import { privyUsersRoute } from "../privy-users";
import { generateTestJWT } from "../../../services/jwt";

let adminToken: string;
let userToken: string;

beforeAll(async () => {
  adminToken = await generateTestJWT({
    sub: "00000000-0000-0000-0000-0000000000a1",
    role: "admin",
  });
  userToken = await generateTestJWT({
    sub: "00000000-0000-0000-0000-0000000000a2",
    role: "user",
  });
});

beforeEach(() => {
  setMockServiceClient(null);
  setMockPrivyClient(null);
});

// Mock Privy users data — matches Privy SDK User type shape
const mockPrivyUsers = [
  {
    id: "did:privy:user1",
    email: { address: "alice@example.com" },
    wallet: { address: "0x1234567890abcdef1234567890abcdef12345678" },
    createdAt: new Date("2026-01-15T10:00:00Z"),
    isGuest: false,
  },
  {
    id: "did:privy:user2",
    email: { address: "bob@example.com" },
    wallet: null,
    createdAt: new Date("2026-02-20T14:30:00Z"),
    isGuest: true,
  },
  {
    id: "did:privy:user3",
    email: null,
    wallet: { address: "0xabcdef1234567890abcdef1234567890abcdef12" },
    createdAt: new Date("2026-03-10T08:15:00Z"),
    isGuest: false,
  },
];

// Mock local users data
const mockLocalUsers = [
  { user_id: "did:privy:user1", id: "local-uuid-1", access_type: "whitelisted" },
  { user_id: "did:privy:user2", id: "local-uuid-2", access_type: null },
];

async function invokeAs(
  token: string,
  query: Record<string, string>,
) {
  return await privyUsersRoute.handle(
    new Request(
      "http://test/api/admin/privy-users?" +
        new URLSearchParams(query).toString(),
      {
        method: "GET",
        headers: { Authorization: `Bearer ${token}` },
      },
    ),
  );
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("privy-users route", () => {
  it("admin caller gets merged users with correct structure", async () => {
    // Mock Privy client — getUsers() returns User[] directly
    setMockPrivyClient(() => ({
      getUsers: async () => mockPrivyUsers,
    }));

    // Mock Supabase client
    const { client } = scriptedQueryClient([
      {
        kind: "many",
        data: mockLocalUsers,
        error: null,
      },
    ]);
    setMockServiceClient(() => client);

    const res = await invokeAs(adminToken, {});
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      users: any[];
      total: number;
      page: number;
      limit: number;
    };

    expect(body.users).toHaveLength(3);
    expect(body.total).toBe(3);
    expect(body.page).toBe(0);
    expect(body.limit).toBe(50);

    // First user has local account and is whitelisted
    const alice = body.users.find((u: any) => u.email === "alice@example.com");
    expect(alice).toBeTruthy();
    expect(alice.hasAccount).toBe(true);
    expect(alice.whitelisted).toBe(true);
    expect(alice.localUserId).toBe("local-uuid-1");

    // Second user has local account but is not whitelisted
    const bob = body.users.find((u: any) => u.email === "bob@example.com");
    expect(bob).toBeTruthy();
    expect(bob.hasAccount).toBe(true);
    expect(bob.whitelisted).toBe(false);
    expect(bob.localUserId).toBe("local-uuid-2");

    // Third user has no local account
    const charlie = body.users.find((u: any) => u.email === null);
    expect(charlie).toBeTruthy();
    expect(charlie.hasAccount).toBe(false);
    expect(charlie.whitelisted).toBe(false);
    expect(charlie.localUserId).toBeNull();
  });

  it("non-admin caller is rejected", async () => {
    const res = await invokeAs(userToken, {});
    expect([401, 403]).toContain(res.status);
  });

  it("missing auth is rejected", async () => {
    const res = await privyUsersRoute.handle(
      new Request("http://test/api/admin/privy-users", {
        method: "GET",
      }),
    );
    expect([401, 403]).toContain(res.status);
  });

  it("search param is passed to Privy client", async () => {
    let receivedSearch: string | undefined;
    setMockPrivyClient(() => ({
      getUsers: async (searchTerm?: string) => {
        receivedSearch = searchTerm;
        return [];
      },
    }));

    const { client } = scriptedQueryClient([
      { kind: "many", data: [], error: null },
    ]);
    setMockServiceClient(() => client);

    const res = await invokeAs(adminToken, { search: "alice" });
    expect(res.status).toBe(200);
    expect(receivedSearch).toBe("alice");
  });

  it("pagination params are used for client-side slicing", async () => {
    setMockPrivyClient(() => ({
      getUsers: async () => mockPrivyUsers,
    }));

    const { client } = scriptedQueryClient([
      { kind: "many", data: mockLocalUsers, error: null },
    ]);
    setMockServiceClient(() => client);

    // page=0, limit=2 should return only first 2 users
    const res = await invokeAs(adminToken, { page: "0", limit: "2" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { users: any[]; total: number };
    expect(body.users).toHaveLength(2);
    expect(body.total).toBe(3); // total is still all users
  });

  it("Privy API failure returns 502", async () => {
    setMockPrivyClient(() => ({
      getUsers: async () => {
        throw new Error("Privy API error: rate limited");
      },
    }));

    const res = await invokeAs(adminToken, {});
    expect(res.status).toBe(502);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("Failed to fetch users from Privy");
  });

  it("Supabase failure degrades gracefully (returns empty local data)", async () => {
    setMockPrivyClient(() => ({
      getUsers: async () => mockPrivyUsers,
    }));

    // Supabase query fails
    const { client } = scriptedQueryClient([
      {
        kind: "many",
        data: null,
        error: { message: "DB connection failed" },
      },
    ]);
    setMockServiceClient(() => client);

    const res = await invokeAs(adminToken, {});
    // Should still return 200 with users, just no local cross-reference
    expect(res.status).toBe(200);
    const body = (await res.json()) as { users: any[] };
    expect(body.users).toHaveLength(3);
    // All users should have hasAccount: false since local query failed
    expect(body.users.every((u: any) => u.hasAccount === false)).toBe(true);
  });

  it("Privy not configured returns 503", async () => {
    setMockPrivyClient(() => null);

    const res = await invokeAs(adminToken, {});
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("Privy is not configured");
  });

  it("limit is capped at MAX_PAGE_SIZE", async () => {
    setMockPrivyClient(() => ({
      getUsers: async () => mockPrivyUsers,
    }));

    const { client } = scriptedQueryClient([
      { kind: "many", data: mockLocalUsers, error: null },
    ]);
    setMockServiceClient(() => client);

    // Request limit > MAX_PAGE_SIZE (100) — should be capped
    const res = await invokeAs(adminToken, { limit: "200" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { users: any[]; limit: number };
    expect(body.limit).toBe(100);
    // Only 3 users exist, so we get 3 even with limit=100
    expect(body.users).toHaveLength(3);
  });

  it("negative page is normalized to 0", async () => {
    setMockPrivyClient(() => ({
      getUsers: async () => mockPrivyUsers,
    }));

    const { client } = scriptedQueryClient([
      { kind: "many", data: mockLocalUsers, error: null },
    ]);
    setMockServiceClient(() => client);

    const res = await invokeAs(adminToken, { page: "-5" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { page: number };
    expect(body.page).toBe(0);
  });
});

// Restore window after tests complete
globalThis.window = originalWindow;
