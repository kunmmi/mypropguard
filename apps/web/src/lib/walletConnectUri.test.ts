import QRCode from "qrcode";
import { describe, expect, it } from "vitest";
import { decodeQrFromPixels } from "./qrFromImage";
import { extractWalletConnectUri, isBareWalletConnectUri, readWalletConnectInput } from "./walletConnectUri";

// The shape of a real v2 pairing code: a 64-hex topic, then the relay and a 64-hex symmetric key.
const TOPIC = "a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90";
const KEY = "00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff";
const URI = `wc:${TOPIC}@2?relay-protocol=irn&symKey=${KEY}`;

describe("readWalletConnectInput — the code in all its wrappers", () => {
  it("accepts the bare code, with stray whitespace and line breaks around it", () => {
    expect(extractWalletConnectUri(URI)).toBe(URI);
    expect(extractWalletConnectUri(`  \n${URI}\n  `)).toBe(URI);
  });

  it("unwraps a mobile-wallet deep link", () => {
    for (const scheme of ["metamask://wc?uri=", "trust://wc?uri=", "rainbow://wc?uri=", "wc://wc?uri="]) {
      expect(extractWalletConnectUri(`${scheme}${encodeURIComponent(URI)}`)).toBe(URI);
    }
  });

  it("unwraps a universal link, even with other parameters around the uri", () => {
    expect(extractWalletConnectUri(`https://link.trustwallet.com/wc?uri=${encodeURIComponent(URI)}`)).toBe(URI);
    expect(extractWalletConnectUri(`https://metamask.app.link/wc?foo=1&uri=${encodeURIComponent(URI)}&utm=x`)).toBe(URI);
  });

  it("copes with a code that was percent-encoded twice", () => {
    expect(extractWalletConnectUri(encodeURIComponent(encodeURIComponent(URI)))).toBe(URI);
    expect(extractWalletConnectUri(`https://x.app/wc?uri=${encodeURIComponent(encodeURIComponent(URI))}`)).toBe(URI);
  });

  it("finds the code inside a longer message", () => {
    expect(extractWalletConnectUri(`Connect with this: ${URI} (expires in 5 minutes)`)).toBe(URI);
  });

  it("returns something the server will accept", () => {
    expect(isBareWalletConnectUri(extractWalletConnectUri(`metamask://wc?uri=${encodeURIComponent(URI)}`)!)).toBe(true);
  });

  it("is case-insensitive about the hex, as the server is", () => {
    const upper = `wc:${TOPIC.toUpperCase()}@2?relay-protocol=irn&symKey=${KEY}`;
    expect(extractWalletConnectUri(upper)).toBe(upper);
  });
});

describe("readWalletConnectInput — what to say when it is not a usable code", () => {
  const problemOf = (text: string) => {
    const r = readWalletConnectInput(text);
    return r.ok ? "" : r.problem;
  };

  it("says there is nothing to read for empty input", () => {
    expect(readWalletConnectInput("   ")).toEqual({ ok: false, problem: "Nothing to read yet." });
  });

  it("names the retired version 1 codes instead of failing silently", () => {
    const v1 = "wc:8a5e5bdc-a0e4-4702-ba63-8f1a5655744f@1?bridge=https%3A%2F%2Fbridge.walletconnect.org&key=41791102999c339c844880b23950704cc43aa840f3739e365323cda4dfa89e7a";
    expect(problemOf(v1)).toMatch(/version 1/);
  });

  it("recognises a truncated code and says to copy the whole thing", () => {
    expect(problemOf(`wc:${TOPIC}@2`)).toMatch(/cut short/);
    expect(problemOf(`wc:${TOPIC.slice(0, 20)}`)).toMatch(/cut short/);
  });

  it("explains that a QR from some other connect method is not WalletConnect, and shows what it was", () => {
    const other = problemOf("https://exchange.example/login?token=abc123");
    expect(other).toMatch(/not a WalletConnect code/);
    expect(other).toContain("https://exchange.example/login?token=abc123");
    expect(other).toMatch(/its own connect method/);
  });

  it("does not echo a very long unknown payload in full", () => {
    expect(problemOf("x".repeat(500)).length).toBeLessThan(260);
  });

  it("never mistakes a lookalike (wrong topic length) for a code", () => {
    expect(extractWalletConnectUri(`wc:${TOPIC.slice(0, 63)}@2?relay-protocol=irn&symKey=${KEY}`)).toBeNull();
  });
});

/** Draws a QR the way a screenshot would hold it: black modules on white, with the quiet border, as RGBA pixels. */
function qrPixels(text: string, opts: { module?: number; invert?: boolean } = {}) {
  const qr = QRCode.create(text, { errorCorrectionLevel: "M" });
  const size = qr.modules.size;
  const mod = opts.module ?? 6;
  const quiet = 4;
  const side = (size + quiet * 2) * mod;
  const data = new Uint8ClampedArray(side * side * 4);
  for (let y = 0; y < side; y++) {
    for (let x = 0; x < side; x++) {
      const mx = Math.floor(x / mod) - quiet;
      const my = Math.floor(y / mod) - quiet;
      const dark = mx >= 0 && my >= 0 && mx < size && my < size && qr.modules.get(mx, my) === 1;
      const on = opts.invert ? !dark : dark;
      const v = on ? 0 : 255;
      const i = (y * side + x) * 4;
      data[i] = data[i + 1] = data[i + 2] = v;
      data[i + 3] = 255;
    }
  }
  return { data, side };
}

describe("reading a QR image — the case with no copy button", () => {
  it("reads a real WalletConnect QR back to exactly the code that was drawn", () => {
    const { data, side } = qrPixels(URI);
    expect(decodeQrFromPixels(data, side, side)).toBe(URI);
  });

  it("the full path: picture → text → a code the server will take", () => {
    const { data, side } = qrPixels(URI);
    const text = decodeQrFromPixels(data, side, side);
    expect(extractWalletConnectUri(text ?? "")).toBe(URI);
  });

  it("reads a QR wrapped in a deep link, as many connect screens draw it", () => {
    const wrapped = `https://link.trustwallet.com/wc?uri=${encodeURIComponent(URI)}`;
    const { data, side } = qrPixels(wrapped);
    expect(extractWalletConnectUri(decodeQrFromPixels(data, side, side) ?? "")).toBe(URI);
  });

  it("reads a light-on-dark QR (dark-theme apps)", () => {
    const { data, side } = qrPixels(URI, { invert: true });
    expect(decodeQrFromPixels(data, side, side)).toBe(URI);
  });

  it("reads small screenshots (modules only 3px wide)", () => {
    const { data, side } = qrPixels(URI, { module: 3 });
    expect(decodeQrFromPixels(data, side, side)).toBe(URI);
  });

  it("returns null for a picture with no QR in it, rather than guessing", () => {
    const side = 200;
    const blank = new Uint8ClampedArray(side * side * 4).fill(255);
    expect(decodeQrFromPixels(blank, side, side)).toBeNull();
  });

  it("a QR that holds something other than WalletConnect decodes, then is explained, not linked", () => {
    const { data, side } = qrPixels("https://exchange.example/app-login?session=zz9");
    const text = decodeQrFromPixels(data, side, side);
    expect(text).toBe("https://exchange.example/app-login?session=zz9");
    expect(readWalletConnectInput(text ?? "").ok).toBe(false);
  });
});
