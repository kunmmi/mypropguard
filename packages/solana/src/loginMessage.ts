import { SOLANA_SITES } from "./constants.js";
import { looksLikeTransaction } from "./txInspect.js";

export type SolanaLoginCheck = { ok: true; text: string } | { ok: false; message: string; preview: string };

const MAX_LENGTH = 1024;

/** The host of a page address, lower case, or null. */
export function hostOf(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
}

/** Printable text for the log: control characters shown, long text cut. */
function previewOf(bytes: Uint8Array): string {
  const text = Buffer.from(bytes).toString("utf8").replace(/[^\x20-\x7e\n\r\t -￿]/g, "·");
  return text.length > 300 ? `${text.slice(0, 300)}…` : text;
}

/**
 * Decides whether the wallet may sign a message a linked site sent as a "login". A signed message cannot move money by
 * itself on Solana, but it CAN be a transaction in disguise, so it is signed only when ALL of these hold:
 *  - the site the owner linked is one the wallet knows (pump.fun for now), by host;
 *  - the bytes are plain readable text, not binary and not a transaction or transaction message;
 *  - it is short.
 * Anything else is refused, and its text is returned as `preview` so the owner (and we) can see exactly what was asked.
 */
export function checkSolanaLoginMessage(bytes: Uint8Array, site: { url: string | null }): SolanaLoginCheck {
  const preview = previewOf(bytes);
  const refuse = (message: string): SolanaLoginCheck => ({ ok: false, message, preview });

  const host = hostOf(site.url);
  const known = host !== null && Object.values(SOLANA_SITES).some((s) => (s.hosts as readonly string[]).includes(host));
  if (!known) return refuse(`This wallet only signs logins for the sites it supports, and ${host ?? "this site"} is not one of them.`);

  if (bytes.length === 0) return refuse("That is an empty message.");
  if (bytes.length > MAX_LENGTH) return refuse("That message is too long to be a login, so it was not signed.");
  if (looksLikeTransaction(bytes)) return refuse("That message is a transaction in disguise, so it was not signed.");

  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return refuse("That message is not readable text, so it was not signed.");
  }
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(text)) return refuse("That message has hidden control characters, so it was not signed.");
  return { ok: true, text };
}
