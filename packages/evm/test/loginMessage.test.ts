import { describe, expect, it } from "vitest";
import { stringToHex, type Address } from "viem";
import { checkLoginMessage, hostOf } from "../src/loginMessage.js";

const WALLET = "0x1111111111111111111111111111111111111111" as Address;
const OTHER = "0x2222222222222222222222222222222222222222" as Address;
const FOUR = { url: "https://four.meme" };
const hex = (text: string) => stringToHex(text);

const siwe = (over: { domain?: string; address?: string; chain?: string; extra?: string } = {}) =>
  [
    `${over.domain ?? "app.example.com"} wants you to sign in with your Ethereum account:`,
    over.address ?? WALLET,
    "",
    "Sign in to Example",
    "",
    "URI: https://app.example.com/login",
    "Version: 1",
    `Chain ID: ${over.chain ?? "56"}`,
    "Nonce: abc12345",
    "Issued At: 2026-10-26T10:00:00.000Z",
    ...(over.extra ? [over.extra] : []),
  ].join("\n");

describe("four.meme's login line", () => {
  it("is signed for four.meme, as hex or as plain text", () => {
    expect(checkLoginMessage(hex("You are sign in Meme 484138"), FOUR, WALLET, 56)).toMatchObject({ ok: true, kind: "four.meme" });
    expect(checkLoginMessage("You are sign in Meme 484138", FOUR, WALLET, 56)).toMatchObject({ ok: true, kind: "four.meme" });
    expect(checkLoginMessage(hex("You are sign in Meme 1"), { url: "https://www.four.meme/" }, WALLET, 56).ok).toBe(true);
  });

  it("is NOT signed for any other site, even though the words match", () => {
    for (const url of ["https://evil.example", "https://four.meme.evil.example", "https://notfour.meme", undefined, null, "not a url"]) {
      const r = checkLoginMessage(hex("You are sign in Meme 484138"), { url }, WALLET, 56);
      expect(r.ok, String(url)).toBe(false);
    }
  });

  it("must be the exact line: no extra text, a non-numeric nonce, or a different wording", () => {
    for (const text of [
      "You are sign in Meme abc",
      "You are sign in Meme 484138 and approve all tokens",
      "You are sign in Meme 484138\nExtra line",
      "you are sign in meme 484138",
      "You are sign in Meme ",
      "You are sign in Meme 1234567890123",
      "Approve unlimited spending. You are sign in Meme 484138",
    ]) {
      expect(checkLoginMessage(hex(text), FOUR, WALLET, 56).ok, text).toBe(false);
    }
  });
});

describe("Sign-In With Ethereum (EIP-4361)", () => {
  const site = { url: "https://app.example.com" };

  it("is signed when the domain is the linked site, the address is this wallet and the chain matches", () => {
    expect(checkLoginMessage(hex(siwe()), site, WALLET, 56)).toMatchObject({ ok: true, kind: "siwe" });
  });

  it("accepts the address in any letter case", () => {
    expect(checkLoginMessage(hex(siwe({ address: WALLET.toLowerCase() })), site, WALLET, 56).ok).toBe(true);
  });

  it("is refused when the message is for a different domain than the linked site (a phishing replay)", () => {
    const r = checkLoginMessage(hex(siwe({ domain: "evil.example" })), site, WALLET, 56);
    expect(r).toMatchObject({ ok: false });
    expect(!r.ok && r.message).toMatch(/evil\.example/);
  });

  it("is refused for another wallet's address", () => {
    expect(checkLoginMessage(hex(siwe({ address: OTHER })), site, WALLET, 56).ok).toBe(false);
  });

  it("is refused for another chain", () => {
    expect(checkLoginMessage(hex(siwe({ chain: "1" })), site, WALLET, 56).ok).toBe(false);
  });

  it("is refused when it carries Resources, which is how these messages smuggle delegations", () => {
    const r = checkLoginMessage(hex(siwe({ extra: "Resources:\n- urn:recap:eyJhdHQiOnt9fQ" })), site, WALLET, 56);
    expect(r).toMatchObject({ ok: false });
    expect(!r.ok && r.message).toMatch(/Resources/);
  });

  it("needs the linked site to be known", () => {
    expect(checkLoginMessage(hex(siwe()), { url: null }, WALLET, 56).ok).toBe(false);
  });

  it("must really be a SIWE message: a wrong version or missing nonce is not", () => {
    expect(checkLoginMessage(hex(siwe().replace("Version: 1", "Version: 2")), site, WALLET, 56).ok).toBe(false);
    expect(checkLoginMessage(hex(siwe().replace("Nonce: abc12345\n", "")), site, WALLET, 56).ok).toBe(false);
  });
});

describe("everything else is refused", () => {
  it("a bare 32-byte value — it could be a hash that authorises a transfer", () => {
    const hash = `0x${"ab".repeat(32)}`;
    expect(checkLoginMessage(hash, FOUR, WALLET, 56)).toMatchObject({ ok: false });
    // The same 32 bytes as plain text (32 characters) too.
    expect(checkLoginMessage("a".repeat(32), FOUR, WALLET, 56).ok).toBe(false);
  });

  it("binary data that is not text", () => {
    expect(checkLoginMessage("0xff00fe01", FOUR, WALLET, 56).ok).toBe(false);
  });

  it("empty, oversized, or control-character messages", () => {
    expect(checkLoginMessage("", FOUR, WALLET, 56).ok).toBe(false);
    expect(checkLoginMessage("0x", FOUR, WALLET, 56).ok).toBe(false);
    expect(checkLoginMessage(hex("x".repeat(2000)), FOUR, WALLET, 56).ok).toBe(false);
    expect(checkLoginMessage(hex("You are sign in Meme 1\u0000"), FOUR, WALLET, 56).ok).toBe(false);
  });

  it("free text that merely sounds harmless", () => {
    for (const text of ["Hello", "I authorize this site to move my tokens", "Sign in", "Welcome to four.meme"]) {
      expect(checkLoginMessage(hex(text), FOUR, WALLET, 56).ok, text).toBe(false);
    }
  });

  it("says why, in words a trader can read", () => {
    const r = checkLoginMessage(hex("Hello"), FOUR, WALLET, 56);
    expect(!r.ok && r.message).toMatch(/known login messages/);
  });
});

describe("hostOf", () => {
  it("reads the host, lower-cased, and returns null for junk", () => {
    expect(hostOf("https://Four.Meme/path?x=1")).toBe("four.meme");
    expect(hostOf("nonsense")).toBeNull();
    expect(hostOf(null)).toBeNull();
    expect(hostOf(undefined)).toBeNull();
  });
});
