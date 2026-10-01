import { supabase } from "./supabaseClient";

const API_BASE_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3000";

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const {
    data: { session },
  } = await supabase.auth.getSession();
  if (!session) {
    throw new Error("Not signed in.");
  }

  const response = await fetch(`${API_BASE_URL}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${session.access_token}`,
      ...init?.headers,
    },
  });
  const body = await response.json().catch(() => null);
  if (!response.ok) {
    const message = body?.message ?? body?.error ?? `Request failed: ${response.status}`;
    throw new Error(message);
  }
  return body as T;
}

export interface ProtectionStatus {
  accountId: string;
  protectionOn: boolean;
  botCanOpenNewTrades: boolean;
  walletNeedsAttention: boolean;
  blockingReason: string | null;
  maxLossToday: string;
  lossUsedToday: string;
  lastVerifiedAt: string;
}

export interface CreateAccountInput {
  accountId: string;
  ownerUserId: string;
  venue?: string;
  initialEquity: string;
  initialRules: Array<{ ruleType: string; param: string }>;
  /** EVM-chain venues only (e.g. "arbitrum-gmx") - your own wallet address and which chain to provision a Safe on. Both required together. */
  evmOwnerWalletAddress?: string;
  evmChainId?: number;
}

export interface ReconcileResult {
  accountId: string;
  currentEquity: string;
  openNotional: string;
  leverage: string;
  peakEquity: string;
}

export interface DryRunOrderInput {
  clientIntentId: string;
  accountId: string;
  coin: string;
  side: "BUY" | "SELL";
  size: string;
  price: string;
  reduceOnly?: boolean;
}

export interface ProtectedAccountSummary {
  accountId: string;
  ownerUserId: string;
  venue: string;
  protectionEnabled: boolean;
  createdAt: string;
  agentWalletAddress: string | null;
  evmSafeAddress?: string | null;
}

export interface RuleVersion {
  id: string;
  accountId: string;
  ruleType: string;
  param: string;
  effectiveFrom: string;
  isActive: boolean;
  createdAt: string;
}

export interface DryRunOrderResult {
  mock: boolean;
  decision: { outcome: "ALLOW" | "RESIZE" | "BLOCK"; reasonCode: string; message: string };
  mockSignedAction: {
    connectionId: string;
    mockSignature: string;
    mockSignerAddress: string;
    expiresAt: string;
  } | null;
}

export interface SubmitOrderResult {
  submitted: boolean;
  decision: { outcome: "ALLOW" | "RESIZE" | "BLOCK"; reasonCode: string; message: string };
  signedAction: {
    connectionId: string;
    signature: string;
    signerAddress: string;
    expiresAt: string;
  } | null;
  orderId: string;
  venueOrderId: string | null;
}

export const api = {
  createAccount: (input: CreateAccountInput) =>
    request<{ accountId: string; protectionOn: boolean; agentWalletAddress: string | null; evmSafeAddress?: string | null }>(
      "/v1/accounts",
      { method: "POST", body: JSON.stringify(input) },
    ),

  getProtection: (accountId: string) => request<ProtectionStatus>(`/v1/protection/${accountId}`),

  activateProtection: (accountId: string) =>
    request<{ accountId: string; protectionOn: boolean }>("/v1/protection/activate", {
      method: "POST",
      body: JSON.stringify({ accountId }),
    }),

  deactivateProtection: (accountId: string) =>
    request<{ accountId: string; protectionOn: boolean; drainedOutstandingRisk: boolean }>(
      "/v1/protection/deactivate",
      { method: "POST", body: JSON.stringify({ accountId }) },
    ),

  reconcile: (accountId: string, venueAddress: string) =>
    request<ReconcileResult>(`/v1/accounts/${accountId}/reconcile`, {
      method: "POST",
      body: JSON.stringify({ venueAddress }),
    }),

  dryRunOrder: (input: DryRunOrderInput) =>
    request<DryRunOrderResult>("/v1/execution/dry-run", {
      method: "POST",
      body: JSON.stringify(input),
    }),

  // The only call in this client that can move real money. Reaches
  // Hyperliquid when the API server has ENABLE_REAL_SIGNER and
  // ENABLE_VENUE_SUBMISSION on - it's still risk-checked and reserved first,
  // same as dry-run, but a real venue order id back means it actually happened.
  submitOrder: (input: DryRunOrderInput) =>
    request<SubmitOrderResult>("/v1/execution/submit", {
      method: "POST",
      body: JSON.stringify(input),
    }),

  // The API derives ownerUserId from the authenticated bearer token, not a
  // query param - this always lists the signed-in user's own accounts.
  listAccounts: () => request<{ accounts: ProtectedAccountSummary[] }>("/v1/accounts"),

  listRules: (accountId: string) =>
    request<{ rules: RuleVersion[] }>(`/v1/accounts/${encodeURIComponent(accountId)}/rules`),

  addRule: (accountId: string, ruleType: string, param: string) =>
    request<{ rule: RuleVersion }>(`/v1/accounts/${encodeURIComponent(accountId)}/rules`, {
      method: "POST",
      body: JSON.stringify({ ruleType, param }),
    }),

  deactivateRule: (accountId: string, ruleId: string) =>
    // Fastify's JSON body parser rejects an empty body when Content-Type is
    // application/json (which `request()` always sets) - this route needs
    // no input, but still needs a real (even empty) JSON body to parse.
    request<{ ruleId: string; isActive: false }>(
      `/v1/accounts/${encodeURIComponent(accountId)}/rules/${encodeURIComponent(ruleId)}/deactivate`,
      { method: "POST", body: "{}" },
    ),
};
