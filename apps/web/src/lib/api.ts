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
  /** Hyperliquid accounts: your own Hyperliquid address, which the watcher reads. */
  venueAddress?: string;
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
  venueAddress?: string | null;
}

export interface EnforcementAction {
  at: string;
  mode: "log" | "enforce";
  kind: "LOCK" | "UNLOCK" | "CANCEL" | "TRIM" | "WARNING";
  coin: string | null;
  result: "WOULD_DO" | "DONE" | "FAILED" | "INFO";
  detail: Record<string, unknown>;
  error: string | null;
}

export interface EnforcementStatus {
  watcherMode: "off" | "log" | "enforce";
  lockedToday: boolean;
  lockedDay: string | null;
  reason: string | null;
  lockedAt: string | null;
  ceilings: Record<string, string>;
  actions: EnforcementAction[];
}

export interface RuleVersion {
  id: string;
  accountId: string;
  ruleType: string;
  param: string;
  tokenAddress?: string | null;
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

export interface OneClickTransaction {
  to: string;
  data: string;
  value: string;
}

export interface OneClickStatus {
  available: boolean;
  /** "off" until enabled once; "revoked" after it was switched off. */
  status: "off" | "pending" | "enabled" | "revoked";
  sessionKeyAddress: string | null;
  guardIsCurrent: boolean;
  gasWalletLow: boolean;
  links: Array<{ topic: string; name: string | null; url: string | null; linkedAt: string; expiresAt: string | null }>;
  trades: Array<{ at: string; site: string | null; to: string | null; valueWei: string | null; txHash: string | null; result: "SENT" | "REFUSED" | "ERROR"; message: string | null }>;
}

export interface FloatLimitsView {
  maxBuyPct: number;
  dailySpendPct: number;
  maxBuysPerDay: number;
  cooldownSec: number;
  frozen: boolean;
}

export interface FloatStatus {
  available: boolean;
  exists: boolean;
  nativeSymbol: string;
  chainId: number;
  address?: string;
  status?: "active" | "off";
  limits?: FloatLimitsView;
  /** The account's own MyPropGuard rules that also apply to this wallet's buys. */
  accountRules?: { maxTradesPerDay?: number; cooldownSec?: number };
  balanceWei?: string;
  holdings?: Array<{ token: string; symbol: string; decimals: number; balance: string }>;
  returnsTo?: string;
  links?: Array<{ topic: string; name: string | null; url: string | null; linkedAt: string }>;
  trades?: Array<{
    at: string;
    site: string | null;
    kind: string;
    token: string | null;
    valueWei: string | null;
    txHash: string | null;
    result: "SENT" | "REFUSED" | "ERROR";
    code: string | null;
    message: string | null;
    totalMs: number | null;
  }>;
}

export interface FloatSettingsInput {
  maxBuyPct?: number;
  dailySpendPct?: number;
  maxBuysPerDay?: number;
  cooldownSec?: number;
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

  getEnforcement: (accountId: string) => request<EnforcementStatus>(`/v1/accounts/${encodeURIComponent(accountId)}/enforcement`),

  reconcileEvm: (accountId: string) =>
    request<{ accountId: string; currentEquity: string; peakEquity: string }>(
      `/v1/accounts/${encodeURIComponent(accountId)}/reconcile-evm`,
      { method: "POST", body: "{}" },
    ),

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

  addRule: (accountId: string, ruleType: string, param: string, tokenAddress?: string) =>
    request<{ rule: RuleVersion }>(`/v1/accounts/${encodeURIComponent(accountId)}/rules`, {
      method: "POST",
      body: JSON.stringify(tokenAddress ? { ruleType, param, tokenAddress } : { ruleType, param }),
    }),

  deactivateRule: (accountId: string, ruleId: string) =>
    // Fastify's JSON body parser rejects an empty body when Content-Type is
    // application/json (which `request()` always sets) - this route needs
    // no input, but still needs a real (even empty) JSON body to parse.
    request<{ ruleId: string; isActive: false }>(
      `/v1/accounts/${encodeURIComponent(accountId)}/rules/${encodeURIComponent(ruleId)}/deactivate`,
      { method: "POST", body: "{}" },
    ),

  getOneClick: (accountId: string) => request<OneClickStatus>(`/v1/accounts/${encodeURIComponent(accountId)}/one-click`),

  prepareOneClick: (accountId: string) =>
    request<{ sessionKeyAddress: string; ownerAddress: string; chainId: number; transaction: OneClickTransaction }>(
      `/v1/accounts/${encodeURIComponent(accountId)}/one-click/prepare`,
      { method: "POST", body: "{}" },
    ),

  confirmOneClick: (accountId: string) =>
    request<{ status: string }>(`/v1/accounts/${encodeURIComponent(accountId)}/one-click/confirm`, { method: "POST", body: "{}" }),

  pairOneClick: (accountId: string, uri: string) =>
    request<{ ok: boolean; message: string }>(`/v1/accounts/${encodeURIComponent(accountId)}/one-click/pair`, {
      method: "POST",
      body: JSON.stringify({ uri }),
    }),

  disconnectOneClick: (accountId: string, topic: string) =>
    request<{ ok: boolean }>(`/v1/accounts/${encodeURIComponent(accountId)}/one-click/disconnect`, {
      method: "POST",
      body: JSON.stringify({ topic }),
    }),

  disableOneClick: (accountId: string) =>
    request<{ status: string; chainId?: number; ownerAddress?: string; transaction: OneClickTransaction | null }>(
      `/v1/accounts/${encodeURIComponent(accountId)}/one-click/disable`,
      { method: "POST", body: "{}" },
    ),
  getFloat: (accountId: string) => request<FloatStatus>(`/v1/accounts/${encodeURIComponent(accountId)}/float`),
  createFloat: (accountId: string) =>
    request<{ ok: boolean; address: string }>(`/v1/accounts/${encodeURIComponent(accountId)}/float/create`, { method: "POST", body: "{}" }),
  updateFloat: (accountId: string, input: FloatSettingsInput) =>
    request<{ ok: boolean }>(`/v1/accounts/${encodeURIComponent(accountId)}/float/settings`, { method: "POST", body: JSON.stringify(input) }),
  freezeFloat: (accountId: string, frozen: boolean) =>
    request<{ ok: boolean }>(`/v1/accounts/${encodeURIComponent(accountId)}/float/freeze`, { method: "POST", body: JSON.stringify({ frozen }) }),
  pairFloat: (accountId: string, uri: string) =>
    request<{ ok: boolean; message: string }>(`/v1/accounts/${encodeURIComponent(accountId)}/float/pair`, { method: "POST", body: JSON.stringify({ uri }) }),
  disconnectFloat: (accountId: string, topic: string) =>
    request<{ ok: boolean }>(`/v1/accounts/${encodeURIComponent(accountId)}/float/disconnect`, { method: "POST", body: JSON.stringify({ topic }) }),
  sweepFloat: (accountId: string) =>
    request<{ ok: boolean; returnedTo: string; items: Array<{ asset: string; amount: string; txHash: string | null; error: string | null }> }>(
      `/v1/accounts/${encodeURIComponent(accountId)}/float/sweep`,
      { method: "POST", body: "{}" },
    ),
  switchFloat: (accountId: string, on: boolean) =>
    request<{ ok: boolean; items?: Array<{ asset: string; amount: string; txHash: string | null; error: string | null }> }>(
      `/v1/accounts/${encodeURIComponent(accountId)}/float/${on ? "on" : "off"}`,
      { method: "POST", body: "{}" },
    ),
};
