import { bondingCurveAddress, WSOL_MINT } from "./pumpfun.js";
import { curveBuyQuote, curveSellQuote, decodeBondingCurve } from "./pumpCurve.js";
import type { SolanaRpc } from "./rpc.js";

export interface SolanaPosition {
  mint: string;
  balance: bigint;
  /** What selling all of it would return in lamports, after fees. 0 when it cannot be sold right now. */
  valueLamports: bigint;
}

export interface SolanaHoldings {
  solLamports: bigint;
  positions: SolanaPosition[];
  positionsLamports: bigint;
  /** SOL in the wallet plus the positions. */
  equityLamports: bigint;
}

type FetchLike = (url: string, init?: { signal?: AbortSignal }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown>; text(): Promise<string> }>;

const JUPITER = "https://lite-api.jup.ag";

/**
 * Prices what the wallet holds in SOL from what the market would pay now: the bonding curve's own maths while a coin is
 * still on pump.fun's curve, a Jupiter quote once it has moved to PumpSwap.
 *
 * A coin with no price (no route, no liquidity) is worth 0, which is the safe reading for a loss limit. A failure to ask
 * at all (the network is down) throws, so a caller never mistakes "could not check" for "fine".
 */
export class SolanaValuer {
  constructor(
    private readonly rpc: Pick<SolanaRpc, "getBalance" | "getAccountData" | "getTokenBalance">,
    private readonly fetchImpl: FetchLike = fetch as unknown as FetchLike,
    private readonly jupiterBase: string = JUPITER,
  ) {}

  private async getJson(url: string): Promise<{ status: number; body: unknown }> {
    const response = await this.fetchImpl(url, { signal: AbortSignal.timeout(8000) });
    if (response.status === 400 || response.status === 404) return { status: response.status, body: null };
    if (!response.ok) throw new Error(`Jupiter answered ${response.status}`);
    return { status: response.status, body: await response.json() };
  }

  /** SOL (lamports) that selling `amount` of `mint` returns now. */
  async quoteSell(mint: string, amount: bigint): Promise<bigint> {
    if (amount === 0n) return 0n;
    const data = await this.rpc.getAccountData(bondingCurveAddress(mint));
    const curve = data ? decodeBondingCurve(data) : undefined;
    if (curve && !curve.complete) return curveSellQuote(curve, amount);
    // On PumpSwap (or not a pump.fun coin at all): ask Jupiter, and read "no route" as "no price".
    const qs = new URLSearchParams({ inputMint: mint, outputMint: WSOL_MINT, amount: amount.toString(), slippageBps: "100", swapMode: "ExactIn" });
    const { body } = await this.getJson(`${this.jupiterBase}/swap/v1/quote?${qs}`);
    const out = (body as { outAmount?: unknown } | null)?.outAmount;
    return typeof out === "string" ? BigInt(out) : 0n;
  }

  /** Tokens that spending `lamports` buys on the curve (0 when the coin is not on the curve). */
  async quoteBuy(mint: string, lamports: bigint): Promise<bigint> {
    const data = await this.rpc.getAccountData(bondingCurveAddress(mint));
    const curve = data ? decodeBondingCurve(data) : undefined;
    return curve && !curve.complete ? curveBuyQuote(curve, lamports) : 0n;
  }

  async balanceOf(mint: string, owner: string): Promise<bigint> {
    return this.rpc.getTokenBalance(owner, mint);
  }

  /** Everything the wallet holds, valued. Only the coins named are counted: unsolicited airdrops cannot inflate it. */
  async holdings(wallet: string, mints: readonly string[]): Promise<SolanaHoldings> {
    const [solLamports, positions] = await Promise.all([
      this.rpc.getBalance(wallet),
      Promise.all(
        mints.map(async (mint): Promise<SolanaPosition> => {
          const balance = await this.rpc.getTokenBalance(wallet, mint);
          return { mint, balance, valueLamports: balance === 0n ? 0n : await this.quoteSell(mint, balance) };
        }),
      ),
    ]);
    const positionsLamports = positions.reduce((sum, p) => sum + p.valueLamports, 0n);
    return { solLamports, positions, positionsLamports, equityLamports: solLamports + positionsLamports };
  }

  /** What one SOL is worth in US dollars right now (Jupiter's price). Throws when it cannot be read. */
  async usdPerSol(): Promise<number> {
    const { body } = await this.getJson(`${this.jupiterBase}/price/v3?ids=${WSOL_MINT}`);
    const usd = (body as Record<string, { usdPrice?: unknown }> | null)?.[WSOL_MINT]?.usdPrice;
    if (typeof usd !== "number" || !(usd > 0)) throw new Error("SOL price unavailable");
    return usd;
  }
}
