import { Connection, PublicKey, VersionedTransaction } from "@solana/web3.js";

/** The few things the Solana wallet asks of the chain. Kept narrow so tests can stand in for it. */
export interface SolanaRpc {
  /** SOL balance, in lamports. */
  getBalance(address: string): Promise<bigint>;
  /** An account's data, or null when the account does not exist. */
  getAccountData(address: string): Promise<Uint8Array | null>;
  /** The raw token amount `owner` holds of `mint`, across both token programs. */
  getTokenBalance(owner: string, mint: string): Promise<bigint>;
  /** Runs a transaction against the chain without sending it. `err` is null when it would succeed. */
  simulate(transactionBase64: string): Promise<{ err: unknown | null; logs: string[] }>;
  /** Sends a signed transaction. Returns its signature. */
  sendRaw(signedTransactionBase64: string): Promise<string>;
}

/** The real thing, over a Solana JSON-RPC endpoint (set SOLANA_RPC_URL; the public one is rate-limited). */
export class Web3Rpc implements SolanaRpc {
  private readonly connection: Connection;

  constructor(url: string) {
    this.connection = new Connection(url, "confirmed");
  }

  async getBalance(address: string): Promise<bigint> {
    return BigInt(await this.connection.getBalance(new PublicKey(address)));
  }

  async getAccountData(address: string): Promise<Uint8Array | null> {
    const info = await this.connection.getAccountInfo(new PublicKey(address));
    return info ? info.data : null;
  }

  async getTokenBalance(owner: string, mint: string): Promise<bigint> {
    const { value } = await this.connection.getParsedTokenAccountsByOwner(new PublicKey(owner), { mint: new PublicKey(mint) });
    return value.reduce((sum, account) => {
      const amount = (account.account.data as { parsed?: { info?: { tokenAmount?: { amount?: string } } } }).parsed?.info?.tokenAmount?.amount;
      return sum + BigInt(amount ?? "0");
    }, 0n);
  }

  async simulate(transactionBase64: string): Promise<{ err: unknown | null; logs: string[] }> {
    const tx = VersionedTransaction.deserialize(Buffer.from(transactionBase64, "base64"));
    const { value } = await this.connection.simulateTransaction(tx, { sigVerify: false, replaceRecentBlockhash: true, commitment: "processed" });
    return { err: value.err, logs: value.logs ?? [] };
  }

  async sendRaw(signedTransactionBase64: string): Promise<string> {
    return this.connection.sendRawTransaction(Buffer.from(signedTransactionBase64, "base64"), { skipPreflight: false, maxRetries: 3 });
  }
}
