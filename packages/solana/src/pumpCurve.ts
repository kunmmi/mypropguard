/**
 * pump.fun's bonding curve account (seeds ["bonding-curve", mint] under the pump program). Layout from pump.fun's IDL
 * (pump-fun/pump-public-docs, idl/pump.json, checked 2026-10-26): an 8-byte account discriminator, then
 * virtual_token_reserves, virtual_quote_reserves, real_token_reserves, real_quote_reserves, token_total_supply (u64 each),
 * complete (bool), creator (32 bytes), is_mayhem_mode, is_cashback_coin (bool each), quote_mint (32 bytes) and more.
 */
export const BONDING_CURVE_DISCRIMINATOR = "17b7f83760d8ac60";

export interface BondingCurveState {
  virtualTokenReserves: bigint;
  virtualQuoteReserves: bigint;
  realTokenReserves: bigint;
  realQuoteReserves: bigint;
  tokenTotalSupply: bigint;
  /** True once the coin has outgrown the curve and trades on PumpSwap. */
  complete: boolean;
}

/** Reads a bonding curve account's bytes, or returns undefined when they are not one. */
export function decodeBondingCurve(data: Uint8Array): BondingCurveState | undefined {
  const buf = Buffer.from(data);
  if (buf.length < 8 + 5 * 8 + 1) return undefined;
  if (buf.subarray(0, 8).toString("hex") !== BONDING_CURVE_DISCRIMINATOR) return undefined;
  return {
    virtualTokenReserves: buf.readBigUInt64LE(8),
    virtualQuoteReserves: buf.readBigUInt64LE(16),
    realTokenReserves: buf.readBigUInt64LE(24),
    realQuoteReserves: buf.readBigUInt64LE(32),
    tokenTotalSupply: buf.readBigUInt64LE(40),
    complete: buf[48] === 1,
  };
}

/**
 * The curve's total trading fee on pump.fun is 1.25% (pump.fun/docs/fees, 2026-10-17). It is taken off what a sale
 * returns, so quotes here are a little below the gross curve price, as a real sale would be.
 */
export const CURVE_FEE_BPS = 125n;

/** SOL (lamports) a sale of `amount` tokens returns on the curve, after fees. Constant-product: out = amount * vq / (vt + amount). */
export function curveSellQuote(curve: BondingCurveState, amount: bigint): bigint {
  if (amount <= 0n) return 0n;
  const gross = (amount * curve.virtualQuoteReserves) / (curve.virtualTokenReserves + amount);
  return (gross * (10_000n - CURVE_FEE_BPS)) / 10_000n;
}

/** Tokens that spending `lamports` (fees included) buys on the curve. */
export function curveBuyQuote(curve: BondingCurveState, lamports: bigint): bigint {
  if (lamports <= 0n) return 0n;
  const net = (lamports * 10_000n) / (10_000n + CURVE_FEE_BPS);
  const tokens = (net * curve.virtualTokenReserves) / (curve.virtualQuoteReserves + net);
  return tokens > curve.realTokenReserves ? curve.realTokenReserves : tokens;
}
