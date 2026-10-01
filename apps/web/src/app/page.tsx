"use client";

import { useEffect, useState } from "react";
import type { Session } from "@supabase/supabase-js";
import Image from "next/image";
import { Button } from "@/design-system/components/core/Button";
import { Input } from "@/design-system/components/forms/Input";
import { Select } from "@/design-system/components/forms/Select";
import { Panel } from "@/design-system/Panel";
import { StatusBadge } from "@/design-system/StatusBadge";
import { supabase } from "@/lib/supabaseClient";
import {
  api,
  type DryRunOrderResult,
  type ProtectedAccountSummary,
  type ProtectionStatus,
  type ReconcileResult,
  type RuleVersion,
  type SubmitOrderResult,
} from "@/lib/api";

const STORAGE_KEY = "mypropguard.accountId";
const GUIDE_DISMISSED_KEY = "mypropguard.guideDismissed";

const GUIDE_STEPS = [
  {
    title: "1. Provision an account",
    body: "In \"Account\", pick an account id (any name you choose, e.g. acct_my_bot) and click \"Create account\". This sets a starting equity and one initial risk rule for it.",
  },
  {
    title: "2. Approve the wallet on Hyperliquid",
    body: "Creating an account provisions a dedicated signing wallet for it. Copy the address shown and approve it as an agent on Hyperliquid's site (API tab → Approve Agent) - this lets THIS account trade under YOUR risk rules, not through a shared key.",
  },
  {
    title: "3. Set your risk rules",
    body: "In \"Risk rules\", add limits like max daily loss or max position size. These are the mandate every order gets checked against - add or deactivate them any time, changes apply to the very next order.",
  },
  {
    title: "4. Activate protection",
    body: "In \"Protection status\", click Activate once you've reconciled real equity from Hyperliquid at least once. \"Bot can trade\" only shows green when your account's state has been freshly verified.",
  },
  {
    title: "5. Check an order vs. Submit for real",
    body: "\"Check order\" always just previews what the risk engine would decide - it never moves money. \"Submit for real\" (below it) is the only button that can actually place a trade on Hyperliquid, and needs an explicit confirmation checkbox first.",
  },
];

function GettingStartedGuide({ onDismiss }: { onDismiss: () => void }) {
  return (
    <Panel title="Getting started">
      <p style={{ marginTop: 0, fontSize: 13, color: "var(--text-muted)" }}>
        MyPropGuard sits between you and Hyperliquid and enforces the risk rules you set - it never signals trades or
        manages your account for you. Here's the order things happen in:
      </p>
      <div style={{ display: "grid", gap: "var(--space-3)", marginBottom: "var(--space-4)" }}>
        {GUIDE_STEPS.map((step) => (
          <div key={step.title}>
            <div style={{ fontSize: 14, fontWeight: 600 }}>{step.title}</div>
            <div style={{ fontSize: 13, color: "var(--text-muted)" }}>{step.body}</div>
          </div>
        ))}
      </div>
      <Button variant="subtle" size="sm" onClick={onDismiss}>
        Got it, hide this
      </Button>
    </Panel>
  );
}

const RULE_TYPE_OPTIONS = [
  { value: "MAX_DAILY_LOSS", label: "Max daily loss ($)" },
  { value: "MAX_DRAWDOWN", label: "Max drawdown ($)" },
  { value: "MAX_LEVERAGE", label: "Max leverage (x)" },
  { value: "MAX_POSITION_SIZE", label: "Max position size ($)" },
  { value: "MAX_EXPOSURE", label: "Max exposure ($)" },
  { value: "MAX_TRADE_FREQUENCY", label: "Max trades (count)" },
  { value: "COOLDOWN", label: "Cooldown (seconds)" },
];

function ruleTypeLabel(ruleType: string): string {
  return RULE_TYPE_OPTIONS.find((o) => o.value === ruleType)?.label ?? ruleType;
}

