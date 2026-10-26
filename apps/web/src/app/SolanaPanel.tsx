"use client";

import { useCallback, useEffect, useState } from "react";
import { Button } from "@/design-system/components/core/Button";
import { Panel } from "@/design-system/Panel";
import { StatusBadge } from "@/design-system/StatusBadge";
import { api, type SolanaStatus } from "@/lib/api";
import { WalletConnectLinkBox } from "./WalletConnectLinkBox";

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
    return {
      label: r.result === "SIGNED" ? "Signed in" : r.result === "REFUSED" ? "Login refused" : "Login failed",
      text: r.result === "REFUSED" ? (r.message ?? "") : "",
    };
  }
  if (r.kind === "transaction") {
    return { label: r.result === "SIGNED" ? "Trade signed" : "Trade not signed", text: r.message ?? "" };
  }
  return { label: r.result === "ERROR" ? "Failed" : "Request", text: r.message ?? r.method };
}

/**
 * The Solana wallet (for pump.fun and similar). First version: connect a site, see what it asks for. It signs the site's
 * login and nothing else, so there is nothing to deposit yet.
 */
export function SolanaPanel({ accountId }: { accountId: string }) {
  const [state, setState] = useState<SolanaStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const [open, setOpen] = useState<number | null>(null);

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

  async function run(label: string, work: () => Promise<void>) {
    setBusy(true);
    setError(null);
    setNote(label);
    try {
      await work();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setNote(null);
      setBusy(false);
      void refresh();
    }
  }

  if (!state?.available) return error ? <Panel title="Your Solana wallet"><p style={{ color: "var(--text-muted)", fontSize: 13 }}>{error}</p></Panel> : null;

  if (!state.exists) {
    return (
      <Panel title="Your Solana wallet">
        <p style={{ marginTop: 0, fontSize: 13, color: "var(--text-muted)" }}>
          A wallet for Solana sites such as pump.fun. In this first version you connect pump.fun and MyPropGuard shows you
          what it asks the wallet to do. It does not trade yet, so there is nothing to deposit.
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
  return (
    <Panel title="Your Solana wallet">
      <div style={{ display: "flex", gap: "var(--space-2)", flexWrap: "wrap", marginBottom: "var(--space-3)" }}>
        <StatusBadge tone={on ? "success" : "neutral"}>{on ? "Wallet is on" : "Paused"}</StatusBadge>
        <StatusBadge tone="neutral">Trading is not switched on yet</StatusBadge>
      </div>

      <div style={{ display: "grid", gap: "var(--space-3)" }}>
        <div>
          <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 4 }}>Your wallet address</div>
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
          <p style={{ fontSize: 12, color: "var(--text-muted)", margin: "var(--space-2) 0 0" }}>
            Do not deposit yet. This wallet does not trade or withdraw until the next step is built.
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
            <div style={{ fontSize: 13, fontWeight: 600 }}>What sites asked for</div>
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
                      {open === i && (
                        <pre style={{ margin: 0, maxHeight: 220, overflow: "auto", whiteSpace: "pre-wrap", wordBreak: "break-all", fontSize: 11 }}>{JSON.stringify(r.detail, null, 2)}</pre>
                      )}
                    </>
                  )}
                </div>
              );
            })}
          </div>
        )}

        <div>
          {on ? (
            <Button variant="subtle" size="sm" disabled={busy} onClick={() => void run("Switching off…", () => api.switchSolana(accountId, false).then(() => undefined))}>
              Switch off and disconnect
            </Button>
          ) : (
            <Button variant="subtle" size="sm" disabled={busy} onClick={() => void run("Switching on…", () => api.switchSolana(accountId, true).then(() => undefined))}>
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
