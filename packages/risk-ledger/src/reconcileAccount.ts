import { Decimal } from "decimal.js";
import {
  StateConfidence,
  type AccountRiskHead,
  type RiskLedgerStore,
  type VenueFlowState,
  type VenueStateReader,
} from "@mypropguard/domain";

export interface ReconcileAccountInput {
  accountId: string;
  /** The address to read on the venue (e.g. the Hyperliquid account address). */
  venueAddress: string;
}

export interface ReconcileAccountResult {
  head: AccountRiskHead;
}

export interface ReconcileAccountOptions {
  /** Overrides "now" - only for tests that need to cross a UTC day boundary. */
  now?: Date;
}

function utcDay(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/**
 * Read-only reconciliation: fetches the account's live venue state and folds it into
 * `account_risk_heads`, then records a VERIFIED StateCheckpoint. No signing, no order placement -
 * this can only ever make the ProtectionGate MORE willing to trust the account's numbers, never
 * touch funds.
 *
 * It also keeps the daily profit/loss number honest, which a plain "account value" cannot:
 * - Capital flows: the venue's ledger of deposits, withdrawals and transfers is read, valued in USD
 *   and accumulated in `cumulativeFlowUsd`. `currentEquity` is stored net of it, so a deposit is not
 *   a gain and a withdrawal is not a loss.
 * - Day rollover: `equityStartOfDay` is anchored to the first reconcile of each UTC day. The very first
 *   reconcile ever also replaces whatever "initial equity" was typed at account creation, which was
 *   never a real number, and resets the peak the same way.
 * - Read order: the account value is read first and the ledger after it, so a withdrawal that lands
 *   between the two reads can only make equity look momentarily HIGHER (corrected next time), never
 *   lower, and so can never freeze an account on a half-read.
 *
 * `openNotional`/`leverage` are overwritten with the venue's own numbers (the actual truth).
 * Without `getCapitalFlows` on the reader it still anchors and rolls the day, but cannot net out flows.
 */
export async function reconcileAccountFromVenue(
  store: RiskLedgerStore,
  venueReader: VenueStateReader,
  input: ReconcileAccountInput,
  options: ReconcileAccountOptions = {},
): Promise<ReconcileAccountResult> {
  const now = options.now ?? new Date();
  const today = utcDay(now);
  const state = await venueReader.getClearinghouseState(input.venueAddress);
  const stateTimeMs = state.time ?? now.getTime();

  return store.runExclusive(input.accountId, async (ctx) => {
    const head = await ctx.getAccountRiskHead(input.accountId);
    const previous: VenueFlowState | null = head.venueFlowState ?? null;

    let cumulativeFlowUsd = previous?.cumulativeFlowUsd ?? new Decimal(0);
    let cursorMs = previous?.cursorMs ?? stateTimeMs;

    if (previous) {
      if (venueReader.getCapitalFlows) {
        const flows = await venueReader.getCapitalFlows(input.venueAddress, previous.cursorMs);
        for (const flow of flows) {
          cumulativeFlowUsd = cumulativeFlowUsd.plus(flow.amountUsd);
          cursorMs = Math.max(cursorMs, flow.timeMs);
        }
      }
      cursorMs = Math.max(cursorMs, previous.cursorMs, stateTimeMs);
    }

    const adjustedEquity = state.accountValue.minus(cumulativeFlowUsd);
    const isFirstReconcile = previous === null;
    const isNewDay = isFirstReconcile || previous.day !== today;

    const updatedHead: AccountRiskHead = {
      ...head,
      currentEquity: adjustedEquity,
      peakEquity: isFirstReconcile ? adjustedEquity : Decimal.max(head.peakEquity, adjustedEquity),
      equityStartOfDay: isNewDay ? adjustedEquity : head.equityStartOfDay,
      realizedPnlToday: isNewDay ? new Decimal(0) : head.realizedPnlToday,
      openNotional: state.totalNotionalPosition,
      leverage: state.accountValue.gt(0) ? state.totalNotionalPosition.div(state.accountValue) : new Decimal(0),
      venueFlowState: { day: today, cursorMs, cumulativeFlowUsd },
    };

    await ctx.updateAccountRiskHead(updatedHead);
    await ctx.recordStateCheckpoint({
      accountId: input.accountId,
      confidence: StateConfidence.VERIFIED,
      verifiedAt: now,
    });

    return { head: updatedHead };
  });
}
