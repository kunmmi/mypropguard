"use client";

import { useRef, useState } from "react";
import { Button } from "@/design-system/components/core/Button";
import { decodeQrFromImage } from "@/lib/qrFromImage";
import { readWalletConnectInput } from "@/lib/walletConnectUri";

/**
 * Takes a site's WalletConnect code from text, a pasted screenshot, a dropped picture or an uploaded one (some sites show
 * only a QR, with no copy button), and hands the bare code to `onLink`.
 */
export function WalletConnectLinkBox({ siteName, busy, onLink }: { siteName: string; busy: boolean; onLink(code: string): Promise<void> }) {
  const [uri, setUri] = useState("");
  const [qrNote, setQrNote] = useState<string | null>(null);
  const [reading, setReading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  // What the box holds, understood: the bare code if it is one, otherwise what is wrong with it.
  const typed = uri.trim() ? readWalletConnectInput(uri) : null;

  async function readQrImage(image: Blob) {
    setReading(true);
    setQrNote(null);
    setError(null);
    try {
      const text = await decodeQrFromImage(image);
      if (!text) {
        setQrNote("No QR code found in that picture. Make sure the whole code is in the shot and sharp, then try again.");
        return;
      }
      setUri(text);
      setQrNote(readWalletConnectInput(text).ok ? "Code read from the picture. Press Link now: these codes expire within a few minutes." : null);
    } catch (e) {
      setQrNote(e instanceof Error ? e.message : "Could not read that picture.");
    } finally {
      setReading(false);
    }
  }

  const imageFrom = (items: DataTransferItemList | undefined): File | null => {
    for (const item of Array.from(items ?? [])) {
      if (item.kind === "file" && item.type.startsWith("image/")) return item.getAsFile();
    }
    return null;
  };

  async function link() {
    setError(null);
    try {
      await onLink(typed?.ok ? typed.uri : uri);
      setQrNote(null);
      setUri("");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  return (
    <div>
      <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 4 }}>Link {siteName}</div>
      <ol style={{ margin: "0 0 var(--space-2)", paddingLeft: 18, fontSize: 13, color: "var(--text-muted)", display: "grid", gap: 2 }}>
        <li>On {siteName}, press Connect wallet and choose WalletConnect.</li>
        <li>Copy the code it shows (it starts with wc:) and paste it here.</li>
        <li>No copy button, only a QR? Take a screenshot of the QR and paste the picture here (Ctrl+V), drop it on this box, or upload it.</li>
      </ol>
      <div
        onPaste={(e) => {
          const image = imageFrom(e.clipboardData?.items);
          if (image) {
            e.preventDefault();
            void readQrImage(image);
          }
        }}
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => {
          const file = Array.from(e.dataTransfer?.files ?? []).find((x) => x.type.startsWith("image/"));
          if (file) {
            e.preventDefault();
            void readQrImage(file);
          }
        }}
        style={{ display: "flex", gap: "var(--space-2)", flexWrap: "wrap" }}
      >
        <input
          value={uri}
          onChange={(e) => {
            setUri(e.target.value);
            setQrNote(null);
          }}
          placeholder="wc:…  (or paste a screenshot of the QR)"
          style={{ flex: 1, padding: "var(--space-2)", borderRadius: "var(--radius-md)", border: "1px solid var(--border-default)", fontFamily: "var(--font-accent)", fontSize: 12 }}
        />
        <Button variant="subtle" onClick={() => fileInput.current?.click()} disabled={busy || reading}>
          {reading ? "Reading…" : "Upload QR picture"}
        </Button>
        <input
          ref={fileInput}
          type="file"
          accept="image/*"
          hidden
          onChange={(e) => {
            const file = e.target.files?.[0];
            e.target.value = "";
            if (file) void readQrImage(file);
          }}
        />
        <Button onClick={() => void link()} disabled={busy || reading || !typed?.ok}>
          Link
        </Button>
      </div>
      {qrNote && <p style={{ margin: "var(--space-2) 0 0", fontSize: 12, color: "var(--text-muted)" }}>{qrNote}</p>}
      {typed && !typed.ok && <p style={{ margin: "var(--space-2) 0 0", fontSize: 12, color: "var(--text-muted)" }}>{typed.problem}</p>}
      {error && <p style={{ margin: "var(--space-2) 0 0", fontSize: 12, color: "var(--danger, #b42318)" }}>{error}</p>}
    </div>
  );
}
