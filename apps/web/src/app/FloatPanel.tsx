"use client";

import { useCallback, useEffect, useState } from "react";
import { Button } from "@/design-system/components/core/Button";
import { Panel } from "@/design-system/Panel";
import { StatusBadge } from "@/design-system/StatusBadge";
import { api, type FloatStatus } from "@/lib/api";
import { WalletConnectLinkBox } from "./WalletConnectLinkBox";

/** Wei -> "0.25", exactly (no floating point), trailing zeros dropped. */
function bnb(wei: string | bigint | undefined): string {
  if (wei === undefined) return "0";
  const v = BigInt(wei);
  const whole = v / 10n ** 18n;
  const frac = (v % 10n ** 18n).toString().padStart(18, "0").replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : `${whole}`;
}

const PRESETS = ["0.1", "0.25", "0.5", "1"];

const input: React.CSSProperties = {
  width: 110,
  padding: "var(--space-2)",
  borderRadius: "var(--radius-md)",
  border: "1px solid var(--border-default)",
  fontFamily: "var(--font-accent)",
  fontSize: 12,
};
const row: React.CSSProperties = {
  display: "flex",
  justifyContent: "space-between",
  gap: "var(--space-3)",
  padding: "var(--space-2) var(--space-3)",
  borderRadius: "var(--radius-md)",
  border: "1px solid var(--border-default)",
  fontSize: 12,
};

/**
 * The trading wallet: a wallet MyPropGuard holds that four.meme (and sites like it) can log in to, which a Safe cannot do.
 * The owner chooses the float (how much goes in) and the rules; every trade the site proposes is judged by those rules on
 * the server before it is signed, and the only place the money can go back to is the owner's own Safe.
 */
