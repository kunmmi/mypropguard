import { Decimal } from "decimal.js";
import {
  DecisionOutcome,
  type DecisionArtifact,
  type OrderReservation,
  type ProposedOrder,
  type RiskLedgerStore,
} from "@mypropguard/domain";
import { evaluate } from "@mypropguard/risk-engine";

export interface ReserveOrderInput {
  accountId: string;
  proposedOrder: ProposedOrder;
  /** Signed existing position size for proposedOrder.coin. */
  currentPositionSize: Decimal;
}

export interface ReserveOrderResult {
  decision: DecisionArtifact;
  reservation: OrderReservation | null;
}

/**
 * The Phase 1 atomic-reservation orchestrator. DB-agnostic: it only depends
 * on the RiskLedgerStore port, so the exact same function is exercised by
 * the in-memory test double (packages/test-fixtures) and the Postgres-backed
 * store (postgres/pgRiskLedgerStore.ts).
 *
 * Outstanding HELD reservations are folded into the projected account state
 * as already-committed notional exposure before evaluating the new intent —
 * this is what stops two concurrent orders from both passing against the
 * same remaining MAX_POSITION_SIZE/MAX_LEVERAGE/MAX_EXPOSURE headroom, on
 * top of the exclusive per-account critical section `runExclusive` already
 * provides. (MAX_DAILY_LOSS/MAX_DRAWDOWN are driven by realized account
 * equity, which reservations do not project forward — a not-yet-filled
 * order's eventual loss is unknowable in advance.)
 */
export async function reserveOrder(store: RiskLedgerStore, input: ReserveOrderInput): Promise<ReserveOrderResult> {
  return store.runExclusive(input.accountId, async (ctx) => {
    // Sequential, not Promise.all: the Postgres-backed LedgerContext issues
    // these through a single client tied to this transaction, which cannot
    // multiplex concurrent queries.
    const head = await ctx.getAccountRiskHead(input.accountId);
    const rules = await ctx.getActiveRules(input.accountId);
    const outstanding = await ctx.getOutstandingReservationTotal(input.accountId);

    const projectedHead = outstanding.gt(0)
      ? { ...head, openNotional: head.openNotional.plus(outstanding) }
      : head;

    const decision = evaluate({
      accountRiskHead: projectedHead,
      rules,
      proposedOrder: input.proposedOrder,
      currentPositionSize: input.currentPositionSize,
    });

    if (decision.outcome === DecisionOutcome.BLOCK) {
      return { decision, reservation: null };
    }

    const approvedSize = decision.approvedSize ?? input.proposedOrder.size;
    const reservedAmount = approvedSize.times(input.proposedOrder.price);

    const reservation = await ctx.insertReservation({
      accountId: input.accountId,
      clientIntentId: input.proposedOrder.clientIntentId,
      coin: input.proposedOrder.coin,
      reservedAmount,
    });

    return { decision, reservation };
  });
}
