"use client";

import { useEffect, useState } from "react";
import Image from "next/image";
import { Button } from "@/design-system/components/core/Button";
import { Input } from "@/design-system/components/forms/Input";
import { Panel } from "@/design-system/Panel";
import { StatusBadge } from "@/design-system/StatusBadge";
import {
  api,
  type DryRunOrderResult,
  type ProtectionStatus,
  type ReconcileResult,
} from "@/lib/api";

const STORAGE_KEY = "mypropguard.accountId";

export default function Dashboard() {
  const [accountId, setAccountId] = useState("");
  const [status, setStatus] = useState<ProtectionStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const [ownerUserId, setOwnerUserId] = useState("");
  const [initialEquity, setInitialEquity] = useState("10000");
  const [maxPositionSize, setMaxPositionSize] = useState("100000");

  const [venueAddress, setVenueAddress] = useState("");
  const [reconcileResult, setReconcileResult] = useState<ReconcileResult | null>(null);

  const [coin, setCoin] = useState("BTC");
  const [side, setSide] = useState<"BUY" | "SELL">("BUY");
  const [size, setSize] = useState("1");
  const [price, setPrice] = useState("50000");
  const [orderResult, setOrderResult] = useState<DryRunOrderResult | null>(null);

  useEffect(() => {
    const saved = window.localStorage.getItem(STORAGE_KEY);
    if (saved) {
      setAccountId(saved);
      void loadAccount(saved);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function loadAccount(id: string) {
    if (!id) return;
    setLoading(true);
    setError(null);
    try {
      const result = await api.getProtection(id);
      setStatus(result);
      window.localStorage.setItem(STORAGE_KEY, id);
    } catch (err) {
      setStatus(null);
      setError(err instanceof Error ? err.message : "Failed to load account");
    } finally {
      setLoading(false);
    }
  }

  async function handleCreateAccount() {
    setError(null);
    try {
      await api.createAccount({
        accountId,
        ownerUserId: ownerUserId || "demo_owner",
        initialEquity,
        initialRules: [{ ruleType: "MAX_POSITION_SIZE", param: maxPositionSize }],
      });
      await loadAccount(accountId);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create account");
    }
  }

  async function handleActivate() {
    if (!accountId) return;
    await api.activateProtection(accountId);
    await loadAccount(accountId);
  }

  async function handleDeactivate() {
    if (!accountId) return;
    await api.deactivateProtection(accountId);
    await loadAccount(accountId);
  }

  async function handleReconcile() {
    if (!accountId || !venueAddress) return;
    setError(null);
    try {
      const result = await api.reconcile(accountId, venueAddress);
      setReconcileResult(result);
      await loadAccount(accountId);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Reconcile failed");
    }
  }

  async function handleCheckOrder() {
    if (!accountId) return;
    setError(null);
    try {
      const result = await api.dryRunOrder({
        clientIntentId: `web_${Date.now()}`,
        accountId,
        coin,
        side,
        size,
        price,
      });
      setOrderResult(result);
    } catch (err) {
      setOrderResult(null);
      setError(err instanceof Error ? err.message : "Order check failed");
    }
  }

  const outcomeTone =
    orderResult?.decision.outcome === "ALLOW"
      ? "success"
      : orderResult?.decision.outcome === "RESIZE"
        ? "warning"
        : orderResult?.decision.outcome === "BLOCK"
          ? "danger"
          : "neutral";

  return (
    <main style={{ maxWidth: 880, margin: "0 auto", padding: "var(--space-7) var(--gutter)" }}>
      <header style={{ display: "flex", alignItems: "center", gap: "var(--space-3)", marginBottom: "var(--space-2)" }}>
        <Image src="/brand/monogram-forest-tight.png" alt="" width={32} height={32} />
        <div>
          <h1 style={{ fontSize: "var(--text-h2)" }}>MyPropGuard Onchain</h1>
          <p style={{ margin: 0, fontSize: "var(--text-caption)", color: "var(--text-muted)" }}>
            Powered by Ighodalo Labs. Hyperliquid risk enforcement, not a signal service or account manager.
          </p>
        </div>
      </header>

      <p
        style={{
          fontSize: "var(--text-caption)",
          color: "var(--text-muted)",
          background: "var(--surface-sunken)",
          padding: "var(--space-3) var(--space-4)",
          borderRadius: "var(--radius-md)",
          marginBottom: "var(--space-6)",
        }}
      >
        This connects to the real risk engine and Postgres ledger built this session. Order checks run the real
        deterministic rules. Signing (when enabled) uses a real Privy key. Nothing here submits to Hyperliquid or
        moves funds.
      </p>

      {error && (
        <div
          style={{
            background: "var(--color-danger)",
            color: "#fff",
            padding: "var(--space-3) var(--space-4)",
            borderRadius: "var(--radius-md)",
            marginBottom: "var(--space-5)",
            fontSize: "var(--text-caption)",
          }}
        >
          {error}
        </div>
      )}

      <div style={{ display: "grid", gap: "var(--space-6)" }}>
        <Panel title="Account">
          <div style={{ display: "flex", gap: "var(--space-3)", alignItems: "flex-end", flexWrap: "wrap" }}>
            <Input label="Account ID" value={accountId} onChange={(e: React.ChangeEvent<HTMLInputElement>) => setAccountId(e.target.value)} placeholder="acct_my_first" />
            <Button variant="secondary" onClick={() => loadAccount(accountId)} disabled={!accountId || loading}>
              {loading ? "Loading…" : "Load"}
            </Button>
          </div>

          {!status && (
            <div style={{ marginTop: "var(--space-5)", paddingTop: "var(--space-5)", borderTop: "1px solid var(--border-default)" }}>
              <h4 style={{ fontSize: "var(--text-body-md)", fontWeight: 600, marginBottom: "var(--space-3)" }}>
                Or provision a new account
              </h4>
              <div style={{ display: "flex", gap: "var(--space-3)", flexWrap: "wrap", alignItems: "flex-end" }}>
                <Input label="Owner user id" value={ownerUserId} onChange={(e: React.ChangeEvent<HTMLInputElement>) => setOwnerUserId(e.target.value)} placeholder="demo_owner" />
                <Input label="Initial equity ($)" value={initialEquity} onChange={(e: React.ChangeEvent<HTMLInputElement>) => setInitialEquity(e.target.value)} />
                <Input label="Max position size ($)" value={maxPositionSize} onChange={(e: React.ChangeEvent<HTMLInputElement>) => setMaxPositionSize(e.target.value)} />
                <Button onClick={handleCreateAccount} disabled={!accountId}>
                  Create account
                </Button>
              </div>
            </div>
          )}
        </Panel>

        {status && (
          <Panel title="Protection status">
            <div style={{ display: "flex", gap: "var(--space-2)", flexWrap: "wrap", marginBottom: "var(--space-4)" }}>
              <StatusBadge tone={status.protectionOn ? "success" : "neutral"}>
                {status.protectionOn ? "Protection on" : "Protection off"}
              </StatusBadge>
              <StatusBadge tone={status.botCanOpenNewTrades ? "success" : "warning"}>
                {status.botCanOpenNewTrades ? "Bot can trade" : "Bot paused"}
              </StatusBadge>
              {status.walletNeedsAttention && <StatusBadge tone="danger">Needs attention</StatusBadge>}
            </div>

            <dl style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "var(--space-3)", fontSize: 14, margin: 0 }}>
              <div>
                <dt style={{ color: "var(--text-muted)", fontSize: 12 }}>Daily loss budget</dt>
                <dd style={{ margin: 0, fontWeight: 600 }}>${status.maxLossToday}</dd>
              </div>
              <div>
                <dt style={{ color: "var(--text-muted)", fontSize: 12 }}>Used today</dt>
                <dd style={{ margin: 0, fontWeight: 600 }}>${status.lossUsedToday}</dd>
              </div>
              <div>
                <dt style={{ color: "var(--text-muted)", fontSize: 12 }}>Blocking reason</dt>
                <dd style={{ margin: 0, fontWeight: 600 }}>{status.blockingReason ?? "None"}</dd>
              </div>
              <div>
                <dt style={{ color: "var(--text-muted)", fontSize: 12 }}>Last verified</dt>
                <dd style={{ margin: 0, fontWeight: 600 }}>
                  {new Date(status.lastVerifiedAt).getTime() === 0 ? "Never" : new Date(status.lastVerifiedAt).toLocaleString()}
                </dd>
              </div>
            </dl>

            <div style={{ display: "flex", gap: "var(--space-3)", marginTop: "var(--space-5)" }}>
              <Button variant="secondary" onClick={handleActivate} disabled={status.protectionOn}>
                Activate
              </Button>
              <Button variant="subtle" onClick={handleDeactivate} disabled={!status.protectionOn}>
                Deactivate
              </Button>
            </div>
          </Panel>
        )}

        {status && (
          <Panel title="Reconcile with Hyperliquid">
            <p style={{ marginTop: 0, fontSize: 13, color: "var(--text-muted)" }}>
              Reads live equity and exposure from Hyperliquid&apos;s public Info API for any address, no credentials
              needed, and folds it into this account&apos;s risk ledger.
            </p>
            <div style={{ display: "flex", gap: "var(--space-3)", alignItems: "flex-end", flexWrap: "wrap" }}>
              <Input
                label="Hyperliquid address"
                value={venueAddress}
                onChange={(e: React.ChangeEvent<HTMLInputElement>) => setVenueAddress(e.target.value)}
                placeholder="0x..."
                helpText="Any real address works, this is a public read."
              />
              <Button variant="secondary" onClick={handleReconcile} disabled={!venueAddress}>
                Reconcile
              </Button>
            </div>
            {reconcileResult && (
              <div style={{ marginTop: "var(--space-4)", fontSize: 13, color: "var(--text-muted)" }}>
                Equity ${reconcileResult.currentEquity}, open notional ${reconcileResult.openNotional}, leverage{" "}
                {reconcileResult.leverage}x
              </div>
            )}
          </Panel>
        )}

        {status && (
          <Panel title="Check an order">
            <p style={{ marginTop: 0, fontSize: 13, color: "var(--text-muted)" }}>
              Runs the real risk engine and reservation logic. If allowed or resized, also runs the real
              canonicalize, nonce lease, and signing pipeline (fake signer unless the API has a real one enabled).
            </p>
            <div style={{ display: "flex", gap: "var(--space-3)", flexWrap: "wrap", alignItems: "flex-end" }}>
              <Input label="Coin" value={coin} onChange={(e: React.ChangeEvent<HTMLInputElement>) => setCoin(e.target.value)} />
              <label style={{ display: "flex", flexDirection: "column", gap: 6, fontSize: 13, fontWeight: 600 }}>
                Side
                <select
                  value={side}
                  onChange={(e: React.ChangeEvent<HTMLSelectElement>) => setSide(e.target.value as "BUY" | "SELL")}
                  style={{
                    padding: "10px 12px",
                    borderRadius: "var(--radius-md)",
                    border: "1px solid var(--border-default)",
                    fontSize: 15,
                  }}
                >
                  <option value="BUY">Buy</option>
                  <option value="SELL">Sell</option>
                </select>
              </label>
              <Input label="Size" value={size} onChange={(e: React.ChangeEvent<HTMLInputElement>) => setSize(e.target.value)} />
              <Input label="Price ($)" value={price} onChange={(e: React.ChangeEvent<HTMLInputElement>) => setPrice(e.target.value)} />
              <Button onClick={handleCheckOrder}>Check order</Button>
            </div>

            {orderResult && (
              <div style={{ marginTop: "var(--space-5)", paddingTop: "var(--space-4)", borderTop: "1px solid var(--border-default)" }}>
                <StatusBadge tone={outcomeTone}>{orderResult.decision.outcome}</StatusBadge>
                <p style={{ fontSize: 14, marginTop: "var(--space-2)" }}>{orderResult.decision.message}</p>
                {orderResult.mockSignedAction && (
                  <div style={{ fontSize: 12, color: "var(--text-muted)", fontFamily: "var(--font-accent)", wordBreak: "break-all" }}>
                    <div>connectionId: {orderResult.mockSignedAction.connectionId}</div>
                    <div>signer: {orderResult.mockSignedAction.mockSignerAddress}</div>
                  </div>
                )}
              </div>
            )}
          </Panel>
        )}
      </div>
    </main>
  );
}
