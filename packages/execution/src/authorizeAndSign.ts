import {
  DecisionOutcome,
  type ActionAuthorization,
  type DecisionArtifact,
  type ExecutionSequencer,
  type OrderReservation,
  type ProposedOrder,
  type SignedAction,
  type SignerGateway,
} from "@mypropguard/domain";
import { canonicalizeOrderAction } from "./canonicalize.js";
import { computeConnectionId } from "./connectionId.js";

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
 * Phase 3 scaffold: reservation -> nonce lease -> canonical action ->
 * exact-hash authorization -> signer. Requires an ALLOW/RESIZE decision and
 * its reservation (from reserveOrder in packages/persistence) — this
 * function does not itself evaluate risk.
 *
 * This is architecture proof, not a real execution path — see the
 * Phase-3-scaffold warning on the domain ports it uses.
 */
export async function authorizeAndSignOrder(
  sequencer: ExecutionSequencer,
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

  const connectionId = computeConnectionId(action);
  const authorization: ActionAuthorization = {
    connectionId,
    reservationId: input.reservation.id,
    accountId: input.accountId,
    issuedAt: new Date(),
    expiresAt: action.expiresAt,
  };

  return signer.signExact(authorization, action);
}
