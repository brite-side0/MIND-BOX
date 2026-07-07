-- Time-Limited Access Leases (ADR: adr-time-limited-access-leases.md, Option A).
-- Off-chain, server-authoritative lease table. A lease grants an address
-- windowed access to a resource until `expires_at`; the paywall short-circuits
-- the 402 when an active, non-revoked lease is presented via an opaque token.
--
-- The plaintext lease token is never stored — only its sha256 hash
-- (`token_hash`), mirroring the publishers.api_key_hash pattern. This feature is
-- additive and per-resource opt-in: with no rows, GET /resources/:id behaves
-- exactly as before.
CREATE TABLE IF NOT EXISTS "leases" (
  "id" text PRIMARY KEY NOT NULL,
  "resource_id" text NOT NULL REFERENCES "resources"("id"),
  "holder_address" text NOT NULL,
  "token_hash" text NOT NULL,
  "amount" text NOT NULL,
  "payment_tx" text,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "expires_at" timestamptz NOT NULL,
  "revoked_at" timestamptz
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_leases_resource_holder" ON "leases" ("resource_id","holder_address");
