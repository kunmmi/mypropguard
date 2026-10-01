import { describe, expect, it } from "vitest";
import { Decimal } from "decimal.js";
import { RuleType } from "@mypropguard/domain";
import { InMemoryExecutionSequencer, FakeSignerGateway, PlaceholderActionHasher } from "@mypropguard/execution";
import { InMemoryRiskLedgerStore, buildAccountRiskHead, buildRuleVersion } from "@mypropguard/test-fixtures";
import { buildApp, type AppDeps } from "../src/app.js";

/**
 * Stand-in for createAuthPreHandler: real production wiring hits Supabase's
 * auth server (see src/auth.ts) - these tests don't need that network call,
 * only the contract every route relies on: a valid bearer token sets
 * request.userId, a missing/wrong one gets rejected before any handler runs.
 */
function fakeAuthPreHandler(validTokenToUserId: Record<string, string>): AppDeps["authPreHandler"] {
  return async (request, reply) => {
    const header = request.headers.authorization;
    const token = header?.startsWith("Bearer ") ? header.slice("Bearer ".length) : null;
    const userId = token ? validTokenToUserId[token] : undefined;
    if (!userId) {
      return reply.status(401).send({ error: "UNAUTHORIZED", message: "Invalid or expired token." });
    }
    request.userId = userId;
  };
}

function seedOwnedAccount(store: InMemoryRiskLedgerStore, accountId: string, ownerUserId: string) {
  store.seedAccountRiskHead(buildAccountRiskHead({ accountId }));
  store.seedRules(accountId, [buildRuleVersion(RuleType.MAX_POSITION_SIZE, 100_000)]);
  store.seedAccount({
    accountId,
    ownerUserId,
    venue: "hyperliquid",
    protectionEnabled: false,
    createdAt: new Date(),
    agentWalletId: null,
    agentWalletAddress: null,
    evmOwnerWalletAddress: null,
    evmSafeAddress: null,
    evmChainId: null,
  });
}

describe("authentication", () => {
  it("rejects any request with no bearer token when auth is configured", async () => {
    const store = new InMemoryRiskLedgerStore();
    const app = buildApp({ store, authPreHandler: fakeAuthPreHandler({}) });

    const response = await app.inject({ method: "GET", url: "/v1/accounts" });
    expect(response.statusCode).toBe(401);
  });

  it("rejects an invalid/expired bearer token", async () => {
    const store = new InMemoryRiskLedgerStore();
    const app = buildApp({ store, authPreHandler: fakeAuthPreHandler({ good_token: "user_1" }) });

    const response = await app.inject({
      method: "GET",
      url: "/v1/accounts",
      headers: { authorization: "Bearer wrong_token" },
    });
    expect(response.statusCode).toBe(401);
  });

  it("accepts a valid bearer token and lists only that user's own accounts, ignoring any ownerUserId query param", async () => {
    const store = new InMemoryRiskLedgerStore();
    seedOwnedAccount(store, "acct_mine", "user_1");
    seedOwnedAccount(store, "acct_someone_elses", "user_2");
    const app = buildApp({ store, authPreHandler: fakeAuthPreHandler({ good_token: "user_1" }) });

    const response = await app.inject({
      method: "GET",
      url: "/v1/accounts?ownerUserId=user_2", // attempt to list someone else's accounts via the query param
      headers: { authorization: "Bearer good_token" },
    });

    expect(response.statusCode).toBe(200);
    const accountIds = response.json().accounts.map((a: { accountId: string }) => a.accountId);
    expect(accountIds).toEqual(["acct_mine"]);
  });
});

describe("account ownership enforcement", () => {
  it("creates a new account under the authenticated user, ignoring a spoofed ownerUserId in the request body", async () => {
    const store = new InMemoryRiskLedgerStore();
    const app = buildApp({ store, authPreHandler: fakeAuthPreHandler({ good_token: "user_1" }) });

    const response = await app.inject({
      method: "POST",
      url: "/v1/accounts",
      headers: { authorization: "Bearer good_token" },
      payload: {
        accountId: "acct_new",
        ownerUserId: "someone_else", // spoofed - must be ignored
        initialEquity: "10000",
        initialRules: [],
      },
    });

    expect(response.statusCode).toBe(201);
    const account = await store.findAccountById("acct_new");
    expect(account?.ownerUserId).toBe("user_1");
  });

  it("returns 403 when a user tries to read another user's account rules", async () => {
    const store = new InMemoryRiskLedgerStore();
    seedOwnedAccount(store, "acct_other_user", "user_2");
    const app = buildApp({ store, authPreHandler: fakeAuthPreHandler({ good_token: "user_1" }) });

    const response = await app.inject({
      method: "GET",
      url: "/v1/accounts/acct_other_user/rules",
      headers: { authorization: "Bearer good_token" },
    });

    expect(response.statusCode).toBe(403);
  });

  it("returns 403 when a user tries to run a dry-run order against another user's account", async () => {
    const store = new InMemoryRiskLedgerStore();
    seedOwnedAccount(store, "acct_other_user_2", "user_2");
    const hasher = new PlaceholderActionHasher();
    const app = buildApp({
      store,
      executionSequencer: new InMemoryExecutionSequencer(),
      hasher,
      signer: new FakeSignerGateway(hasher),
      authPreHandler: fakeAuthPreHandler({ good_token: "user_1" }),
    });

    const response = await app.inject({
      method: "POST",
      url: "/v1/execution/dry-run",
      headers: { authorization: "Bearer good_token" },
      payload: {
        clientIntentId: "hijack_attempt",
        accountId: "acct_other_user_2",
        coin: "BTC",
        side: "BUY",
        size: "1",
        price: "50000",
      },
    });

    expect(response.statusCode).toBe(403);
  });

  it("returns 403 when a user tries to cancel an order belonging to another user's account", async () => {
    const store = new InMemoryRiskLedgerStore();
    seedOwnedAccount(store, "acct_victim", "user_2");
    const app = buildApp({ store, authPreHandler: fakeAuthPreHandler({ good_token: "user_1", victim_token: "user_2" }) });

    const created = await app.inject({
      method: "POST",
      url: "/v1/orders",
      headers: { authorization: "Bearer victim_token" },
      payload: {
        clientIntentId: "victim_intent",
        accountId: "acct_victim",
        coin: "BTC",
        side: "BUY",
        size: "1",
        price: "50000",
        orderStyle: "MARKET",
        reduceOnly: false,
      },
    });
    const orderId = created.json().orderId;

    const cancel = await app.inject({
      method: "POST",
      url: `/v1/orders/${orderId}/cancel`,
      headers: { authorization: "Bearer good_token" },
    });

    expect(cancel.statusCode).toBe(403);
  });

  it("allows the real owner to act on their own account normally", async () => {
    const store = new InMemoryRiskLedgerStore();
    seedOwnedAccount(store, "acct_owned", "user_1");
    const app = buildApp({ store, authPreHandler: fakeAuthPreHandler({ good_token: "user_1" }) });

    const response = await app.inject({
      method: "GET",
      url: "/v1/accounts/acct_owned/rules",
      headers: { authorization: "Bearer good_token" },
    });

    expect(response.statusCode).toBe(200);
  });
});
