import { usdcToStroops, stroopsToUsdc } from "../utils/usdc.js";

// Pure helpers for the dispute/refund flow (ADR: adr-refund-escrow-mechanism.md,
// Option C). Kept free of db/config/network imports so they're trivially unit
// testable. Both disputeService.ts and refundService.ts depend on this module
// (rather than on each other) to avoid a circular import between them.

export type DisputeStatus = "pending" | "upheld" | "denied";

/**
 * A dispute may only transition from 'pending' to a terminal state
 * ('upheld' | 'denied'). Any other transition — including re-ruling an
 * already-resolved dispute — is invalid, which makes ruleDispute idempotent.
 */
export function isValidStatusTransition(current: DisputeStatus, next: DisputeStatus): boolean {
  if (current !== "pending") return false;
  return next === "upheld" || next === "denied";
}

/**
 * True when `existing` already contains an open ('pending') dispute — used to
 * reject filing a second dispute for the same (resource, buyer) pair while one
 * is unresolved.
 */
export function hasOpenDispute(existing: Array<{ status: string }>): boolean {
  return existing.some((dispute) => dispute.status === "pending");
}

/**
 * Cap a refund payout to the configured policy maximum:
 * min(disputeAmount, maxAmount ?? disputeAmount). Both amounts are USDC
 * decimal strings; comparison happens in integer stroops to avoid float
 * precision issues. `maxAmount` of undefined/empty means "no cap".
 */
export function capRefundAmount(amount: string, maxAmount?: string): string {
  if (!maxAmount) return amount;

  const amountStroops = usdcToStroops(amount);
  const maxStroops = usdcToStroops(maxAmount);

  return amountStroops <= maxStroops ? amount : stroopsToUsdc(maxStroops);
}
