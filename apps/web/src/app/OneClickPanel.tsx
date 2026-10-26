"use client";

import { useCallback, useEffect, useState } from "react";
import { Button } from "@/design-system/components/core/Button";
import { Panel } from "@/design-system/Panel";
import { StatusBadge } from "@/design-system/StatusBadge";
import { api, type OneClickStatus, type OneClickTransaction } from "@/lib/api";
import { WalletConnectLinkBox } from "./WalletConnectLinkBox";

type Eip1193 = { request(args: { method: string; params?: unknown[] }): Promise<unknown> };

function wallet(): Eip1193 {
  const provider = (window as unknown as { ethereum?: Eip1193 }).ethereum;
  if (!provider) throw new Error("No browser wallet found. Open this page in a browser with your wallet (for example MetaMask) installed.");
  return provider;
}

/**
 * Sends one transaction from the owner's own wallet: the trader confirms it once in their wallet and pays its gas.
 * That is the only time one-click trading asks for a signature.
 */
async function sendFromOwnerWallet(ownerAddress: string, chainId: number, tx: OneClickTransaction): Promise<string> {
  const provider = wallet();
  const accounts = (await provider.request({ method: "eth_requestAccounts" })) as string[];
  if (!accounts.some((a) => a.toLowerCase() === ownerAddress.toLowerCase())) {
    throw new Error(`Switch your wallet to ${ownerAddress}, the owner of this Safe, and try again.`);
  }
  await provider.request({ method: "wallet_switchEthereumChain", params: [{ chainId: `0x${chainId.toString(16)}` }] });
  return (await provider.request({ method: "eth_sendTransaction", params: [{ from: ownerAddress, to: tx.to, data: tx.data, value: tx.value }] })) as string;
}

function formatAmount(wei: string | null): string {
  if (!wei) return "";
  const n = Number(wei) / 1e18;
  return n === 0 ? "" : ` · ${n.toLocaleString(undefined, { maximumFractionDigits: 4 })} BNB`;
}

