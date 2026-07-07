import {
  Router,
  type Router as RouterType,
  type Request,
  type Response,
  type NextFunction,
} from "express";
import { paymentMiddleware } from "@x402/express";
import type { RoutesConfig } from "@x402/core/server";
import { eq } from "drizzle-orm";
import { apiKeyAuth } from "../middleware/apiKeyAuth.js";
import { validate } from "../middleware/validate.js";
import { purchaseLeaseSchema } from "../schemas/requests.js";
import { db } from "../db/client.js";
import { payments, resources } from "../db/schema.js";
import { network, sharedX402ResourceServer } from "../lib/x402.js";
import { getLogger } from "../lib/logger.js";
import { parsePayerFromXPayment } from "../lib/parseXPayment.js";
import {
  createLease,
  getLeasesForHolder,
  revokeLease,
  computeLeasePrice,
  type DurationTier,
} from "../services/leaseService.js";

// Time-Limited Access Leases API (ADR: adr-time-limited-access-leases.md,
// Option A). A buyer pays once for a duration tier and receives an opaque lease
// token, which subsequent reads present via `Authorization: Lease <token>` to
// skip the per-request 402 (see dynamicPaywall).
//
// NOTE: `mindbox_buy_lease` / `mindbox_lease_status` MCP tools are a follow-up
// (ADR Recommended Follow-Up Issue #4) and are intentionally out of scope here.

const router: RouterType = Router();

// x402 pricing for a lease purchase. Mirrors dynamicPaywall: build a
// resource-scoped `paymentMiddleware` (exact scheme, payTo = creator wallet) so
// USDC still settles buyer -> creator directly — the only difference is the
// price (base × duration multiplier) and that the receipt buys a window rather
// than a single delivery. The lease + payments rows are written only after the
// payment settles (in the handler below).
//
// TODO(#179 follow-up): validate the base price against the on-chain registry
// here too (reuse getOnChainPrice, as dynamicPaywall does) before charging.
async function leasePaywall(req: Request, res: Response, next: NextFunction): Promise<void> {
  const resourceId = req.params.id as string;
  const { durationTier } = req.body as { durationTier: DurationTier };

  const resource = await db
    .select()
    .from(resources)
    .where(eq(resources.id, resourceId))
    .then((rows) => rows[0] ?? null);

  if (!resource) {
    res.status(404).json({ error: "Resource not found" });
    return;
  }
  if (!resource.listed) {
    res.status(404).json({ error: "Resource not listed" });
    return;
  }

  const price = computeLeasePrice(resource.price, durationTier);
  (req as any).resource = resource;
  (req as any).leasePrice = price;

  const routePath = `POST /resources/${resourceId}/leases`;
  const routes: RoutesConfig = {
    [routePath]: {
      accepts: {
        scheme: "exact" as const,
        network,
        payTo: resource.walletAddress,
        price,
      },
      description: `Access lease (${durationTier}) for ${resource.title}`,
    },
  };

  const mw = paymentMiddleware(routes, sharedX402ResourceServer);
  return mw(req, res, next);
}

// POST /resources/:id/leases — purchase a time-limited access lease.
// x402-priced by duration tier; on settlement the server records a lease (with
// an opaque token, returned ONCE) and a payments row so analytics keep working.
router.post(
  "/resources/:id/leases",
  validate(purchaseLeaseSchema),
  leasePaywall,
  async (req, res) => {
    const resource = (req as any).resource as typeof resources.$inferSelect;
    const leasePrice = (req as any).leasePrice as string;
    const { durationTier, holderAddress } = req.body as {
      durationTier: DurationTier;
      holderAddress?: string;
    };

    // Derive the holder + payment reference from the settled x402 payment when
    // not supplied explicitly (best-effort; never blocks issuance).
    let payerAddress: string | undefined = holderAddress;
    const paymentHeader = req.headers["x-payment"];
    if (typeof paymentHeader === "string") {
      const { payer, parseError } = parsePayerFromXPayment(paymentHeader);
      if (payer && !payerAddress) payerAddress = payer;
      if (parseError) {
        getLogger().warn(
          { event: "lease_x_payment_parse_error", resourceId: resource.id, error: parseError },
          "failed to parse X-Payment header for lease purchase",
        );
      }
    }

    if (!payerAddress) {
      res.status(400).json({
        error: "Missing holder address",
        message: "Provide holderAddress in the body or a valid X-Payment header.",
      });
      return;
    }

    const { lease, token } = await createLease({
      resourceId: resource.id,
      holderAddress: payerAddress,
      durationTier,
    });

    // Observability parity (ADR migration step 5): a lease purchase also writes a
    // payments row so existing earnings/analytics aggregations keep working.
    const [payment] = await db
      .insert(payments)
      .values({
        resourceId: resource.id,
        payerAddress,
        recipientAddress: resource.walletAddress,
        amount: leasePrice,
      })
      .returning();

    res.status(201).json({
      lease: {
        id: lease.id,
        resourceId: lease.resourceId,
        holderAddress: lease.holderAddress,
        durationTier,
        amount: lease.amount,
        createdAt: lease.createdAt,
        expiresAt: lease.expiresAt,
      },
      // Plaintext lease token — shown exactly once. Present it on reads via
      // `Authorization: Lease <token>`; the server only stores its sha256 hash.
      token,
      receipt: {
        paymentId: payment.id,
        amount: payment.amount,
        currency: "USDC",
        paidTo: payment.recipientAddress,
        paidAt: payment.paidAt,
      },
    });
  },
);

// GET /resources/:id/leases/me — list the caller's leases for a resource.
// Lease holders are buyers/agents (not necessarily publishers), so identity is
// the Stellar holder address, supplied as `?holder=<address>`.
router.get("/resources/:id/leases/me", async (req, res) => {
  const holder = req.query.holder;
  if (typeof holder !== "string" || holder.length === 0) {
    res.status(400).json({ error: "Missing holder query parameter" });
    return;
  }

  const rows = await getLeasesForHolder(req.params.id as string, holder);
  // Never expose token hashes; the plaintext token was shown once at purchase.
  res.json(
    rows.map((lease) => ({
      id: lease.id,
      resourceId: lease.resourceId,
      holderAddress: lease.holderAddress,
      amount: lease.amount,
      createdAt: lease.createdAt,
      expiresAt: lease.expiresAt,
      revokedAt: lease.revokedAt,
    })),
  );
});

// POST /resources/:id/leases/:holder/revoke — creator revokes a holder's leases.
// Creator-authenticated: the caller must own the resource (same ownership check
// used by other creator-mutating resource routes).
router.post("/resources/:id/leases/:holder/revoke", apiKeyAuth, async (req, res) => {
  const publisher = req.publisher!;
  const resourceId = req.params.id as string;
  const holder = req.params.holder as string;

  const resource = await db
    .select()
    .from(resources)
    .where(eq(resources.id, resourceId))
    .then((rows) => rows[0] ?? null);

  if (!resource) {
    res.status(404).json({ error: "Resource not found" });
    return;
  }
  if (resource.publisherId !== publisher.id) {
    res.status(403).json({ error: "Forbidden: you do not own this resource" });
    return;
  }

  const revoked = await revokeLease({ resourceId, holderAddress: holder });
  res.json({ resourceId, holderAddress: holder, revokedCount: revoked.length });
});

export default router;
