import { config } from "../config.js";
import { getLogger } from "../lib/logger.js";
import { usdcToStroops } from "../utils/usdc.js";
import { submitUsdcTransfer } from "./registryClient.js";
import { capRefundAmount } from "./disputeHelpers.js";

// Refund execution for upheld disputes (ADR: adr-refund-escrow-mechanism.md,
// Option C: Server-Mediated Partial Refunds). USDC moves from a
// platform-controlled refund-pool wallet (REFUND_WALLET_SECRET) directly to
// the buyer — a plain SAC transfer, unrelated to the original x402 payment.

export interface RefundResult {
  executed: boolean;
  txHash?: string;
  reason?: string;
  amount: string;
}

/**
 * Execute a refund payout to `buyerAddress`, capped by REFUND_MAX_AMOUNT.
 *
 * If REFUND_WALLET_SECRET is unset, refund execution is disabled — the caller
 * (disputeService.ruleDispute) still records the ruling, just with a null
 * refund_tx. This keeps the feature runnable/testable without a funded
 * refund-pool wallet, per the ADR's short-term recommendation.
 */
export async function executeRefund(input: {
  buyerAddress: string;
  amount: string;
}): Promise<RefundResult> {
  const cappedAmount = capRefundAmount(input.amount, config.REFUND_MAX_AMOUNT);

  if (!config.REFUND_WALLET_SECRET) {
    getLogger().warn(
      { event: "refund_disabled", buyerAddress: input.buyerAddress, amount: cappedAmount },
      "refund execution skipped: REFUND_WALLET_SECRET is not configured",
    );
    return { executed: false, reason: "refund_disabled", amount: cappedAmount };
  }

  const result = await submitUsdcTransfer({
    fromSecret: config.REFUND_WALLET_SECRET,
    toAddress: input.buyerAddress,
    amountStroops: usdcToStroops(cappedAmount),
  });

  if (!result.success) {
    getLogger().error(
      {
        event: "refund_transfer_failed",
        buyerAddress: input.buyerAddress,
        amount: cappedAmount,
        error: result.error,
      },
      "refund transfer failed",
    );
    return {
      executed: false,
      reason: result.error ?? "refund_transfer_failed",
      amount: cappedAmount,
    };
  }

  return { executed: true, txHash: result.txHash, amount: cappedAmount };
}