export function FloatPanel({ accountId, siteName }: { accountId: string; siteName?: string }) {
  const [state, setState] = useState<FloatStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [floatInput, setFloatInput] = useState("0.25");
  const [form, setForm] = useState({ float: "", maxBuy: "", dailySpend: "", maxBuysPerDay: "", cooldownSec: "" });
  const [editing, setEditing] = useState(false);
  const [copied, setCopied] = useState(false);
  const site = siteName ?? "four.meme";

  const refresh = useCallback(async () => {
    try {
      setState(await api.getFloat(accountId));
      setError(null);
    } catch (e) {
      // 404 = trading wallets are switched off on this server: show nothing rather than an error.
      setState(null);
      if (e instanceof Error && !/not found|404/i.test(e.message)) setError(e.message);
    }
  }, [accountId]);

  useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), 8000);
    return () => clearInterval(timer);
  }, [refresh]);

  // Fill the settings form from the server unless the owner is in the middle of editing it.
  useEffect(() => {
    if (!state?.exists || editing || !state.limits) return;
    setForm({
      float: bnb(state.floatWei),
      maxBuy: bnb(state.limits.maxBuyWei),
      dailySpend: bnb(state.limits.dailySpendWei),
      maxBuysPerDay: String(state.limits.maxBuysPerDay),
      cooldownSec: String(state.limits.cooldownSec),
    });
  }, [state, editing]);

  async function run(label: string, work: () => Promise<string | void>) {
    setBusy(true);
    setError(null);
    setNote(label);
    let done: string | null = null;
    try {
      done = (await work()) ?? null;
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setNote(done);
      setBusy(false);
      void refresh();
    }
  }

  const describeSweep = (items: Array<{ asset: string; amount: string; error: string | null }>) => {
    if (items.length === 0) return "Nothing to withdraw: the wallet was empty.";
    const failed = items.filter((i) => i.error);
    const sent = items.filter((i) => !i.error);
    return `Withdrew ${sent.length} item${sent.length === 1 ? "" : "s"} back to your MyPropGuard account.${failed.length ? ` ${failed.length} could not be withdrawn: ${failed[0]!.error}` : ""}`;
  };

  if (!state?.available) return error ? <Panel title="Trading wallet"><p style={{ color: "var(--text-muted)", fontSize: 13 }}>{error}</p></Panel> : null;
  const symbol = state.nativeSymbol;

  if (!state.exists) {
    return (
      <Panel title="Your MyPropGuard wallet">
        <p style={{ marginTop: 0, fontSize: 13, color: "var(--text-muted)" }}>
          This is the wallet you trade with on {site}. Put in as much as you want to trade with, connect {site} once, and
          trade there as normal. MyPropGuard checks every trade against your limits first, and you can withdraw everything
          whenever you like.
        </p>
        <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 4 }}>How much do you want to trade with?</div>
        <div style={{ display: "flex", gap: "var(--space-2)", flexWrap: "wrap", alignItems: "center" }}>
          {PRESETS.map((p) => (
            <Button key={p} variant={floatInput === p ? "primary" : "subtle"} size="sm" onClick={() => setFloatInput(p)} disabled={busy}>
              {p} {symbol}
            </Button>
          ))}
          <input value={floatInput} onChange={(e) => setFloatInput(e.target.value)} style={input} aria-label={`Float in ${symbol}`} />
          <span style={{ fontSize: 12, color: "var(--text-muted)" }}>{symbol}</span>
          <Button disabled={busy || !floatInput.trim()} onClick={() => void run("Creating…", async () => void (await api.createFloat(accountId, floatInput.trim())))}>
            Create my wallet
          </Button>
        </div>
        <p style={{ fontSize: 12, color: "var(--text-muted)" }}>You can change this amount and your limits later. Nothing moves until you deposit {symbol} yourself.</p>
        {note && <p style={{ fontSize: 13, marginBottom: 0 }}>{note}</p>}
        {error && <p style={{ fontSize: 13, color: "var(--danger, #b42318)", marginBottom: 0 }}>{error}</p>}
      </Panel>
    );
  }

  const on = state.status === "active";
  const limits = state.limits!;
  const balance = BigInt(state.balanceWei ?? "0");
  const floatWei = BigInt(state.floatWei ?? "0");
  const short = balance < floatWei;

  return (
    <Panel title="Your MyPropGuard wallet">
      <div style={{ display: "flex", gap: "var(--space-2)", flexWrap: "wrap", marginBottom: "var(--space-3)" }}>
        <StatusBadge tone={on ? "success" : "neutral"}>{on ? "Wallet is on" : "Paused"}</StatusBadge>
        {on && limits.frozen && <StatusBadge tone="danger">Buying is paused: selling still works</StatusBadge>}
      </div>

      <div style={{ display: "grid", gap: "var(--space-3)" }}>
        <div>
          <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 4 }}>Your wallet</div>
          <div style={{ display: "flex", gap: "var(--space-2)", alignItems: "center", flexWrap: "wrap" }}>
            <code style={{ fontSize: 12, wordBreak: "break-all" }}>{state.address}</code>
            <Button
              variant="subtle"
              size="sm"
              onClick={() => {
                void navigator.clipboard?.writeText(state.address ?? "").then(() => {
                  setCopied(true);
                  setTimeout(() => setCopied(false), 1500);
                });
              }}
            >
              {copied ? "Copied" : "Copy"}
            </Button>
          </div>
          <p style={{ fontSize: 13, margin: "var(--space-2) 0 0", color: "var(--text-muted)" }}>
            Balance: <strong>{bnb(balance)} {symbol}</strong>. Your trading amount is {bnb(floatWei)} {symbol}.
            {short && ` To trade the full amount, deposit ${bnb(floatWei - balance)} ${symbol} to this address (BNB Chain).`}
          </p>
        </div>

        {state.holdings && state.holdings.length > 0 && (
          <div style={{ display: "grid", gap: "var(--space-2)" }}>
            <div style={{ fontSize: 13, fontWeight: 600 }}>Tokens in your wallet</div>
            {state.holdings.map((h) => (
              <div key={h.token} style={row}>
                <strong>{h.symbol}</strong>
                <span style={{ fontFamily: "var(--font-accent)" }}>{(Number(h.balance) / 10 ** h.decimals).toLocaleString(undefined, { maximumFractionDigits: 4 })}</span>
              </div>
            ))}
          </div>
        )}

        <div>
          <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 4 }}>Your amount and limits</div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(190px, 1fr))", gap: "var(--space-2)", fontSize: 12 }}>
            {(
              [
                ["float", `Trading amount (${symbol})`],
                ["maxBuy", `Biggest single buy (${symbol})`],
                ["dailySpend", `Most spent per day (${symbol})`],
                ["maxBuysPerDay", "Buys per day"],
                ["cooldownSec", "Pause between buys (seconds)"],
              ] as const
            ).map(([key, label]) => (
              <label key={key} style={{ display: "grid", gap: 2 }}>
                <span style={{ color: "var(--text-muted)" }}>{label}</span>
                <input
                  value={form[key]}
                  onChange={(e) => {
                    setEditing(true);
                    setForm({ ...form, [key]: e.target.value });
                  }}
                  style={{ ...input, width: "100%", boxSizing: "border-box" }}
                />
              </label>
            ))}
          </div>
          <div style={{ display: "flex", gap: "var(--space-2)", marginTop: "var(--space-2)", flexWrap: "wrap" }}>
            <Button
              disabled={busy || !editing}
              onClick={() =>
                void run("Saving…", async () => {
                  await api.updateFloat(accountId, {
                    float: form.float,
                    maxBuy: form.maxBuy,
                    dailySpend: form.dailySpend,
                    maxBuysPerDay: Number(form.maxBuysPerDay),
                    cooldownSec: Number(form.cooldownSec),
                  });
                  setEditing(false);
                  return "Saved. The new rules apply from the next trade.";
                })
              }
            >
              Save changes
            </Button>
            <Button variant="subtle" disabled={busy} onClick={() => void run(limits.frozen ? "Resuming…" : "Pausing…", () => api.freezeFloat(accountId, !limits.frozen).then(() => undefined))}>
              {limits.frozen ? "Resume buying" : "Pause buying"}
            </Button>
          </div>
          <p style={{ fontSize: 12, color: "var(--text-muted)", margin: "var(--space-2) 0 0" }}>
            Selling is never blocked. A buy is refused once you reach a limit, or if it would leave too little {symbol} to pay the fee to sell.
          </p>
        </div>

        {on && (
          <WalletConnectLinkBox
            siteName={site}
            busy={busy}
            onLink={async (code) => {
              setBusy(true);
              setNote("Linking…");
              try {
                const result = await api.pairFloat(accountId, code);
                setNote(result.message);
                await new Promise((resolve) => setTimeout(resolve, 6000));
              } finally {
                setNote(null);
                setBusy(false);
                void refresh();
              }
            }}
          />
        )}

        {state.links && state.links.length > 0 && (
          <div style={{ display: "grid", gap: "var(--space-2)" }}>
            <div style={{ fontSize: 13, fontWeight: 600 }}>Connected sites</div>
            {state.links.map((l) => (
              <div key={l.topic} style={{ ...row, alignItems: "center" }}>
                <span>
                  <strong>{l.name ?? "Unknown site"}</strong> {l.url ? `· ${l.url}` : ""}
                </span>
                <Button variant="subtle" size="sm" disabled={busy} onClick={() => void run("Disconnecting…", () => api.disconnectFloat(accountId, l.topic).then(() => undefined))}>
                  Disconnect
                </Button>
              </div>
            ))}
          </div>
        )}

        {state.trades && state.trades.length > 0 && (
          <div style={{ display: "grid", gap: "var(--space-2)" }}>
            <div style={{ fontSize: 13, fontWeight: 600 }}>Recent activity</div>
            {state.trades.map((t, i) => (
              <div key={`${t.at}-${i}`} style={row}>
                <span>
                  <strong>{t.result === "SENT" ? (t.kind === "login" ? "Signed in" : t.kind === "sweep" ? "Withdrawn" : "Sent") : t.result === "REFUSED" ? "Blocked" : "Failed"}</strong>
                  {t.kind !== "login" && t.kind !== "sweep" ? ` ${t.kind}` : ""}
                  {t.site ? ` · ${t.site}` : ""}
                  {t.valueWei && t.valueWei !== "0" ? ` · ${bnb(t.valueWei)} ${symbol}` : ""}
                  {t.message ? ` · ${t.message}` : ""}
                  {t.totalMs !== null && t.result === "SENT" && t.kind === "buy" ? ` · checked and sent in ${t.totalMs} ms` : ""}
                </span>
                <span style={{ color: "var(--text-muted)", whiteSpace: "nowrap" }}>{new Date(t.at).toLocaleTimeString()}</span>
              </div>
            ))}
          </div>
        )}

        <div style={{ display: "flex", gap: "var(--space-2)", flexWrap: "wrap" }}>
          <Button
            variant="subtle"
            size="sm"
            disabled={busy}
            onClick={() => void run("Withdrawing…", async () => describeSweep((await api.sweepFloat(accountId)).items))}
          >
            Withdraw everything
          </Button>
          {on ? (
            <Button
              variant="subtle"
              size="sm"
              disabled={busy}
              onClick={() => void run("Switching off and withdrawing…", async () => describeSweep((await api.switchFloat(accountId, false)).items ?? []))}
            >
              Switch off and withdraw
            </Button>
          ) : (
            <Button variant="subtle" size="sm" disabled={busy} onClick={() => void run("Switching on…", () => api.switchFloat(accountId, true).then(() => undefined))}>
              Switch on
            </Button>
          )}
        </div>
      </div>

      {note && <p style={{ fontSize: 13, marginBottom: 0 }}>{note}</p>}
      {error && <p style={{ fontSize: 13, color: "var(--danger, #b42318)", marginBottom: 0 }}>{error}</p>}
    </Panel>
  );
}
