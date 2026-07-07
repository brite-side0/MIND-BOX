import {
  pgTable,
  text,
  real,
  integer,
  boolean,
  timestamp,
  pgEnum,
  index,
  customType,
} from "drizzle-orm/pg-core";
import { createId } from "@paralleldrive/cuid2";

// Postgres `tsvector` used for catalog full-text search (migration 0008). The
// column is a STORED generated column in the DB, so it is read-only from the
// app's perspective — it is only ever referenced in FTS predicates/ranking,
// never inserted or updated. Drizzle has no native tsvector type, so we declare
// a minimal custom type just so queries can reference `resources.searchVector`.
const tsvector = customType<{ data: string; driverData: string }>({
  dataType() {
    return "tsvector";
  },
});

export const resourceTypeEnum = pgEnum("resource_type", ["file", "link"]);

export const verificationStatusEnum = pgEnum("verification_status", [
  "pending",
  "verified",
  "rejected",
  "skipped",
]);

export const onchainStatusEnum = pgEnum("onchain_status_enum", [
  "none",
  "pending",
  "registered",
  "failed",
]);

// Publishers — humans or AI agents that publish resources
export const publishers = pgTable("publishers", {
  id: text("id")
    .primaryKey()
    .$defaultFn(() => createId()),
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  walletAddress: text("wallet_address").notNull(),
  apiKeyHash: text("api_key_hash").notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

// Resources — digital assets published on the marketplace
export const resources = pgTable(
  "resources",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => createId()),
    publisherId: text("publisher_id")
      .notNull()
      .references(() => publishers.id),
    title: text("title").notNull(),
    description: text("description"),
    price: text("price").notNull(),
    walletAddress: text("wallet_address").notNull(),
    resourceType: resourceTypeEnum("resource_type").notNull(),
    storagePath: text("storage_path"),
    thumbnailPath: text("thumbnail_path"),
    contentHash: text("content_hash"),
    externalUrl: text("external_url"),
    mimeType: text("mime_type"),
    verificationStatus: verificationStatusEnum("verification_status").notNull().default("pending"),
    verificationId: text("verification_id"),
    listed: boolean("listed").notNull().default(false),
    onchainStatus: onchainStatusEnum("onchain_status").notNull().default("none"),
    onchainTxHash: text("onchain_tx_hash"),
    // Generated STORED tsvector (title weighted A, description B) — migration
    // 0008. Read-only: never written by the app, only matched against in FTS
    // catalog search. See resourceService.queryCatalogSearch.
    searchVector: tsvector("search_vector"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => ({
    catalogFilterSortIdx: index("idx_resources_catalog_filter_sort").on(
      table.listed,
      table.verificationStatus,
      table.createdAt,
    ),
    // GIN index backing the full-text `search_vector @@ query` match (#, 0008).
    searchVectorIdx: index("idx_resources_search_vector").using("gin", table.searchVector),
    // Publisher dashboards list a single publisher's resources (#285).
    publisherIdx: index("idx_resources_publisher_id").on(table.publisherId),
    // Verification-status filters that aren't anchored to `listed` can't use the
    // composite catalog index, so they get their own (#285).
    verificationStatusIdx: index("idx_resources_verification_status").on(table.verificationStatus),
  }),
);

// Verifications — AI originality check results
export const verifications = pgTable("verifications", {
  id: text("id")
    .primaryKey()
    .$defaultFn(() => createId()),
  resourceId: text("resource_id")
    .notNull()
    .references(() => resources.id),
  isOriginal: boolean("is_original").notNull(),
  confidence: real("confidence").notNull(), // 0.0 - 1.0
  flags: text("flags"), // JSON stringified array of issues
  // Token usage + estimated spend for the verification model call (#283).
  // Nullable so historical rows predating usage tracking remain valid.
  promptTokens: integer("prompt_tokens"),
  completionTokens: integer("completion_tokens"),
  totalTokens: integer("total_tokens"),
  estimatedCost: text("estimated_cost"), // USD, stringified for precision
  checkedAt: timestamp("checked_at").defaultNow().notNull(),
});

// Payments — tracks x402 payments for resources
export const payments = pgTable(
  "payments",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => createId()),
    resourceId: text("resource_id")
      .notNull()
      .references(() => resources.id),
    payerAddress: text("payer_address").notNull(),
    recipientAddress: text("recipient_address").notNull(),
    amount: text("amount").notNull(), // USDC amount
    paidAt: timestamp("paid_at").defaultNow().notNull(),
  },
  (table) => ({
    // Payment history is queried per payer wallet (#285).
    payerAddressIdx: index("idx_payments_payer_address").on(table.payerAddress),
  }),
);

// Leases — time-limited access entitlements (ADR: Time-Limited Access Leases,
// Option A off-chain lease table). A lease says "holder_address may access
// resource_id until expires_at". The server is authoritative: the paywall
// checks for an active, non-revoked lease before issuing a 402 (migration 0009).
//
// Read-time identity uses an opaque lease token (returned once at purchase);
// only its sha256 hash is stored here — never the plaintext (see utils/crypto).
export const leases = pgTable(
  "leases",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => createId()),
    resourceId: text("resource_id")
      .notNull()
      .references(() => resources.id),
    holderAddress: text("holder_address").notNull(),
    // sha256 of the opaque lease token — the plaintext is shown once at purchase.
    tokenHash: text("token_hash").notNull(),
    amount: text("amount").notNull(), // USDC amount paid for the window
    paymentTx: text("payment_tx"), // settlement reference, when available
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
  },
  (table) => ({
    // Leases are looked up per resource + holder (ADR sketch index).
    resourceHolderIdx: index("idx_leases_resource_holder").on(
      table.resourceId,
      table.holderAddress,
    ),
  }),
);

// Disputes — buyer-filed refund disputes (ADR: adr-refund-escrow-mechanism.md,
// Option C: Server-Mediated Partial Refunds). Payments still settle directly
// buyer -> creator via x402; a dispute is a claim against the platform-run
// refund pool wallet, not against the original payment. `status` starts
// 'pending' and resolves to 'upheld' (refund issued, best-effort) or 'denied'.
// See services/disputeService.ts and services/refundService.ts.
export const disputes = pgTable(
  "disputes",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => createId()),
    resourceId: text("resource_id")
      .notNull()
      .references(() => resources.id),
    buyerAddress: text("buyer_address").notNull(),
    amount: text("amount").notNull(), // USDC amount claimed
    reason: text("reason").notNull(),
    // pending | upheld | denied
    status: text("status").notNull().default("pending"),
    // Refund transfer tx hash, when a refund was actually executed on-chain.
    // Null while pending, and also null when a dispute is upheld but refund
    // execution was disabled (no REFUND_WALLET_SECRET configured).
    refundTx: text("refund_tx"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
  },
  (table) => ({
    // Duplicate-open-dispute checks and buyer dispute history are looked up
    // per resource + buyer.
    resourceBuyerIdx: index("idx_disputes_resource_buyer").on(table.resourceId, table.buyerAddress),
    // Admin/ops dashboards filter open disputes by status.
    statusIdx: index("idx_disputes_status").on(table.status),
  }),
);
