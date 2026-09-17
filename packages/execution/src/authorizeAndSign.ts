import {
  DecisionOutcome,
  type ActionAuthorization,
  type ActionHasher,
  type DecisionArtifact,
  type ExecutionSequencer,
  type OrderReservation,
  type ProposedOrder,
  type SignedAction,
  type SignerGateway,
} from "@mypropguard/domain";
import { canonicalizeOrderAction } from "./canonicalize.js";

const DEFAULT_TTL_MS = 30_000;

export class BlockedDecisionError extends Error {
  constructor() {
    super("Cannot authorize/sign a BLOCK decision.");
    this.name = "BlockedDecisionError";
  }
}

export interface AuthorizeAndSignInput {
  accountId: string;
  proposedOrder: ProposedOrder;
  decision: DecisionArtifact;
  reservation: OrderReservation;
  ttlMs?: number;
}

/**
 * Reservation -> nonce lease -> canonical action -> exact-hash authorization
 * -> signer. Requires an ALLOW/RESIZE decision and its reservation (from
 * reserveOrder in packages/persistence) — this function does not itself
 * evaluate risk.
 *
 * The `hasher` determines whether the resulting authorization is real
 * (`HyperliquidActionHasher`, packages/hyperliquid — produces a hash
 * Hyperliquid's real validator would check) or a fast offline placeholder
 * (`PlaceholderActionHasher`, this package — for testing the orchestration
 * shape without network calls). Pass the hasher that matches whichever
 * signer you're driving: PrivySignerGateway independently recomputes the
 * real hash and refuses anything else, so pairing it with the placeholder
 * hasher fails closed rather than producing a bad signature.
 */
export async function authorizeAndSignOrder(
  sequencer: ExecutionSequencer,
  hasher: ActionHasher,
  signer: SignerGateway,
  input: AuthorizeAndSignInput,
): Promise<SignedAction> {
  if (input.decision.outcome === DecisionOutcome.BLOCK) {
    throw new BlockedDecisionError();
  }

  const approvedSize = input.decision.approvedSize ?? input.proposedOrder.size;
  const lease = await sequencer.leaseNonce(input.accountId);

  const action = canonicalizeOrderAction({
    accountId: input.accountId,
    clientIntentId: input.proposedOrder.clientIntentId,
    coin: input.proposedOrder.coin,
    side: input.proposedOrder.side,
    size: approvedSize,
    price: input.proposedOrder.price,
    reduceOnly: input.proposedOrder.reduceOnly,
    nonce: lease.nonce,
    ttlMs: input.ttlMs ?? DEFAULT_TTL_MS,
  });

  const connectionId = await hasher.computeConnectionId(action);
  const authorization: ActionAuthorization = {
    connectionId,
    reservationId: input.reservation.id,
    accountId: input.accountId,
    issuedAt: new Date(),
    expiresAt: action.expiresAt,
  };

  return signer.signExact(authorization, action);
}
