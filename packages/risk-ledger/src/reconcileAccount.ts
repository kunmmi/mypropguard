import { Decimal } from "decimal.js";
import { StateConfidence, type AccountRiskHead, type RiskLedgerStore, type VenueStateReader } from "@mypropguard/domain";

export interface ReconcileAccountInput {
  accountId: string;
  /** The address to read on the venue (e.g. the Hyperliquid account address). */
  venueAddress: string;
}

export interface ReconcileAccountResult {
  head: AccountRiskHead;
}

/**
 * Phase 2 read-only reconciliation: fetches the account's live venue state
 * and folds it into `account_risk_heads`, then records a VERIFIED
 * StateCheckpoint. No signing, no order placement — this can only ever make
 * the ProtectionGate MORE willing to trust the account's numbers, never
 * touch funds.
 *
 * `openNotional`/`leverage` are overwritten with the venue's own numbers
 * (the actual truth), while `equityStartOfDay`/`peakEquity` are preserved
 * across reconciliations so the daily-loss/drawdown baselines set at
 * provisioning (or the last rollover) aren't reset by every reconcile call.
 */
export async function reconcileAccountFromVenue(
  store: RiskLedgerStore,
  venueReader: VenueStateReader,
  input: ReconcileAccountInput,
): Promise<ReconcileAccountResult> {
  const state = await venueReader.getClearinghouseState(input.venueAddress);

  return store.runExclusive(input.accountId, async (ctx) => {
    const head = await ctx.getAccountRiskHead(input.accountId);

    const updatedHead: AccountRiskHead = {
      ...head,
      currentEquity: state.accountValue,
      peakEquity: Decimal.max(head.peakEquity, state.accountValue),
      openNotional: state.totalNotionalPosition,
      leverage: state.accountValue.gt(0) ? state.totalNotionalPosition.div(state.accountValue) : new Decimal(0),
    };

    await ctx.updateAccountRiskHead(updatedHead);
    await ctx.recordStateCheckpoint({
      accountId: input.accountId,
      confidence: StateConfidence.VERIFIED,
      verifiedAt: new Date(),
    });

    return { head: updatedHead };
  });
}
