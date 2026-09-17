const API_BASE_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3000";

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${API_BASE_URL}${path}`, {
    ...init,
    headers: { "Content-Type": "application/json", ...init?.headers },
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
  initialEquity: string;
  initialRules: Array<{ ruleType: string; param: string }>;
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

export const api = {
  createAccount: (input: CreateAccountInput) =>
    request<{ accountId: string; protectionOn: boolean }>("/v1/accounts", {
      method: "POST",
      body: JSON.stringify(input),
    }),

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
};
