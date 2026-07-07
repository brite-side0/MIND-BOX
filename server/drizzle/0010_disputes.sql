-- Disputes (ADR: adr-refund-escrow-mechanism.md, Option C: Server-Mediated
-- Partial Refunds). Payments still settle buyer -> creator directly via x402;
-- a dispute is a claim against the platform-run refund pool wallet. Status
-- starts 'pending' and resolves to 'upheld' (refund issued, best-effort) or
-- 'denied'. `refund_tx` is set only when a refund transfer actually executed
-- on-chain (null while pending, and also null when upheld but refund
-- execution was disabled — no REFUND_WALLET_SECRET configured).
CREATE TABLE IF NOT EXISTS "disputes" (
  "id" text PRIMARY KEY NOT NULL,
  "resource_id" text NOT NULL REFERENCES "resources"("id"),
  "buyer_address" text NOT NULL,
  "amount" text NOT NULL,
  "reason" text NOT NULL,
  "status" text NOT NULL DEFAULT 'pending',
  "refund_tx" text,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "resolved_at" timestamptz
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_disputes_resource_buyer" ON "disputes" ("resource_id","buyer_address");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_disputes_status" ON "disputes" ("status");
