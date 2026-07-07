import { and, eq } from "drizzle-orm";
import OpenAI from "openai";
import { db } from "../db/client.js";
import { disputes, payments, resources } from "../db/schema.js";
import { config } from "../config.js";
import { getLogger } from "../lib/logger.js";
import { executeRefund } from "./refundService.js";
import { isValidStatusTransition, hasOpenDispute, type DisputeStatus } from "./disputeHelpers.js";

export { isValidStatusTransition, hasOpenDispute, capRefundAmount } from "./disputeHelpers.js";
export type { DisputeStatus } from "./disputeHelpers.js";

type Dispute = typeof disputes.$inferSelect;

// Dispute filing/ruling for the server-mediated refund flow (ADR:
// adr-refund-escrow-mechanism.md, Option C). Payments settle buyer -> creator
// directly via x402 as today; a dispute is a claim against the platform
// refund-pool wallet, checked against a real settled payment.
//
// NOTE: mindbox_dispute / mindbox_dispute_status MCP tools are a follow-up
// (ADR Recommended Follow-Up Issue #1) and are intentionally out of scope here.

/**
 * File a dispute for a (resourceId, buyerAddress) pair.
 *
 * Rejects when there's no matching settled payment (the buyer must have
 * actually paid for this resource) or when an open ('pending') dispute
 * already exists for the same pair.
 */
export async function fileDispute(input: {
  resourceId: string;
  buyerAddress: string;
  amount: string;
  reason: string;
}): Promise<Dispute> {
  const payment = await db
    .select()
    .from(payments)
    .where(
      and(eq(payments.resourceId, input.resourceId), eq(payments.payerAddress, input.buyerAddress)),
    )
    .then((rows) => rows[0] ?? null);

  if (!payment) {
    throw new Error("No matching settled payment found for this resource and buyer");
  }

  const existing = await db
    .select()
    .from(disputes)
    .where(
      and(eq(disputes.resourceId, input.resourceId), eq(disputes.buyerAddress, input.buyerAddress)),
    );

  if (hasOpenDispute(existing)) {
    throw new Error("An open dispute already exists for this resource and buyer");
  }

  const [dispute] = await db
    .insert(disputes)
    .values({
      resourceId: input.resourceId,
      buyerAddress: input.buyerAddress,
      amount: input.amount,
      reason: input.reason,
      status: "pending",
    })
    .returning();

  return dispute;
}

/** Fetch a dispute by id, or null if it doesn't exist. */
export async function getDispute(id: string): Promise<Dispute | null> {
  return db
    .select()
    .from(disputes)
    .where(eq(disputes.id, id))
    .then((rows) => rows[0] ?? null);
}

/**
 * Rule on a pending dispute. On 'upheld', attempts a refund via
 * refundService (recorded even when refund execution is disabled — refund_tx
 * stays null in that case). Rejects if the dispute is already resolved, which
 * makes this idempotent against repeated ruling calls.
 */
export async function ruleDispute(input: {
  id: string;
  decision: "upheld" | "denied";
}): Promise<Dispute> {
  const dispute = await getDispute(input.id);
  if (!dispute) {
    throw new Error(`Dispute ${input.id} not found`);
  }

  if (!isValidStatusTransition(dispute.status as DisputeStatus, input.decision)) {
    throw new Error(`Dispute ${input.id} is already resolved (status: ${dispute.status})`);
  }

  const resolvedAt = new Date();

  if (input.decision === "denied") {
    const [updated] = await db
      .update(disputes)
      .set({ status: "denied", resolvedAt })
      .where(eq(disputes.id, input.id))
      .returning();
    return updated;
  }

  const refundResult = await executeRefund({
    buyerAddress: dispute.buyerAddress,
    amount: dispute.amount,
  });

  const [updated] = await db
    .update(disputes)
    .set({
      status: "upheld",
      refundTx: refundResult.executed ? (refundResult.txHash ?? null) : null,
      resolvedAt,
    })
    .where(eq(disputes.id, input.id))
    .returning();

  return updated;
}

export interface AiDisputeReview {
  available: boolean;
  recommendation: string;
}

const OpenAIClient = (OpenAI as any).default || OpenAI;

/**
 * Non-binding AI-assisted review of a dispute, for a human/admin to consider
 * before calling ruleDispute. Mirrors verificationService's OpenRouter
 * integration pattern exactly (same client construction, same
 * baseURL/apiKey). Gated on OPENROUTER_API_KEY being configured — if unset,
 * returns a clear "unavailable" result instead of throwing, so the dispute
 * ruling flow never hard-depends on AI review.
 */
export async function reviewDisputeWithAI(
  dispute: Pick<Dispute, "reason" | "amount">,
  resource: Pick<typeof resources.$inferSelect, "title" | "description">,
): Promise<AiDisputeReview> {
  if (!config.OPENROUTER_API_KEY) {
    return {
      available: false,
      recommendation: "AI review unavailable: OPENROUTER_API_KEY is not configured",
    };
  }

  const client = new OpenAIClient({
    baseURL: "https://openrouter.ai/api/v1",
    apiKey: config.OPENROUTER_API_KEY,
  });

  try {
    const response = await client.chat.completions.create({
      model: config.OPENROUTER_MODEL,
      max_tokens: 512,
      messages: [
        {
          role: "system",
          content:
            "You are a non-binding dispute review assistant for a digital marketplace called MindBox. " +
            "Given a buyer's dispute reason and the resource listing, give a short, human-readable " +
            "recommendation (uphold or deny, with a one-sentence rationale). You are advisory only — " +
            "a human admin makes the final call via POST /disputes/:id/rule.",
        },
        {
          role: "user",
          content: `Resource title: ${resource.title}\nResource description: ${resource.description ?? "(none)"}\nDisputed amount: ${dispute.amount}\nBuyer's reason: ${dispute.reason}`,
        },
      ],
    });

    const text = response.choices?.[0]?.message?.content?.trim();
    return {
      available: true,
      recommendation: text || "AI review returned no recommendation",
    };
  } catch (err) {
    getLogger().warn(
      { event: "dispute_ai_review_failed", err },
      "AI-assisted dispute review failed",
    );
    return {
      available: false,
      recommendation: "AI review unavailable: model call failed",
    };
  }
}
