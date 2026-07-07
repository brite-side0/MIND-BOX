-- Settlement transaction audit trail for payments (Tier-2 hardening, gap 1).
-- Nullable, best-effort: populated from the x402 facilitator's settlement
-- response (X-PAYMENT-RESPONSE / PAYMENT-RESPONSE header) when available.
-- Intentionally no uniqueness constraint — this is an audit/reconciliation
-- field, not a replay/double-spend guard. See src/lib/parseXPaymentResponse.ts
-- and src/routes/resources.ts.
ALTER TABLE "payments" ADD COLUMN IF NOT EXISTS "settlement_tx" text;
