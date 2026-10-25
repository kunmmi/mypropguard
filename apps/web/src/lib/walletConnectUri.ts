/**
 * Finds the WalletConnect pairing code in whatever the trader pasted or scanned.
 *
 * The code itself looks like `wc:<64 hex>@2?relay-protocol=irn&symKey=<64 hex>`. In practice it arrives in several
 * wrappers: the bare code, a mobile-wallet deep link (`metamask://wc?uri=wc%3A…`), a universal link
 * (`https://link.trustwallet.com/wc?uri=…`), or a QR image that decodes to one of those. The server accepts only the
 * bare v2 code, so everything is unwrapped to that here, and anything that is not one comes back with a plain
 * explanation instead of a silent "nothing happened".
 */

/** The bare v2 pairing code: topic (64 hex), then the query holding the relay and the symmetric key. */
const BARE_V2 = /wc:[0-9a-f]{64}@2\?[^\s"'<>]+/i;
/** The server's own test (apps/api walletConnectService.pair): the topic and the version. */
const V2_PREFIX = /^wc:[0-9a-f]{64}@2\?/i;

export type WalletConnectInput = { ok: true; uri: string } | { ok: false; problem: string };

/** Decodes a percent-encoded string, leaving it as it was if it is not valid encoding. */
function safeDecode(text: string): string {
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
}

function findBare(text: string): string | null {
  return BARE_V2.exec(text)?.[0] ?? null;
}

/**
 * Pulls the bare v2 code out of `input`, or says what the input was instead.
 *
 * Tries, in order: the bare code; a `uri=` parameter of a deep or universal link; the text percent-decoded (once or
 * twice, since some wallets encode it twice); and the code buried anywhere in a longer message.
 */
export function readWalletConnectInput(input: string): WalletConnectInput {
  const text = input.trim();
  if (!text) return { ok: false, problem: "Nothing to read yet." };

  const attempts: string[] = [text];
  const once = safeDecode(text);
  if (once !== text) attempts.push(once);
  const twice = safeDecode(once);
  if (twice !== once) attempts.push(twice);

  for (const candidate of attempts) {
    // A link carries the code in its uri= parameter (the rest of the link is the wallet's own routing).
    const fromParam = /[?&]uri=([^&\s]+)/i.exec(candidate)?.[1];
    if (fromParam) {
      const inner = findBare(safeDecode(fromParam));
      if (inner) return { ok: true, uri: inner };
    }
    const bare = findBare(candidate);
    if (bare) return { ok: true, uri: bare };
  }

  // Not a usable code. Say what it looks like, so the trader knows whether to try again or use another route.
  if (/wc:[0-9a-f-]{20,}@1\b/i.test(twice)) {
    return { ok: false, problem: "That is an old WalletConnect (version 1) code, which has been shut down. Ask the site for a version 2 code, or use a different connect option." };
  }
  if (/^wc:/i.test(text)) {
    return { ok: false, problem: "That starts like a WalletConnect code but is cut short. Copy the whole code, including everything after the question mark." };
  }
  const shown = text.length > 60 ? `${text.slice(0, 60)}…` : text;
  return {
    ok: false,
    problem: `That is not a WalletConnect code (it reads: ${shown}). If it came from a QR, this site is using its own connect method for that QR, not WalletConnect.`,
  };
}

/** The bare code, or null. For callers that only need to know whether the input is usable. */
export function extractWalletConnectUri(input: string): string | null {
  const read = readWalletConnectInput(input);
  return read.ok ? read.uri : null;
}

/** Sanity check that a string is exactly what the server will accept. */
export function isBareWalletConnectUri(uri: string): boolean {
  return V2_PREFIX.test(uri.trim());
}
