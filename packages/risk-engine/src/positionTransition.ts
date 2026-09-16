import { Decimal } from "decimal.js";
import { OrderSide, PositionTransition } from "@mypropguard/domain";

export interface PositionTransitionResult {
  transition: PositionTransition;
  resultingSize: Decimal;
  /** FLIP/OPEN/INCREASE open new risk and are subject to risk-increasing caps.
   * REDUCE/CLOSE are always permitted regardless of caps, per the blueprint's
   * "closing and reducing positions are always permitted" invariant. */
  isRiskIncreasing: boolean;
}

/**
 * Classifies how a proposed fill would change an existing (signed) position:
 * positive size = long, negative = short, zero = flat.
 */
export function classifyPositionTransition(
  currentSize: Decimal,
  side: OrderSide,
  orderSize: Decimal,
): PositionTransitionResult {
  const signedDelta = side === OrderSide.BUY ? orderSize : orderSize.neg();
  const resultingSize = currentSize.plus(signedDelta);

  if (currentSize.isZero()) {
    return { transition: PositionTransition.OPEN, resultingSize, isRiskIncreasing: true };
  }

  const sameDirection = currentSize.gt(0) === resultingSize.gt(0);

  if (resultingSize.isZero()) {
    return { transition: PositionTransition.CLOSE, resultingSize, isRiskIncreasing: false };
  }

  if (!sameDirection) {
    return { transition: PositionTransition.FLIP, resultingSize, isRiskIncreasing: true };
  }

  if (resultingSize.abs().gt(currentSize.abs())) {
    return { transition: PositionTransition.INCREASE, resultingSize, isRiskIncreasing: true };
  }

  return { transition: PositionTransition.REDUCE, resultingSize, isRiskIncreasing: false };
}
