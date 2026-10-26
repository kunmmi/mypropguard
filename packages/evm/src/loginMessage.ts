import { getAddress, hexToBytes, isAddressEqual, isHex, type Address, type Hex } from "viem";

/**
 * WHICH MESSAGES THE TRADING WALLET WILL SIGN.
 *
 * Sites such as four.meme log you in by asking your wallet to sign a message. For an ordinary key that is harmless
 * IF the message really is a login. A signature over the wrong thing can authorise a token approval or an off-chain
 * order with no transaction at all, which would walk straight around the trade rules. So this is an allow-list, not a
 * filter: only two shapes are signed, and only for the site they belong to.
 *
 *  1. four.meme's own login line ("You are sign in Meme <number>"), and only when the linked site is four.meme.
 *  2. A Sign-In With Ethereum (EIP-4361) message whose domain is the linked site, whose address is this wallet, and
 *     which asks for nothing else (no "Resources", which is how those messages carry delegations).
 *
 * Typed-data signatures (eth_signTypedData*) are never signed at all: that is the format of token permits.
 * A 32-byte payload is never signed either: a raw hash could be anything, including a Safe or permit digest.
 */

export type LoginCheck = { ok: true; kind: "four.meme" | "siwe"; text: string } | { ok: false; message: string };

const FOUR_MEME_LOGIN = /^You are sign in Meme \d{1,12}$/;
const FOUR_MEME_HOSTS = new Set(["four.meme", "www.four.meme"]);
const MAX_LENGTH = 1024;

/** The host of the linked site as it reported itself (WalletConnect metadata), or null. */
export function hostOf(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    return new URL(url).host.toLowerCase();
  } catch {
    return null;
  }
}

/** personal_sign carries the message as 0x-hex of its UTF-8 bytes, or occasionally as plain text. */
function toText(raw: string): { text: string; byteLength: number } | null {
  let bytes: Uint8Array;
  if (isHex(raw)) {
    try {
      bytes = hexToBytes(raw as Hex);
    } catch {
      return null;
    }
  } else {
    bytes = new TextEncoder().encode(raw);
  }
  try {
    return { text: new TextDecoder("utf-8", { fatal: true }).decode(bytes), byteLength: bytes.length };
  } catch {
    return null; // not valid text: binary data is never a login message
  }
}

/** Minimal EIP-4361 parse: enough to check who the message is for and that it asks for nothing more. */
function readSiwe(text: string): { domain: string; address: string; chainId?: string; hasResources: boolean } | null {
  const lines = text.split("\n");
  const head = /^(.+?) wants you to sign in with your Ethereum account:$/.exec(lines[0] ?? "");
  if (!head || !/^0x[0-9a-fA-F]{40}$/.test(lines[1] ?? "")) return null;
  const field = (name: string) => lines.find((l) => l.startsWith(`${name}: `))?.slice(name.length + 2);
  if (field("Version") !== "1" || !field("Nonce") || !field("URI")) return null;
  return { domain: head[1]!.toLowerCase(), address: lines[1]!, chainId: field("Chain ID"), hasResources: lines.some((l) => l.startsWith("Resources:")) };
}

export function checkLoginMessage(raw: string, site: { url?: string | null }, wallet: Address, chainId: number): LoginCheck {
  const decoded = toText(raw);
  if (!decoded) return { ok: false, message: "This wallet signs only readable login messages, and that was not text." };
  const { text, byteLength } = decoded;
  if (byteLength === 32) {
    return { ok: false, message: "This wallet will not sign a bare 32-byte value: it could be a hash that authorises a transfer." };
  }
  if (text.length === 0 || text.length > MAX_LENGTH) return { ok: false, message: "That message is empty or too long to be a login." };
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u0008\u000b-\u001f\u007f]/.test(text)) return { ok: false, message: "That message contains control characters, so it is not a login." };

  const host = hostOf(site.url);
  if (FOUR_MEME_LOGIN.test(text)) {
    if (!host || !FOUR_MEME_HOSTS.has(host)) {
      return { ok: false, message: `That looks like a four.meme login, but this link is to ${host ?? "an unknown site"}. Not signed.` };
    }
    return { ok: true, kind: "four.meme", text };
  }

  const siwe = readSiwe(text);
  if (siwe) {
    if (!host || siwe.domain !== host) {
      return { ok: false, message: `That sign-in is for ${siwe.domain}, but this link is to ${host ?? "an unknown site"}. Not signed.` };
    }
    if (!isAddressEqual(getAddress(siwe.address), wallet)) {
      return { ok: false, message: "That sign-in names a different wallet address. Not signed." };
    }
    if (siwe.chainId !== undefined && siwe.chainId !== String(chainId)) {
      return { ok: false, message: `That sign-in is for chain ${siwe.chainId}, not ${chainId}. Not signed.` };
    }
    if (siwe.hasResources) {
      return { ok: false, message: "That sign-in asks for extra permissions (Resources). This wallet signs plain logins only." };
    }
    return { ok: true, kind: "siwe", text };
  }

  return { ok: false, message: "This wallet signs only known login messages (four.meme, or a standard Sign-In With Ethereum for the linked site)." };
}