export function OneClickPanel({ accountId, nativeSymbol, exchangeName }: { accountId: string; nativeSymbol?: string; exchangeName?: string }) {
  const [state, setState] = useState<OneClickStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    try {
      setState(await api.getOneClick(accountId));
      setError(null);
    } catch (e) {
      // 404 means this server has one-click trading switched off: show nothing rather than an error.
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

  const enable = () =>
    run("Confirm in your wallet…", async () => {
      const prepared = await api.prepareOneClick(accountId);
      await sendFromOwnerWallet(prepared.ownerAddress, prepared.chainId, prepared.transaction);
      setNote("Waiting for the transaction to confirm on-chain…");
      for (let attempt = 0; attempt < 40; attempt++) {
        await new Promise((resolve) => setTimeout(resolve, 3000));
        try {
          await api.confirmOneClick(accountId);
          return;
        } catch (e) {
          if (!(e instanceof Error) || !/not on your safe yet/i.test(e.message)) throw e;
        }
      }
      throw new Error("The transaction did not confirm in time. Check your wallet, then press Enable again.");
    });

  // Errors go back to the link box, which shows them next to the code the owner pasted.
  const link = async (code: string) => {
    setBusy(true);
    setNote("Linking…");
    try {
      const result = await api.pairOneClick(accountId, code);
      setNote(result.message);
      await new Promise((resolve) => setTimeout(resolve, 6000));
    } finally {
      setNote(null);
      setBusy(false);
      void refresh();
    }
  };

  const disable = () =>
    run("Switching off…", async () => {
      const result = await api.disableOneClick(accountId);
      if (result.transaction && result.ownerAddress && result.chainId) {
        setNote("One-click trading is off. Confirm in your wallet to also remove the key from your Safe…");
        await sendFromOwnerWallet(result.ownerAddress, result.chainId, result.transaction);
      }
    });

  if (!state?.available) return error ? <Panel title="One-click trading"><p style={{ color: "var(--text-muted)", fontSize: 13 }}>{error}</p></Panel> : null;

  const on = state.status === "enabled";
  const row: React.CSSProperties = {
    display: "flex",
    justifyContent: "space-between",
    gap: "var(--space-3)",
    padding: "var(--space-2) var(--space-3)",
    borderRadius: "var(--radius-md)",
    border: "1px solid var(--border-default)",
    fontSize: 12,
  };

  return (
    <Panel title="One-click trading">
      <p style={{ marginTop: 0, fontSize: 13, color: "var(--text-muted)" }}>
        Trade on {exchangeName ?? "the exchange"} with no wallet popup. You link the exchange once; after that its
        trades are signed for you, even with this page closed. The key that signs can only buy and sell inside your
        rules: it can never send money out or change your Safe. Withdrawals still need your own wallet.
      </p>

      <div style={{ display: "flex", gap: "var(--space-2)", flexWrap: "wrap", marginBottom: "var(--space-3)" }}>
        <StatusBadge tone={on ? "success" : "neutral"}>{on ? "One-click trading is on" : state.status === "revoked" ? "Switched off" : "Off"}</StatusBadge>
        {on && state.gasWalletLow && <StatusBadge tone="danger">The gas wallet is low on {nativeSymbol ?? "BNB"}: trades may fail</StatusBadge>}
      </div>

      {!state.guardIsCurrent && (
        <p style={{ fontSize: 13, color: "var(--text-muted)" }}>
          This Safe uses an older version of the Guard, which cannot do one-click trading yet. It needs the Guard
          upgrade first.
        </p>
      )}

      {!on && state.guardIsCurrent && state.status !== "revoked" && (
        <div>
          <p style={{ fontSize: 13, color: "var(--text-muted)" }}>
            Enabling takes one confirmation in your wallet (you pay a tiny network fee). It adds a trading-only key to
            your Safe.
          </p>
          <Button onClick={() => void enable()} disabled={busy}>
            Enable one-click trading
          </Button>
        </div>
      )}

      {on && (
        <div style={{ display: "grid", gap: "var(--space-3)" }}>
          <WalletConnectLinkBox siteName={exchangeName ?? "the exchange"} busy={busy} onLink={link} />

          {state.links.length > 0 && (
            <div style={{ display: "grid", gap: "var(--space-2)" }}>
              <div style={{ fontSize: 13, fontWeight: 600 }}>Linked sites</div>
              {state.links.map((l) => (
                <div key={l.topic} style={{ ...row, alignItems: "center" }}>
                  <span>
                    <strong>{l.name ?? "Unknown site"}</strong> {l.url ? `· ${l.url}` : ""}
                  </span>
                  <Button variant="subtle" size="sm" disabled={busy} onClick={() => void run("Disconnecting…", () => api.disconnectOneClick(accountId, l.topic).then(() => undefined))}>
                    Disconnect
                  </Button>
                </div>
              ))}
            </div>
          )}

          {state.trades.length > 0 && (
            <div style={{ display: "grid", gap: "var(--space-2)" }}>
              <div style={{ fontSize: 13, fontWeight: 600 }}>Recent trades</div>
              {state.trades.map((t, i) => (
                <div key={`${t.at}-${i}`} style={row}>
                  <span>
                    <strong>{t.result === "SENT" ? "Sent" : t.result === "REFUSED" ? "Blocked" : "Failed"}</strong>
                    {t.site ? ` · ${t.site}` : ""}
                    {formatAmount(t.valueWei)}
                    {t.message ? ` · ${t.message}` : ""}
                  </span>
                  <span style={{ color: "var(--text-muted)", whiteSpace: "nowrap" }}>{new Date(t.at).toLocaleTimeString()}</span>
                </div>
              ))}
            </div>
          )}

          <div>
            <Button variant="subtle" size="sm" disabled={busy} onClick={() => void disable()}>
              Switch off one-click trading
            </Button>
          </div>
        </div>
      )}

      {note && <p style={{ fontSize: 13, marginBottom: 0 }}>{note}</p>}
      {error && <p style={{ fontSize: 13, color: "var(--danger, #b42318)", marginBottom: 0 }}>{error}</p>}
    </Panel>
  );
}
