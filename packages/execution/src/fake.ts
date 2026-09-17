import { createHash } from "node:crypto";
import type {
  ActionAuthorization,
  CanonicalOrderAction,
  ExecutionSequencer,
  NonceLease,
  SignedAction,
  SignerGateway,
} from "@mypropguard/domain";

/**
 * In-memory nonce sequencer for tests, mirroring InMemoryRiskLedgerStore's
 * mutex pattern: concurrent leases for the same account are serialized so
 * two concurrent callers can never receive the same nonce.
 */
export class InMemoryExecutionSequencer implements ExecutionSequencer {
  private readonly counters = new Map<string, number>();
  private readonly locks = new Map<string, Promise<unknown>>();

  async leaseNonce(accountId: string): Promise<NonceLease> {
    const previous = this.locks.get(accountId) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.locks.set(
      accountId,
      previous.then(() => gate),
    );

    await previous;
    try {
      const next = (this.counters.get(accountId) ?? 0) + 1;
      this.counters.set(accountId, next);
      return { accountId, nonce: next, leasedAt: new Date() };
    } finally {
      release();
    }
  }
}

const FAKE_SIGNER_ADDRESS = "0xFAKE00000000000000000000000000000000000";

/**
 * FAKE signer — not a real key, not connected to any venue. Produces a
 * deterministic pseudo-signature (hash of the authorized connectionId) so
 * tests can assert "the signer only ever signs the exact authorized
 * action," without any real cryptography or credentials involved.
 */
export class FakeSignerGateway implements SignerGateway {
  private readonly signedConnectionIds = new Set<string>();

  async signExact(authorization: ActionAuthorization, action: CanonicalOrderAction): Promise<SignedAction> {
    const expectedConnectionId = deterministicFakeHash(action);
    if (authorization.connectionId !== expectedConnectionId) {
      throw new Error("Refused to sign: authorization connectionId does not match the canonical action.");
    }
    if (authorization.expiresAt.getTime() < Date.now()) {
      throw new Error("Refused to sign: authorization has expired.");
    }

    this.signedConnectionIds.add(authorization.connectionId);

    return {
      authorization,
      signature: `fake_sig_${createHash("sha256").update(authorization.connectionId).digest("hex").slice(0, 16)}`,
      signerAddress: FAKE_SIGNER_ADDRESS,
    };
  }

  hasSigned(connectionId: string): boolean {
    return this.signedConnectionIds.has(connectionId);
  }
}

/** Duplicated on purpose: the fake signer independently recomputes the hash
 * rather than trusting the caller's connectionId, mirroring the real
 * default-deny signer boundary the blueprint requires. */
function deterministicFakeHash(action: CanonicalOrderAction): string {
  const canonicalJson = JSON.stringify({
    accountId: action.accountId,
    clientIntentId: action.clientIntentId,
    coin: action.coin,
    side: action.side,
    size: action.size.toString(),
    price: action.price.toString(),
    reduceOnly: action.reduceOnly,
    nonce: action.nonce,
    expiresAt: action.expiresAt.toISOString(),
  });
  return createHash("sha256").update(canonicalJson).digest("hex");
}