// Only Hyperliquid (a Privy-managed wallet) and Arbitrum/GMX (a real on-chain Safe + Guard, see
// packages/evm-guard) are wired up server-side right now - see packages/evm-guard/ROADMAP.md for
// BSC/Ethereum.
const VENUE_OPTIONS = [
  { value: "hyperliquid", label: "Hyperliquid" },
  { value: "arbitrum-gmx", label: "GMX on Arbitrum" },
];
const VENUE_CHAIN_IDS: Record<string, number> = { "arbitrum-gmx": 42161 };

function AuthForm() {
  const [mode, setMode] = useState<"sign-in" | "sign-up">("sign-in");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit() {
    setError(null);
    setInfo(null);
    setSubmitting(true);
    try {
      if (mode === "sign-in") {
        const { error: signInError } = await supabase.auth.signInWithPassword({ email, password });
        if (signInError) throw signInError;
      } else {
        const { error: signUpError } = await supabase.auth.signUp({ email, password });
        if (signUpError) throw signUpError;
        setInfo("Check your email to confirm your account, then sign in.");
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Authentication failed");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <main style={{ maxWidth: 400, margin: "80px auto", padding: "0 var(--gutter)" }}>
      <div style={{ display: "flex", alignItems: "center", gap: "var(--space-3)", marginBottom: "var(--space-6)" }}>
        <Image src="/brand/monogram-forest-tight.png" alt="" width={32} height={32} />
        <h1 style={{ fontSize: "var(--text-h2)" }}>MyPropGuard Onchain</h1>
      </div>

      <Panel title={mode === "sign-in" ? "Sign in" : "Create an account"}>
        <div style={{ display: "grid", gap: "var(--space-4)" }}>
          <Input
            label="Email"
            type="email"
            value={email}
            onChange={(e: React.ChangeEvent<HTMLInputElement>) => setEmail(e.target.value)}
            required
          />
          <label style={{ display: "flex", flexDirection: "column", gap: 6, fontSize: 13, fontWeight: 600 }}>
            Password
            <input
              type="password"
              value={password}
              onChange={(e: React.ChangeEvent<HTMLInputElement>) => setPassword(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && void handleSubmit()}
              required
              style={{
                padding: "10px 12px",
                borderRadius: "var(--radius-md)",
                border: "1px solid var(--border-default)",
                fontSize: 15,
                fontFamily: "inherit",
              }}
            />
          </label>
          {error && <p style={{ color: "var(--color-danger)", fontSize: 13, margin: 0 }}>{error}</p>}
          {info && <p style={{ color: "var(--text-muted)", fontSize: 13, margin: 0 }}>{info}</p>}
          <Button onClick={() => void handleSubmit()} disabled={submitting}>
            {submitting ? "Please wait…" : mode === "sign-in" ? "Sign in" : "Sign up"}
          </Button>
        </div>
        <button
          onClick={() => {
            setMode(mode === "sign-in" ? "sign-up" : "sign-in");
            setError(null);
            setInfo(null);
          }}
          style={{
            marginTop: "var(--space-4)",
            background: "none",
            border: "none",
            color: "var(--color-primary)",
            cursor: "pointer",
            fontSize: 13,
            padding: 0,
          }}
        >
          {mode === "sign-in" ? "Need an account? Sign up" : "Already have an account? Sign in"}
        </button>
      </Panel>
    </main>
  );
}

export default function Page() {
  const [session, setSession] = useState<Session | null>(null);
  const [authLoading, setAuthLoading] = useState(true);

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session);
      setAuthLoading(false);
    });
    const { data: subscription } = supabase.auth.onAuthStateChange((_event, newSession) => {
      setSession(newSession);
    });
    return () => subscription.subscription.unsubscribe();
  }, []);

  if (authLoading) return null;
  if (!session) return <AuthForm />;
  return <Dashboard session={session} />;
}

