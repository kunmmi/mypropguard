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
import { VENUES, getVenue, isSafeVenue, type VenueConfig } from "@/lib/venues";
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
    title: "1. Pick a venue",
    body: "Choose where this account trades: an on-chain exchange on its own chain (PancakeSwap on BNB Chain, Uniswap on Ethereum, GMX on Arbitrum) or Hyperliquid. Each venue has its own setup, shown when you pick it. More venues and chains are added over time.",
  },
  {
    title: "2. Create the account",
    body: "On-chain venues: paste your own wallet address. We deploy a Safe smart wallet on that chain with you as its sole owner and a Guard contract attached, and we never hold your key. Hyperliquid: we provision a signing wallet that you approve as an agent on Hyperliquid's site.",
  },
  {
    title: "3. Set your risk rules",
    body: "Add limits like max amount per buy, max buys per day and max daily loss. On-chain venues push them to the Guard so they are enforced on every transaction. The rules offered depend on the venue.",
  },
  {
    title: "4. Trade within your rules",
    body: "On-chain: fund the Safe, connect it to a supported exchange through WalletConnect from app.safe.global, and sign trades with your wallet. A trade that breaks a rule, or uses a route the Guard does not support yet, is rejected on-chain. Hyperliquid: activate protection and check orders against the rules before submitting.",
  },
];

