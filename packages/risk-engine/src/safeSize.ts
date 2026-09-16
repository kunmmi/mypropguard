import { Decimal } from "decimal.js";
import { RuleType } from "@mypropguard/domain";

const SAFE_SIZE_DECIMAL_PLACES = 8;

export interface SafeSizeContext {
  ruleType: typeof RuleType.MAX_LEVERAGE | typeof RuleType.MAX_POSITION_SIZE | typeof RuleType.MAX_EXPOSURE;
  /** The rule's cap: a leverage multiple for MAX_LEVERAGE, a notional amount otherwise. */
  param: Decimal;
  /** Notional already committed before this order (existing position / account exposure). */
  existingNotional: Decimal;
  equity: Decimal;
  price: Decimal;
  proposedSize: Decimal;
}

/**
 * Given a sizeable-rule breach, computes the largest order size that would
 * bring the account back within the cap. Returns null when even the
 * smallest positive size would breach the cap (i.e. the order must be a
 * hard BLOCK, not a RESIZE).
 */
export function solveSafeSize(ctx: SafeSizeContext): Decimal | null {
  const capNotional =
    ctx.ruleType === RuleType.MAX_LEVERAGE ? ctx.param.times(ctx.equity) : ctx.param;

  const remainingNotional = capNotional.minus(ctx.existingNotional);
  if (remainingNotional.lte(0) || ctx.price.lte(0)) {
    return null;
  }

  const safeSize = Decimal.min(
    ctx.proposedSize,
    remainingNotional.div(ctx.price),
  ).toDecimalPlaces(SAFE_SIZE_DECIMAL_PLACES, Decimal.ROUND_DOWN);

  return safeSize.gt(0) ? safeSize : null;
}