function Dashboard({ session }: { session: Session }) {
  const [accountId, setAccountId] = useState("");
  const [status, setStatus] = useState<ProtectionStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const [initialEquity, setInitialEquity] = useState("10000");
  const [maxPositionSize, setMaxPositionSize] = useState("100000");
  const [newAgentWalletAddress, setNewAgentWalletAddress] = useState<string | null>(null);
  const [newVenue, setNewVenue] = useState("hyperliquid");
  const [evmOwnerWalletAddress, setEvmOwnerWalletAddress] = useState("");
  const [newEvmSafeAddress, setNewEvmSafeAddress] = useState<string | null>(null);

  const [venueAddress, setVenueAddress] = useState("");
  const [reconcileResult, setReconcileResult] = useState<ReconcileResult | null>(null);

  const [coin, setCoin] = useState("BTC");
  const [side, setSide] = useState<"BUY" | "SELL">("BUY");
  const [size, setSize] = useState("1");
  const [price, setPrice] = useState("50000");
  const [orderResult, setOrderResult] = useState<DryRunOrderResult | null>(null);
  const [confirmSubmit, setConfirmSubmit] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [submitResult, setSubmitResult] = useState<SubmitOrderResult | null>(null);

  const [accounts, setAccounts] = useState<ProtectedAccountSummary[]>([]);
  const [accountsLoading, setAccountsLoading] = useState(false);
  const [accountsLoaded, setAccountsLoaded] = useState(false);

  const [rules, setRules] = useState<RuleVersion[]>([]);
  const [newRuleType, setNewRuleType] = useState("MAX_POSITION_SIZE");
  const [newRuleParam, setNewRuleParam] = useState("");
  const [addingRule, setAddingRule] = useState(false);

  const [showGuide, setShowGuide] = useState(false);

  useEffect(() => {
    const saved = window.localStorage.getItem(STORAGE_KEY);
    if (saved) {
      setAccountId(saved);
      void loadAccount(saved);
    }
    void loadAccounts();
    try {
      setShowGuide(window.localStorage.getItem(GUIDE_DISMISSED_KEY) !== "true");
    } catch {
      setShowGuide(true);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function dismissGuide() {
    setShowGuide(false);
    try {
      window.localStorage.setItem(GUIDE_DISMISSED_KEY, "true");
    } catch {
      // per-viewer convenience only - fine if this browser blocks storage
    }
  }

  async function loadAccount(id: string) {
    if (!id) return;
    setLoading(true);
    setError(null);
    try {
      const result = await api.getProtection(id);
      setStatus(result);
      window.localStorage.setItem(STORAGE_KEY, id);
      await loadRules(id);
    } catch (err) {
      setStatus(null);
      setError(err instanceof Error ? err.message : "Failed to load account");
    } finally {
      setLoading(false);
    }
  }

  async function loadAccounts() {
    setAccountsLoading(true);
    setError(null);
    try {
      const result = await api.listAccounts();
      setAccounts(result.accounts);
      setAccountsLoaded(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load accounts");
    } finally {
      setAccountsLoading(false);
    }
  }

  async function loadRules(id: string) {
    try {
      const result = await api.listRules(id);
      setRules(result.rules);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load rules");
    }
  }

  async function handleAddRule() {
    if (!accountId || !newRuleParam) return;
    setAddingRule(true);
    setError(null);
    try {
      await api.addRule(accountId, newRuleType, newRuleParam);
      setNewRuleParam("");
      // Protection status (e.g. the daily-loss budget shown) depends on
      // active rules - refresh it too, not just the rules list, or it goes
      // stale the moment a rule that fed it changes.
      await Promise.all([loadRules(accountId), api.getProtection(accountId).then(setStatus)]);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to add rule");
    } finally {
      setAddingRule(false);
    }
  }

  async function handleDeactivateRule(ruleId: string) {
    if (!accountId) return;
    setError(null);
    try {
      await api.deactivateRule(accountId, ruleId);
      await Promise.all([loadRules(accountId), api.getProtection(accountId).then(setStatus)]);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to deactivate rule");
    }
  }

  async function handleCreateAccount() {
    setError(null);
    try {
      const isEvmVenue = newVenue !== "hyperliquid";
      const result = await api.createAccount({
        accountId,
        ownerUserId: session.user.id,
        venue: newVenue,
        initialEquity,
        initialRules: [{ ruleType: "MAX_POSITION_SIZE", param: maxPositionSize }],
        ...(isEvmVenue && evmOwnerWalletAddress
          ? { evmOwnerWalletAddress, evmChainId: VENUE_CHAIN_IDS[newVenue] }
          : {}),
      });
      setNewAgentWalletAddress(result.agentWalletAddress);
      setNewEvmSafeAddress(result.evmSafeAddress ?? null);
      await Promise.all([loadAccount(accountId), loadAccounts()]);
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
    setSubmitResult(null);
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

  async function handleSubmitOrder() {
    if (!accountId || !confirmSubmit) return;
    setError(null);
    setSubmitting(true);
    try {
      const result = await api.submitOrder({
        clientIntentId: `web_submit_${Date.now()}`,
        accountId,
        coin,
        side,
        size,
        price,
      });
      setSubmitResult(result);
      setConfirmSubmit(false);
    } catch (err) {
      setSubmitResult(null);
      setError(err instanceof Error ? err.message : "Order submission failed");
    } finally {
      setSubmitting(false);
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
      <header style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "var(--space-3)", marginBottom: "var(--space-2)" }}>
        <div style={{ display: "flex", alignItems: "center", gap: "var(--space-3)" }}>
          <Image src="/brand/monogram-forest-tight.png" alt="" width={32} height={32} />
          <div>
            <h1 style={{ fontSize: "var(--text-h2)" }}>MyPropGuard Onchain</h1>
            <p style={{ margin: 0, fontSize: "var(--text-caption)", color: "var(--text-muted)" }}>
              Powered by Ighodalo Labs. Hyperliquid risk enforcement, not a signal service or account manager.
            </p>
          </div>
        </div>
        <Button variant="subtle" size="sm" onClick={() => supabase.auth.signOut()}>
          Sign out
        </Button>
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
        {showGuide && <GettingStartedGuide onDismiss={dismissGuide} />}

        <Panel title="Your accounts">
          <p style={{ marginTop: 0, fontSize: 13, color: "var(--text-muted)" }}>
            Every account you own, as {session.user.email}.
          </p>
          <div style={{ display: "flex", gap: "var(--space-3)", alignItems: "flex-end", flexWrap: "wrap" }}>
            <Button variant="secondary" onClick={loadAccounts} disabled={accountsLoading}>
              {accountsLoading ? "Loading…" : "Refresh"}
            </Button>
          </div>

          {accountsLoaded && (
            <div style={{ marginTop: "var(--space-4)" }}>
              {accounts.length === 0 ? (
                <p style={{ fontSize: 13, color: "var(--text-muted)", margin: 0 }}>No accounts yet - provision one below.</p>
              ) : (
                <div style={{ display: "grid", gap: "var(--space-2)" }}>
                  {accounts.map((account) => (
                    <button
                      key={account.accountId}
                      onClick={() => {
                        setAccountId(account.accountId);
                        void loadAccount(account.accountId);
                      }}
                      style={{
                        display: "flex",
                        justifyContent: "space-between",
                        alignItems: "center",
                        gap: "var(--space-3)",
                        padding: "var(--space-3) var(--space-4)",
                        borderRadius: "var(--radius-md)",
                        border: account.accountId === accountId ? "1px solid var(--color-primary)" : "1px solid var(--border-default)",
                        background: "var(--surface-card)",
                        cursor: "pointer",
                        textAlign: "left",
                        fontFamily: "inherit",
                      }}
                    >
                      <span style={{ fontSize: 14, fontWeight: 600 }}>{account.accountId}</span>
                      <span style={{ display: "flex", gap: "var(--space-2)", alignItems: "center" }}>
                        <span style={{ fontSize: 12, color: "var(--text-muted)" }}>{account.venue}</span>
                        <StatusBadge tone={account.protectionEnabled ? "success" : "neutral"}>
                          {account.protectionEnabled ? "Protected" : "Off"}
                        </StatusBadge>
                      </span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}
        </Panel>

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
                <Select label="Venue" options={VENUE_OPTIONS} value={newVenue} onChange={(e: React.ChangeEvent<HTMLSelectElement>) => setNewVenue(e.target.value)} />
                <Input label="Initial equity ($)" value={initialEquity} onChange={(e: React.ChangeEvent<HTMLInputElement>) => setInitialEquity(e.target.value)} />
                <Input label="Max position size ($)" value={maxPositionSize} onChange={(e: React.ChangeEvent<HTMLInputElement>) => setMaxPositionSize(e.target.value)} />
              </div>

              {newVenue !== "hyperliquid" && (
                <div style={{ marginTop: "var(--space-3)" }}>
                  <Input
                    label="Your wallet address"
                    value={evmOwnerWalletAddress}
                    onChange={(e: React.ChangeEvent<HTMLInputElement>) => setEvmOwnerWalletAddress(e.target.value)}
                    placeholder="0x..."
                    helpText="This becomes the sole owner of a Safe we provision for you - MyPropGuard never holds its key."
                  />
                </div>
              )}

              <div style={{ marginTop: "var(--space-3)" }}>
                <Button onClick={handleCreateAccount} disabled={!accountId}>
                  Create account
                </Button>
              </div>
            </div>
          )}

          {newAgentWalletAddress && (
            <div
              style={{
                marginTop: "var(--space-5)",
                padding: "var(--space-3) var(--space-4)",
                borderRadius: "var(--radius-md)",
                background: "var(--surface-sunken)",
                fontSize: 13,
              }}
            >
              <div style={{ fontWeight: 600, marginBottom: 4 }}>One more step: approve this wallet on Hyperliquid</div>
              <div style={{ color: "var(--text-muted)", marginBottom: 6 }}>
                We provisioned a signing wallet just for this account. Go to Hyperliquid&apos;s site → API tab →
                Approve Agent, and paste this address:
              </div>
              <code style={{ fontFamily: "var(--font-accent)", wordBreak: "break-all" }}>{newAgentWalletAddress}</code>
            </div>
          )}

          {newEvmSafeAddress && (
            <div
              style={{
                marginTop: "var(--space-5)",
                padding: "var(--space-3) var(--space-4)",
                borderRadius: "var(--radius-md)",
                background: "var(--surface-sunken)",
                fontSize: 13,
              }}
            >
              <div style={{ fontWeight: 600, marginBottom: 4 }}>Your Safe is ready - trade with it directly on GMX</div>
              <div style={{ color: "var(--text-muted)", marginBottom: 6 }}>
                This Safe already has your risk rules attached on-chain. Go to GMX&apos;s own site, connect this
                address as your trading wallet, and trade normally - a rule-breaking order will revert on-chain
                before it ever reaches GMX:
              </div>
              <code style={{ fontFamily: "var(--font-accent)", wordBreak: "break-all" }}>{newEvmSafeAddress}</code>
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
          <Panel title="Risk rules">
            <p style={{ marginTop: 0, fontSize: 13, color: "var(--text-muted)" }}>
              The mandate this account is actually checked against on every trade. Deactivating a rule takes effect
              immediately — it stops applying to the very next order.
            </p>

            {rules.length === 0 ? (
              <p style={{ fontSize: 13, color: "var(--text-muted)" }}>No active rules on this account.</p>
            ) : (
              <div style={{ display: "grid", gap: "var(--space-2)", marginBottom: "var(--space-5)" }}>
                {rules.map((rule) => (
                  <div
                    key={rule.id}
                    style={{
                      display: "flex",
                      justifyContent: "space-between",
                      alignItems: "center",
                      gap: "var(--space-3)",
                      padding: "var(--space-3) var(--space-4)",
                      borderRadius: "var(--radius-md)",
                      border: "1px solid var(--border-default)",
                      background: "var(--surface-card)",
                    }}
                  >
                    <div>
                      <div style={{ fontSize: 14, fontWeight: 600 }}>{ruleTypeLabel(rule.ruleType)}</div>
                      <div style={{ fontSize: 12, color: "var(--text-muted)" }}>Limit: {rule.param}</div>
                    </div>
                    <Button variant="subtle" size="sm" onClick={() => handleDeactivateRule(rule.id)}>
                      Deactivate
                    </Button>
                  </div>
                ))}
              </div>
            )}

            <div style={{ paddingTop: "var(--space-4)", borderTop: "1px solid var(--border-default)" }}>
              <h4 style={{ fontSize: "var(--text-body-md)", fontWeight: 600, marginBottom: "var(--space-3)" }}>Add a rule</h4>
              <div style={{ display: "flex", gap: "var(--space-3)", flexWrap: "wrap", alignItems: "flex-end" }}>
                <Select label="Rule type" options={RULE_TYPE_OPTIONS} value={newRuleType} onChange={(e: React.ChangeEvent<HTMLSelectElement>) => setNewRuleType(e.target.value)} />
                <Input
                  label="Limit"
                  value={newRuleParam}
                  onChange={(e: React.ChangeEvent<HTMLInputElement>) => setNewRuleParam(e.target.value)}
                  placeholder="e.g. 500"
                />
                <Button onClick={handleAddRule} disabled={!newRuleParam || addingRule}>
                  {addingRule ? "Adding…" : "Add rule"}
                </Button>
              </div>
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

            <div
              style={{
                marginTop: "var(--space-5)",
                paddingTop: "var(--space-5)",
                borderTop: "1px solid var(--border-default)",
              }}
            >
              <div
                style={{
                  background: "var(--surface-sunken)",
                  padding: "var(--space-3) var(--space-4)",
                  borderRadius: "var(--radius-md)",
                  marginBottom: "var(--space-4)",
                }}
              >
                <h4 style={{ fontSize: "var(--text-body-md)", fontWeight: 600, marginTop: 0, marginBottom: "var(--space-2)" }}>
                  Submit for real
                </h4>
                <p style={{ fontSize: 13, color: "var(--text-muted)", marginTop: 0, marginBottom: "var(--space-3)" }}>
                  This can place a real order on Hyperliquid using the exact coin/side/size/price above, if the API
                  server has real submission enabled. Unlike &quot;Check order&quot; above, this is not a preview.
                </p>
                <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13, marginBottom: "var(--space-3)" }}>
                  <input
                    type="checkbox"
                    checked={confirmSubmit}
                    onChange={(e: React.ChangeEvent<HTMLInputElement>) => setConfirmSubmit(e.target.checked)}
                  />
                  I understand this may place a real trade and move real funds.
                </label>
                <Button variant="primary" onClick={handleSubmitOrder} disabled={!confirmSubmit || submitting}>
                  {submitting ? "Submitting…" : "Submit real order"}
                </Button>
              </div>

              {submitResult && (
                <div>
                  <StatusBadge tone={submitResult.submitted ? "success" : "neutral"}>
                    {submitResult.submitted ? "Submitted to venue" : "Not submitted"}
                  </StatusBadge>
                  <p style={{ fontSize: 14, marginTop: "var(--space-2)" }}>{submitResult.decision.message}</p>
                  {submitResult.venueOrderId && (
                    <div style={{ fontSize: 12, color: "var(--text-muted)", fontFamily: "var(--font-accent)", wordBreak: "break-all" }}>
                      venueOrderId: {submitResult.venueOrderId}
                    </div>
                  )}
                </div>
              )}
            </div>
          </Panel>
        )}
      </div>
    </main>
  );
}