function GettingStartedGuide({ onDismiss }: { onDismiss: () => void }) {
  return (
    <Panel title="Getting started">
      <p style={{ marginTop: 0, fontSize: 13, color: "var(--text-muted)" }}>
        MyPropGuard enforces the risk rules you set on every trading venue you connect. It never signals trades or
        manages your account for you.
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

function ruleTypeLabel(ruleType: string, venue?: VenueConfig): string {
  return venue?.ruleLabels?.[ruleType] ?? RULE_TYPE_OPTIONS.find((o) => o.value === ruleType)?.label ?? ruleType;
}

function ruleOptionsFor(venue: VenueConfig) {
  const allowed = venue.supportedRules;
  return RULE_TYPE_OPTIONS.filter((o) => !allowed || allowed.includes(o.value)).map((o) => ({
    value: o.value,
    label: venue.ruleLabels?.[o.value] ?? o.label,
  }));
}

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
  const [newVenue, setNewVenue] = useState(VENUES[0].id);
  const [showNewAccount, setShowNewAccount] = useState(false);
  const [evmReconcile, setEvmReconcile] = useState<{ currentEquity: string; peakEquity: string } | null>(null);
  const [evmReconciling, setEvmReconciling] = useState(false);
  const [evmOwnerWalletAddress, setEvmOwnerWalletAddress] = useState("");

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

  const selectedAccount = accounts.find((a) => a.accountId === accountId);
  const venue = getVenue(selectedAccount?.venue);
  const isEvmSafeAccount = Boolean(selectedAccount?.evmSafeAddress) || (selectedAccount ? isSafeVenue(venue) : false);
  const newVenueConfig = getVenue(newVenue);
  const newIsSafe = isSafeVenue(newVenueConfig);

  const [rules, setRules] = useState<RuleVersion[]>([]);
  const [newRuleType, setNewRuleType] = useState("MAX_POSITION_SIZE");
  const ruleOptions = ruleOptionsFor(venue);
  const activeRuleType = ruleOptions.some((o) => o.value === newRuleType) ? newRuleType : (ruleOptions[0]?.value ?? newRuleType);
  const [newRuleParam, setNewRuleParam] = useState("");
  const [newRuleTokenAddress, setNewRuleTokenAddress] = useState("");
  const [tokenChoice, setTokenChoice] = useState("");
  const venueTokens = venue.tokens ?? [];
  const effectiveTokenChoice = tokenChoice || venueTokens[0]?.address || "custom";
  const effectiveTokenAddress = effectiveTokenChoice === "custom" ? newRuleTokenAddress : effectiveTokenChoice;
  const [savingDrafts, setSavingDrafts] = useState(false);
  const [draftRules, setDraftRules] = useState<Array<{ key: number; ruleType: string; param: string; tokenAddress: string }>>([]);

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

  function handleAddDraft(ruleType: string, tokenAddress: string) {
    if (!newRuleParam) return;
    setDraftRules((drafts) => [...drafts, { key: Date.now() + drafts.length, ruleType, param: newRuleParam, tokenAddress }]);
    setNewRuleParam("");
  }

  function removeDraft(key: number) {
    setDraftRules((drafts) => drafts.filter((d) => d.key !== key));
  }

  function draftTokenLabel(tokenAddress: string): string {
    if (!tokenAddress) return "";
    const known = venue.tokens?.find((t) => t.address.toLowerCase() === tokenAddress.toLowerCase());
    return known ? known.symbol : `${tokenAddress.slice(0, 6)}…${tokenAddress.slice(-4)}`;
  }

  // Each rule is its own on-chain transaction, so they are saved one after another (never in
  // parallel - the admin wallet's transactions must go out in order). A failure stops the run and
  // leaves the rules not yet saved in the list, so nothing typed is lost.
  async function handleSaveDrafts() {
    if (!accountId || draftRules.length === 0) return;
    setSavingDrafts(true);
    setError(null);
    try {
      for (const draft of draftRules) {
        try {
          await api.addRule(accountId, draft.ruleType, draft.param, draft.tokenAddress || undefined);
        } catch (err) {
          const what = `${ruleTypeLabel(draft.ruleType, venue)} ${draft.param}${draft.tokenAddress ? ` (${draftTokenLabel(draft.tokenAddress)})` : ""}`;
          setError(`Could not save "${what}": ${err instanceof Error ? err.message : "failed"}. Rules before it were saved; the rest are still in the list.`);
          break;
        }
        setDraftRules((drafts) => drafts.filter((d) => d.key !== draft.key));
      }
      // Protection status (e.g. the daily-loss budget shown) depends on active rules - refresh it
      // too, not just the rules list.
      await Promise.all([loadRules(accountId), api.getProtection(accountId).then(setStatus)]);
    } finally {
      setSavingDrafts(false);
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
      await api.createAccount({
        accountId,
        ownerUserId: session.user.id,
        venue: newVenue,
        // An on-chain account's equity is read from the chain, never typed in.
        initialEquity: newIsSafe ? "0" : initialEquity,
        initialRules: newIsSafe ? [] : [{ ruleType: "MAX_POSITION_SIZE", param: maxPositionSize }],
        ...(newIsSafe && evmOwnerWalletAddress && newVenueConfig.chainId
          ? { evmOwnerWalletAddress, evmChainId: newVenueConfig.chainId }
          : {}),
      });
      await Promise.all([loadAccount(accountId), loadAccounts()]);
      setShowNewAccount(false);
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

  async function handleReconcileEvm() {
    if (!accountId) return;
    setError(null);
    setEvmReconciling(true);
    try {
      const result = await api.reconcileEvm(accountId);
      setEvmReconcile({ currentEquity: result.currentEquity, peakEquity: result.peakEquity });
      await loadAccount(accountId);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not refresh on-chain equity");
    } finally {
      setEvmReconciling(false);
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
              Powered by Ighodalo Labs. Risk enforcement for self-custody trading across venues and chains - not a signal service or account manager.
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
        Your rules are enforced per venue: on-chain venues use a Guard contract inside your own Safe wallet, and
        Hyperliquid uses an approved agent wallet. Funds in a Safe are real funds.
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
            <Button onClick={() => setShowNewAccount((v) => !v)}>{showNewAccount ? "Cancel" : "Add account"}</Button>
          </div>

          {accountsLoaded && (
            <div style={{ marginTop: "var(--space-4)" }}>
              {accounts.length === 0 ? (
                <p style={{ fontSize: 13, color: "var(--text-muted)", margin: 0 }}>
                  No accounts yet - click &quot;Add account&quot; to pick a venue and set one up.
                </p>
              ) : (
                <div style={{ display: "grid", gap: "var(--space-2)" }}>
                  {accounts.map((account) => {
                    const accountVenue = getVenue(account.venue);
                    return (
                      <button
                        key={account.accountId}
                        onClick={() => {
                          setAccountId(account.accountId);
                          setEvmReconcile(null);
                          setShowNewAccount(false);
                          void loadAccount(account.accountId);
                        }}
                        style={{
                          display: "flex",
                          justifyContent: "space-between",
                          alignItems: "center",
                          gap: "var(--space-3)",
                          padding: "var(--space-3) var(--space-4)",
                          borderRadius: "var(--radius-md)",
                          border:
                            account.accountId === accountId
                              ? "1px solid var(--color-primary)"
                              : "1px solid var(--border-default)",
                          background: "var(--surface-card)",
                          cursor: "pointer",
                          textAlign: "left",
                          fontFamily: "inherit",
                        }}
                      >
                        <span style={{ fontSize: 14, fontWeight: 600 }}>{account.accountId}</span>
                        <span style={{ display: "flex", gap: "var(--space-2)", alignItems: "center" }}>
                          <span style={{ fontSize: 12, color: "var(--text-muted)" }}>
                            {accountVenue.name}
                            {accountVenue.chainName && accountVenue.chainName !== accountVenue.name
                              ? ` · ${accountVenue.chainName}`
                              : ""}
                          </span>
                          <StatusBadge tone={account.protectionEnabled ? "success" : "neutral"}>
                            {account.protectionEnabled ? "Protected" : "Off"}
                          </StatusBadge>
                        </span>
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          )}
        </Panel>

        {showNewAccount && (
          <Panel title="Add an account">
            <h4 style={{ fontSize: "var(--text-body-md)", fontWeight: 600, marginTop: 0, marginBottom: "var(--space-3)" }}>
              1. Choose a venue
            </h4>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(190px, 1fr))", gap: "var(--space-3)" }}>
              {VENUES.map((v) => (
                <button
                  key={v.id}
                  onClick={() => setNewVenue(v.id)}
                  style={{
                    textAlign: "left",
                    padding: "var(--space-3) var(--space-4)",
                    borderRadius: "var(--radius-md)",
                    border: v.id === newVenue ? "2px solid var(--color-primary)" : "1px solid var(--border-default)",
                    background: "var(--surface-card)",
                    cursor: "pointer",
                    fontFamily: "inherit",
                  }}
                >
                  <div style={{ fontSize: 14, fontWeight: 600 }}>{v.name}</div>
                  <div style={{ fontSize: 12, color: "var(--text-muted)", marginBottom: 6 }}>
                    {v.chainName}
                    {isSafeVenue(v) ? " · on-chain Safe" : " · agent wallet"}
                  </div>
                  <div style={{ fontSize: 12, color: "var(--text-muted)" }}>{v.summary}</div>
                </button>
              ))}
            </div>

            <h4 style={{ fontSize: "var(--text-body-md)", fontWeight: 600, margin: "var(--space-5) 0 var(--space-3)" }}>
              2. Account details
            </h4>
            <div style={{ display: "flex", gap: "var(--space-3)", flexWrap: "wrap", alignItems: "flex-end" }}>
              <Input
                label="Account name"
                value={accountId}
                onChange={(e: React.ChangeEvent<HTMLInputElement>) => setAccountId(e.target.value)}
                placeholder="acct_my_first"
              />
              {!newIsSafe && (
                <Input
                  label="Starting equity ($)"
                  value={initialEquity}
                  onChange={(e: React.ChangeEvent<HTMLInputElement>) => setInitialEquity(e.target.value)}
                />
              )}
              {!newIsSafe && (
                <Input
                  label="Max position size ($)"
                  value={maxPositionSize}
                  onChange={(e: React.ChangeEvent<HTMLInputElement>) => setMaxPositionSize(e.target.value)}
                />
              )}
            </div>

            {newIsSafe && (
              <div style={{ marginTop: "var(--space-3)" }}>
                <Input
                  label={`Your wallet address (owner of the Safe on ${newVenueConfig.chainName})`}
                  value={evmOwnerWalletAddress}
                  onChange={(e: React.ChangeEvent<HTMLInputElement>) => setEvmOwnerWalletAddress(e.target.value)}
                  placeholder="0x..."
                  helpText="Use a wallet you control and sign with. It becomes the Safe's sole owner - MyPropGuard never holds its key and can never move your funds."
                />
              </div>
            )}

            <div style={{ marginTop: "var(--space-4)" }}>
              <Button onClick={handleCreateAccount} disabled={!accountId || (newIsSafe && !evmOwnerWalletAddress)}>
                Create account
              </Button>
            </div>
          </Panel>
        )}

        {status && selectedAccount && (
          <Panel title={`${venue.name}${venue.chainName && venue.chainName !== venue.name ? ` · ${venue.chainName}` : ""}`}>
            <p style={{ marginTop: 0, fontSize: 13, color: "var(--text-muted)" }}>
              Account <strong>{selectedAccount.accountId}</strong> · {venue.summary}
            </p>

            {isSafeVenue(venue) ? (
              <div style={{ display: "grid", gap: "var(--space-3)", fontSize: 13 }}>
                {selectedAccount.evmSafeAddress ? (
                  <div>
                    <div style={{ fontWeight: 600, marginBottom: 4 }}>Your Safe wallet ({venue.chainName})</div>
                    <code style={{ fontFamily: "var(--font-accent)", wordBreak: "break-all" }}>
                      {selectedAccount.evmSafeAddress}
                    </code>
                    {venue.explorerUrl && (
                      <div style={{ marginTop: 4 }}>
                        <a href={`${venue.explorerUrl}${selectedAccount.evmSafeAddress}`} target="_blank" rel="noreferrer">
                          View on block explorer
                        </a>
                      </div>
                    )}
                  </div>
                ) : (
                  <p style={{ margin: 0, color: "var(--text-muted)" }}>
                    No Safe was provisioned for this account yet. This venue&apos;s on-chain provisioning may not be
                    enabled on this server.
                  </p>
                )}

                <div>
                  <div style={{ fontWeight: 600, marginBottom: 4 }}>How to trade</div>
                  <ol style={{ margin: 0, paddingLeft: 18, color: "var(--text-muted)", display: "grid", gap: 4 }}>
                    <li>
                      Send some {venue.nativeSymbol ?? "native token"} to the Safe address above. Start with a small
                      amount.
                    </li>
                    <li>Open app.safe.global on {venue.chainName}, add your Safe, and sign in with your owner wallet.</li>
                    <li>
                      On {venue.exchangeName}&apos;s site choose WalletConnect, copy the link, and paste it into the
                      WalletConnect option in the Safe app.
                    </li>
                    <li>
                      Trade as usual, then sign and execute each transaction in the Safe app with your owner wallet.
                      Keep a little {venue.nativeSymbol ?? "native token"} in your owner wallet for gas.
                    </li>
                  </ol>
                </div>

                {venue.supportedRoutes && (
                  <div>
                    <div style={{ fontWeight: 600, marginBottom: 4 }}>Supported today</div>
                    <ul style={{ margin: 0, paddingLeft: 18, color: "var(--text-muted)" }}>
                      {venue.supportedRoutes.map((route) => (
                        <li key={route}>{route}</li>
                      ))}
                    </ul>
                    {venue.unsupportedNote && (
                      <p style={{ margin: "6px 0 0", color: "var(--text-muted)" }}>{venue.unsupportedNote}</p>
                    )}
                  </div>
                )}
              </div>
            ) : (
              <div style={{ fontSize: 13 }}>
                {selectedAccount.agentWalletAddress ? (
                  <>
                    <div style={{ fontWeight: 600, marginBottom: 4 }}>Approve this wallet on Hyperliquid</div>
                    <div style={{ color: "var(--text-muted)", marginBottom: 6 }}>
                      Go to Hyperliquid&apos;s site → API tab → Approve Agent, and paste this address. This lets this
                      account trade under your risk rules, not through a shared key.
                    </div>
                    <code style={{ fontFamily: "var(--font-accent)", wordBreak: "break-all" }}>
                      {selectedAccount.agentWalletAddress}
                    </code>
                  </>
                ) : (
                  <p style={{ margin: 0, color: "var(--text-muted)" }}>No agent wallet has been provisioned for this account.</p>
                )}
              </div>
            )}
          </Panel>
        )}

        {status && (
          <Panel title="Protection status">
            <div style={{ display: "flex", gap: "var(--space-2)", flexWrap: "wrap", marginBottom: "var(--space-4)" }}>
              <StatusBadge tone={status.protectionOn ? "success" : "neutral"}>
                {status.protectionOn ? "Protection on" : "Protection off"}
              </StatusBadge>
              <StatusBadge tone={status.botCanOpenNewTrades ? "success" : "warning"}>
                {isSafeVenue(venue)
                  ? status.botCanOpenNewTrades
                    ? "Trading allowed"
                    : "Trading paused"
                  : status.botCanOpenNewTrades
                    ? "Bot can trade"
                    : "Bot paused"}
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
              {isSafeVenue(venue)
                ? "The mandate pushed to this account's Guard contract on-chain. Changes are sent as a transaction by MyPropGuard and apply to the next trade."
                : "The mandate this account is checked against on every order. Deactivating a rule takes effect immediately."}
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
                      <div style={{ fontSize: 14, fontWeight: 600 }}>{ruleTypeLabel(rule.ruleType, venue)}</div>
                      <div style={{ fontSize: 12, color: "var(--text-muted)" }}>
                        Limit: {rule.param}
                        {rule.tokenAddress ? ` (token ${rule.tokenAddress})` : ""}
                      </div>
                    </div>
                    <Button variant="subtle" size="sm" onClick={() => handleDeactivateRule(rule.id)}>
                      Deactivate
                    </Button>
                  </div>
                ))}
              </div>
            )}

            <div style={{ paddingTop: "var(--space-4)", borderTop: "1px solid var(--border-default)" }}>
              <h4 style={{ fontSize: "var(--text-body-md)", fontWeight: 600, marginBottom: "var(--space-3)" }}>Add rules</h4>
              <div style={{ display: "flex", gap: "var(--space-3)", flexWrap: "wrap", alignItems: "flex-end" }}>
                <Select
                  label="Rule type"
                  options={ruleOptions}
                  value={activeRuleType}
                  onChange={(e: React.ChangeEvent<HTMLSelectElement>) => setNewRuleType(e.target.value)}
                />
                <Input
                  label="Limit"
                  value={newRuleParam}
                  onChange={(e: React.ChangeEvent<HTMLInputElement>) => setNewRuleParam(e.target.value)}
                  placeholder="e.g. 500"
                />
                {activeRuleType === "MAX_POSITION_SIZE" && isEvmSafeAccount && (
                  <>
                    <Select
                      label="Token"
                      options={[
                        ...venueTokens.map((t) => ({
                          value: t.address,
                          label: `${t.symbol}${t.note ? ` (${t.note})` : ""}`,
                        })),
                        { value: "custom", label: "Other token (paste address)" },
                      ]}
                      value={effectiveTokenChoice}
                      onChange={(e: React.ChangeEvent<HTMLSelectElement>) => setTokenChoice(e.target.value)}
                    />
                    {effectiveTokenChoice === "custom" && (
                      <Input
                        label="Token address"
                        value={newRuleTokenAddress}
                        onChange={(e: React.ChangeEvent<HTMLInputElement>) => setNewRuleTokenAddress(e.target.value)}
                        placeholder="0x... (the ERC-20 this limit applies to)"
                      />
                    )}
                  </>
                )}
                <Button
                  variant="secondary"
                  onClick={() => {
                    if (activeRuleType !== newRuleType) setNewRuleType(activeRuleType);
                    handleAddDraft(activeRuleType, activeRuleType === "MAX_POSITION_SIZE" && isEvmSafeAccount ? effectiveTokenAddress : "");
                  }}
                  disabled={!newRuleParam || savingDrafts || (activeRuleType === "MAX_POSITION_SIZE" && isEvmSafeAccount && !effectiveTokenAddress)}
                >
                  Add to list
                </Button>
              </div>

              {draftRules.length > 0 && (
                <div style={{ marginTop: "var(--space-4)", display: "grid", gap: "var(--space-2)" }}>
                  <div style={{ fontSize: 13, fontWeight: 600 }}>Ready to save ({draftRules.length})</div>
                  {draftRules.map((draft) => (
                    <div
                      key={draft.key}
                      style={{
                        display: "flex",
                        justifyContent: "space-between",
                        alignItems: "center",
                        gap: "var(--space-3)",
                        padding: "var(--space-2) var(--space-3)",
                        borderRadius: "var(--radius-md)",
                        border: "1px dashed var(--border-default)",
                        fontSize: 13,
                      }}
                    >
                      <span>
                        {ruleTypeLabel(draft.ruleType, venue)}: <strong>{draft.param}</strong>
                        {draft.tokenAddress ? ` · ${draftTokenLabel(draft.tokenAddress)}` : ""}
                      </span>
                      <Button variant="subtle" size="sm" onClick={() => removeDraft(draft.key)} disabled={savingDrafts}>
                        Remove
                      </Button>
                    </div>
                  ))}
                  <div>
                    <Button onClick={handleSaveDrafts} disabled={savingDrafts}>
                      {savingDrafts ? "Saving…" : `Save all rules (${draftRules.length})`}
                    </Button>
                    {isSafeVenue(venue) && (
                      <span style={{ marginLeft: "var(--space-3)", fontSize: 12, color: "var(--text-muted)" }}>
                        Each rule is sent on-chain, so saving takes a few seconds per rule.
                      </span>
                    )}
                  </div>
                </div>
              )}
              {activeRuleType === "MAX_POSITION_SIZE" && isEvmSafeAccount && (
                <p style={{ marginTop: "var(--space-2)", fontSize: 12, color: "var(--text-muted)" }}>
                  The limit is in units of the token you spend (for example 5 for 5 USDT, or 0.0006 for 0.0006
                  {venue.nativeSymbol ?? "native coin"}), pushed directly to the Guard contract and enforced for every
                  buy that spends that token, whichever site it comes from. Set a limit for each token you buy
                  with. Selling back to {venue.nativeSymbol ?? "the native coin"} is never limited.
                </p>
              )}
            </div>
          </Panel>
        )}

        {status && isSafeVenue(venue) && (
          <Panel title="On-chain balance">
            <p style={{ marginTop: 0, fontSize: 13, color: "var(--text-muted)" }}>
              Reads this Safe&apos;s balances on {venue.chainName} and updates the equity used for the max-daily-loss
              rule. If the loss limit is breached, the Safe cannot buy until the next UTC day, but it can still sell
              back to {venue.nativeSymbol ?? "the native token"}.
            </p>
            <Button variant="secondary" onClick={handleReconcileEvm} disabled={evmReconciling}>
              {evmReconciling ? "Reading chain…" : "Refresh on-chain balance"}
            </Button>
            {evmReconcile && (
              <div style={{ marginTop: "var(--space-4)", fontSize: 13, color: "var(--text-muted)" }}>
                Equity ${evmReconcile.currentEquity}, peak ${evmReconcile.peakEquity}
              </div>
            )}
          </Panel>
        )}

        {status && !isSafeVenue(venue) && (
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

        {status && !isSafeVenue(venue) && (
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
