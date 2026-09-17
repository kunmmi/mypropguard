import { keccak_256 } from "@noble/hashes/sha3.js";
import { encode as encodeMsgpack } from "@msgpack/msgpack";

/**
 * REAL Hyperliquid L1 action hashing — replaces the placeholder SHA-256 hash
 * used by the generic Phase 3 scaffold in packages/execution. Ported from
 * Hyperliquid's own actively-maintained TS SDK
 * (github.com/nktkas/hyperliquid, src/signing/_l1.ts) on 2026-09-17.
 *
 * Field order in `action` matters — the caller (see orderAction.ts) must
 * build the object with keys in the exact order Hyperliquid's schema
 * expects, since that order is what gets MsgPack-encoded and hashed.
 */
export interface CreateL1ActionHashInput {
  action: Record<string, unknown> | unknown[];
  /** Timestamp in ms, used as the nonce. */
  nonce: number;
  vaultAddress?: `0x${string}`;
  expiresAfter?: number;
}

export function createL1ActionHash(input: CreateL1ActionHashInput): `0x${string}` {
  const actionBytes = encodeMsgpack(input.action);
  const nonceBytes = toUint64Bytes(input.nonce);
  const vaultMarker = input.vaultAddress ? new Uint8Array([1]) : new Uint8Array([0]);
  const vaultBytes = input.vaultAddress ? hexToBytes(input.vaultAddress.slice(2)) : new Uint8Array(0);
  const expiresMarker = input.expiresAfter !== undefined ? new Uint8Array([0]) : new Uint8Array(0);
  const expiresBytes = input.expiresAfter !== undefined ? toUint64Bytes(input.expiresAfter) : new Uint8Array(0);

  const bytes = concatBytes(actionBytes, nonceBytes, vaultMarker, vaultBytes, expiresMarker, expiresBytes);
  return `0x${bytesToHex(keccak_256(bytes))}`;
}

/**
 * The phantom-agent EIP-712 message Hyperliquid actually validates the
 * signature against. `source` is "a" on mainnet, "b" on testnet.
 */
export function buildAgentTypedData(connectionId: `0x${string}`, isTestnet: boolean) {
  return {
    domain: {
      name: "Exchange",
      version: "1",
      chainId: 1337,
      verifyingContract: "0x0000000000000000000000000000000000000000" as const,
    },
    types: {
      EIP712Domain: [
        { name: "name", type: "string" },
        { name: "version", type: "string" },
        { name: "chainId", type: "uint256" },
        { name: "verifyingContract", type: "address" },
      ],
      Agent: [
        { name: "source", type: "string" },
        { name: "connectionId", type: "bytes32" },
      ],
    },
    primaryType: "Agent" as const,
    message: {
      source: isTestnet ? "b" : "a",
      connectionId,
    },
  };
}

function toUint64Bytes(n: number): Uint8Array {
  const bytes = new Uint8Array(8);
  new DataView(bytes.buffer).setBigUint64(0, BigInt(n));
  return bytes;
}

function hexToBytes(hex: string): Uint8Array {
  const clean = hex.length % 2 === 0 ? hex : `0${hex}`;
  const bytes = new Uint8Array(clean.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = Number.parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function concatBytes(...arrays: Uint8Array[]): Uint8Array {
  const total = arrays.reduce((sum, arr) => sum + arr.length, 0);
  const result = new Uint8Array(total);
  let offset = 0;
  for (const arr of arrays) {
    result.set(arr, offset);
    offset += arr.length;
  }
  return result;
}
