"use client";

import { useCallback, useEffect, useState } from "react";
import { Button } from "@/design-system/components/core/Button";
import { Panel } from "@/design-system/Panel";
import { StatusBadge } from "@/design-system/StatusBadge";
import { api, type SolanaStatus, type SolanaWithdrawResult } from "@/lib/api";
import { accountRuleLines } from "@/lib/accountRuleLines";
import { WalletConnectLinkBox } from "./WalletConnectLinkBox";

/** Lamports -> "0.25 SOL", exactly (no floating point). */
function sol(lamports: string | bigint | null | undefined): string {
  if (lamports === null || lamports === undefined) return "…";
  const v = BigInt(lamports);
  const whole = v / 1_000_000_000n;
  const frac = (v % 1_000_000_000n).toString().padStart(9, "0").replace(/0+$/, "").slice(0, 6);
  return `${whole}${frac ? `.${frac}` : ""} SOL`;
}
const shortKey = (key: string) => `${key.slice(0, 4)}…${key.slice(-4)}`;

const input: React.CSSProperties = {
  width: "100%",
  boxSizing: "border-box",
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

type Request = NonNullable<SolanaStatus["requests"]>[number];

/** What the owner sees for one thing a site asked for. */
function describe(r: Request): { label: string; text: string } {
  if (r.kind === "login") {
    return { label: r.result === "SIGNED" ? "Signed in" : r.result === "REFUSED" ? "Login refused" : "Login failed", text: r.result === "REFUSED" ? (r.message ?? "") : "" };
  }
  if (r.kind === "sweep") {
    return { label: r.result === "SIGNED" ? "Withdrew" : r.result === "REFUSED" ? "Left in wallet" : "Withdrawal failed", text: r.result === "SIGNED" ? (r.lamports ? sol(r.lamports) : "a coin") : (r.message ?? "") };
  }
  if (r.kind === "transaction") {
    if (r.result === "SIGNED") {
      const what = r.tradeKind === "sell" ? "Sold" : "Bought";
      const detail = [r.mint ? shortKey(r.mint) : null, r.tradeKind === "buy" && r.lamports ? `up to ${sol(r.lamports)}` : null, r.totalMs !== null ? `checked and signed in ${r.totalMs} ms` : null].filter(Boolean).join(" · ");
      return { label: what, text: detail };
    }
    return { label: r.result === "REFUSED" ? "Blocked" : "Failed", text: r.message ?? "" };
  }
  return { label: r.result === "ERROR" ? "Failed" : "Request", text: r.message ?? r.method };
}

/**
 * The Solana wallet (for pump.fun and similar). The owner deposits SOL, connects the site, and trades there as normal.
 * Every transaction the site sends is judged on the server before it is signed, and money can only be withdrawn to the one
 * address the owner sets.
 */
export function SolanaPanel({ accountId }: { accountId: string }) {
  const [state, setState] = useState<SolanaStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const [open, setOpen] = useState<number | null>(null);
  const [form, setForm] = useState({ maxBuyPct: "", dailySpendPct: "", maxBuysPerDay: "", cooldownSec: "" });
  const [editing, setEditing] = useState(false);
  const [address, setAddress] = useState("");

  const refresh = useCallback(async () => {
    try {
      setState(await api.getSolana(accountId));
      setError(null);
    } catch (e) {
      // 404 = Solana wallets are switched off on this server: show nothing rather than an error.
      setState(null);
      if (e instanceof Error && !/not found|404/i.test(e.message)) setError(e.message);
    }
  }, [accountId]);

  useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), 8000);
    return () => clearInterval(timer);
  }, [refresh]);

  // Fill the forms from the server unless the owner is in the middle of typing.
  useEffect(() => {
    if (!state?.exists || !state.limits || editing) return;
    setForm({ maxBuyPct: String(state.limits.maxBuyPct), dailySpendPct: String(state.limits.dailySpendPct), maxBuysPerDay: String(state.limits.maxBuysPerDay), cooldownSec: String(state.limits.cooldownSec) });
  }, [state, editing]);
  useEffect(() => {
    if (state?.withdrawalAddress) setAddress((current) => current || state.withdrawalAddress!);
  }, [state?.withdrawalAddress]);

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

  const describeWithdrawal = (r: SolanaWithdrawResult): string => {
    const items = r.items ?? [];
    if (items.length === 0) return "Nothing to withdraw: the wallet was empty.";
    const failed = items.filter((i) => i.error);
    const left = items.filter((i) => i.skipped);
    const sent = items.filter((i) => i.signature);
    return `Withdrew ${sent.length} item${sent.length === 1 ? "" : "s"} to ${r.to ? shortKey(r.to) : "your address"}.${failed.length ? ` ${failed.length} could not be withdrawn: ${failed[0]!.error}` : ""}${left.length ? ` ${left.length} coin${left.length === 1 ? " has" : "s have"} no market value and stayed in the wallet.` : ""}`;
  };

  if (!state?.available) return error ? <Panel title="Your Solana wallet"><p style={{ color: "var(--text-muted)", fontSize: 13 }}>{error}</p></Panel> : null;

  if (!state.exists) {
    return (
      <Panel title="Your Solana wallet">
        <p style={{ marginTop: 0, fontSize: 13, color: "var(--text-muted)" }}>
          A wallet for Solana sites such as pump.fun. Deposit SOL, connect the site once, and trade there as normal. MyPropGuard
          checks every trade against your limits first, and you can withdraw everything to your own address whenever you like.
        </p>
        <Button disabled={busy} onClick={() => void run("Creating…", async () => void (await api.createSolana(accountId)))}>
          Create my Solana wallet
        </Button>
        {note && <p style={{ fontSize: 13, marginBottom: 0 }}>{note}</p>}
        {error && <p style={{ fontSize: 13, color: "var(--danger, #b42318)", marginBottom: 0 }}>{error}</p>}
      </Panel>
    );
  }

  const on = state.status === "active";
  const limits = state.limits!;
  const trading = state.tradingEnabled === true;
  const balance = state.balanceLamports === null || state.balanceLamports === undefined ? null : BigInt(state.balanceLamports);
  const ruleLines = accountRuleLines(state.accountRules);

  return (
    <Panel title="Your Solana wallet">
      <div style={{ display: "flex", gap: "var(--space-2)", flexWrap: "wrap", marginBottom: "var(--space-3)" }}>
        <StatusBadge tone={on ? "success" : "neutral"}>{on ? "Wallet is on" : "Paused"}</StatusBadge>
        <StatusBadge tone={trading ? "success" : "neutral"}>{trading ? "Trading is on" : "Trading is not switched on yet"}</StatusBadge>
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
            Balance: <strong>{balance === null ? "could not be read just now" : sol(balance)}</strong>.{" "}
            {trading ? (balance === 0n ? "Deposit SOL to this address (Solana) to start trading." : "Everything you trade with stays here while you trade.") : "Trading is not switched on yet, so do not deposit."}
          </p>
        </div>

        {state.holdings && state.holdings.length > 0 && (
          <div style={{ display: "grid", gap: "var(--space-2)" }}>
            <div style={{ fontSize: 13, fontWeight: 600 }}>Coins in your wallet</div>
            {state.holdings.map((h) => (
              <div key={h.mint} style={row}>
                <code>{shortKey(h.mint)}</code>
                <span>worth about {sol(h.valueLamports)}</span>
              </div>
            ))}
          </div>
        )}

        <div>
          <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 4 }}>Your limits</div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(190px, 1fr))", gap: "var(--space-2)", fontSize: 12 }}>
            {(
              [
                ["maxBuyPct", "Biggest single buy (% of wallet)"],
                ["dailySpendPct", "Most spent per day (% of wallet)"],
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
                  style={input}
                />
              </label>
            ))}
          </div>
          <div style={{ display: "flex", gap: "var(--space-2)", marginTop: "var(--space-2)", flexWrap: "wrap" }}>
            <Button
              disabled={busy || !editing}
              onClick={() =>
                void run("Saving…", async () => {
                  await api.updateSolana(accountId, { maxBuyPct: Number(form.maxBuyPct), dailySpendPct: Number(form.dailySpendPct), maxBuysPerDay: Number(form.maxBuysPerDay), cooldownSec: Number(form.cooldownSec) });
                  setEditing(false);
                  return "Saved. The new limits apply from the next trade.";
                })
              }
            >
              Save changes
            </Button>
            <Button variant="subtle" disabled={busy} onClick={() => void run(limits.frozen ? "Resuming…" : "Pausing…", () => api.freezeSolana(accountId, !limits.frozen).then(() => undefined))}>
              {limits.frozen ? "Resume buying" : "Pause buying"}
            </Button>
          </div>
          {ruleLines.length > 0 && (
            <div style={{ fontSize: 12, color: "var(--text-muted)", margin: "var(--space-2) 0 0" }}>
              Your MyPropGuard account rules also apply to this wallet (the stricter limit wins):
              <ul style={{ margin: "4px 0 0", paddingLeft: 18 }}>
                {ruleLines.map((line) => (
                  <li key={line}>{line}</li>
                ))}
              </ul>
            </div>
          )}
          <p style={{ fontSize: 12, color: "var(--text-muted)", margin: "var(--space-2) 0 0" }}>
            Selling is never blocked. A buy is refused once you reach a limit, or if it would leave too little SOL to pay fees.
          </p>
        </div>

        <div>
          <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 4 }}>Your withdrawal address</div>
          <div style={{ display: "flex", gap: "var(--space-2)", flexWrap: "wrap" }}>
            <input value={address} onChange={(e) => setAddress(e.target.value)} placeholder="Your own Solana wallet address" style={{ ...input, flex: 1, width: "auto" }} />
            <Button
              variant="subtle"
              disabled={busy || !address.trim() || address.trim() === state.withdrawalAddress}
              onClick={() => void run("Saving…", async () => void (await api.setSolanaWithdrawalAddress(accountId, address.trim())))}
            >
              Save address
            </Button>
          </div>
          <p style={{ fontSize: 12, color: "var(--text-muted)", margin: "var(--space-2) 0 0" }}>
            Withdrawals only ever go to this address. Use a wallet you control, and check it twice.
          </p>
        </div>

        {on && (
          <WalletConnectLinkBox
            siteName="pump.fun"
            busy={busy}
            onLink={async (code) => {
              setBusy(true);
              setNote("Linking…");
              try {
                const result = await api.pairSolana(accountId, code);
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
                <Button variant="subtle" size="sm" disabled={busy} onClick={() => void run("Disconnecting…", () => api.disconnectSolana(accountId, l.topic).then(() => undefined))}>
                  Disconnect
                </Button>
              </div>
            ))}
          </div>
        )}

        {state.requests && state.requests.length > 0 && (
          <div style={{ display: "grid", gap: "var(--space-2)" }}>
            <div style={{ fontSize: 13, fontWeight: 600 }}>Recent activity</div>
            {state.requests.map((r, i) => {
              const d = describe(r);
              return (
                <div key={`${r.at}-${i}`} style={{ ...row, flexDirection: "column", gap: 4 }}>
                  <div style={{ display: "flex", justifyContent: "space-between", gap: "var(--space-3)" }}>
                    <span>
                      <strong>{d.label}</strong>
                      {r.site ? ` · ${r.site}` : ""}
                      {d.text ? ` · ${d.text}` : ""}
                    </span>
                    <span style={{ color: "var(--text-muted)", whiteSpace: "nowrap" }}>{new Date(r.at).toLocaleTimeString()}</span>
                  </div>
                  {r.detail !== null && (
                    <>
                      <button type="button" onClick={() => setOpen(open === i ? null : i)} style={{ all: "unset", cursor: "pointer", color: "var(--text-muted)", textDecoration: "underline" }}>
                        {open === i ? "Hide details" : "Show details"}
                      </button>
                      {open === i && <pre style={{ margin: 0, maxHeight: 220, overflow: "auto", whiteSpace: "pre-wrap", wordBreak: "break-all", fontSize: 11 }}>{JSON.stringify(r.detail, null, 2)}</pre>}
                    </>
                  )}
                </div>
              );
            })}
          </div>
        )}

        <div style={{ display: "flex", gap: "var(--space-2)", flexWrap: "wrap" }}>
          <Button
            variant="subtle"
            size="sm"
            disabled={busy || !state.withdrawalAddress}
            onClick={() => void run("Withdrawing…", async () => describeWithdrawal(await api.withdrawSolana(accountId)))}
          >
            Withdraw everything
          </Button>
          {on ? (
            <Button variant="subtle" size="sm" disabled={busy} onClick={() => void run("Switching off…", async () => describeWithdrawal(await api.switchSolana(accountId, false)))}>
              {state.withdrawalAddress ? "Switch off and withdraw" : "Switch off and disconnect"}
            </Button>
          ) : (
            <Button variant="subtle" size="sm" disabled={busy} onClick={() => void run("Switching on…", () => api.switchSolana(accountId, true).then(() => undefined))}>
              Switch on
            </Button>
          )}
        </div>
        {!state.withdrawalAddress && <p style={{ fontSize: 12, color: "var(--text-muted)", margin: 0 }}>Set your withdrawal address above to be able to withdraw.</p>}
      </div>

      {note && <p style={{ fontSize: 13, marginBottom: 0 }}>{note}</p>}
      {error && <p style={{ fontSize: 13, color: "var(--danger, #b42318)", marginBottom: 0 }}>{error}</p>}
    </Panel>
  );
}
