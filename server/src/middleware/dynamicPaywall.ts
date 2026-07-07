import type { Request, Response, NextFunction } from "express";
import { paymentMiddleware } from "@x402/express";
import { eq } from "drizzle-orm";
import { db } from "../db/client.js";
import { resources } from "../db/schema.js";
import type { RoutesConfig } from "@x402/core/server";
import { getLogger } from "../lib/logger.js";
import { network, sharedX402ResourceServer } from "../lib/x402.js";
import { getResource } from "../services/registryClient.js";
import { getOnChainPrice, normalizeUsdcPrice } from "../lib/stellarRegistry.js";
import { findActiveLeaseByToken } from "../services/leaseService.js";

// Parse an `Authorization: Lease <token>` header into the opaque lease token,
// or null when absent / not a Lease scheme. Backward-compatible: any other
// Authorization value (or none) yields null and the per-request 402 flow runs.
export function parseLeaseToken(authHeader: unknown): string | null {
  if (typeof authHeader !== "string") return null;
  const match = /^Lease\s+(.+)$/i.exec(authHeader.trim());
  return match ? match[1].trim() : null;
}

// Cache middleware instances by resource ID to avoid re-creating on every request
const middlewareCache = new Map<
  string,
  { mw: ReturnType<typeof paymentMiddleware>; expiresAt: number }
>();
const CACHE_TTL_MS = 60_000; // 1 minute

export async function dynamicPaywall(req: Request, res: Response, next: NextFunction) {
  const resourceId = req.params.id as string;

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

  // Lease short-circuit (ADR: Time-Limited Access Leases). BEFORE issuing a 402,
  // if the caller presents a valid `Authorization: Lease <token>` for an active,
  // non-revoked lease on this resource, deliver without any payment. This is
  // strictly additive: no token, or an invalid/expired/revoked token, falls
  // through to the unchanged per-request 402 flow below.
  const leaseToken = parseLeaseToken(req.headers["authorization"]);
  if (leaseToken) {
    try {
      const lease = await findActiveLeaseByToken(resourceId, leaseToken);
      if (lease) {
        (req as any).resource = resource;
        (req as any).lease = lease;
        getLogger().info(
          { event: "paywall_lease_grant", resourceId, leaseId: lease.id },
          "active lease presented; skipping 402",
        );
        next();
        return;
      }
    } catch (err) {
      // A lease lookup failure must never harden into a hard error — fall back
      // to the normal paid flow so access is never wrongly denied by this check.
      getLogger().warn(
        { event: "paywall_lease_lookup_failed", resourceId, err },
        "lease lookup failed; falling back to per-request 402 flow",
      );
    }
  }

  // Validate the DB price against the on-chain registry before serving a 402.
  // If they disagree we refuse the request rather than charge the wrong amount.
  let onChainPrice: string;
  let onChainCreator: string;
  try {
    const onChain = await getOnChainPrice(resourceId);
    onChainPrice = onChain.price;
    onChainCreator = onChain.creator;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const cause =
      err instanceof Error && err.cause instanceof Error ? err.cause.message : undefined;
    getLogger().error(
      {
        event: "paywall_chain_lookup_failed",
        resourceId,
        error: message,
        cause,
      },
      "on-chain price lookup failed",
    );
    res.status(503).json({
      error: "chain_unavailable",
      message: "Unable to verify resource price. Please try again later.",
      resourceId,
    });
    return;
  }

  const dbPriceNormalized = normalizeUsdcPrice(resource.price);
  if (dbPriceNormalized !== onChainPrice) {
    getLogger().warn(
      {
        event: "paywall_price_mismatch",
        resourceId,
        dbPrice: resource.price,
        chainPrice: onChainPrice,
        publisherWallet: resource.walletAddress,
        onChainCreator,
      },
      "price mismatch between database and on-chain registry",
    );
    res.status(409).json({
      error: "price_mismatch",
      message:
        "Resource price is temporarily unavailable due to a configuration issue. Please try again later.",
      resourceId,
    });
    return;
  }

  // Attach resource to request for the delivery handler
  (req as any).resource = resource;

  // Try to get on-chain price if resource is registered
  let finalPrice = resource.price;
  if (resource.onchainStatus === "registered") {
    try {
      const onchainResource = await getResource(resourceId);
      if (onchainResource) {
        // Convert from stroops (7 decimals) to USDC string
        const onchainPriceUsdc = (Number(onchainResource.price) / 10_000_000).toString();
        finalPrice = onchainPriceUsdc;
      }
    } catch (error) {
      getLogger().warn(
        { event: "paywall_onchain_price_fallback", resourceId, err: error },
        "failed to fetch on-chain price; using database price",
      );
      // Fall back to database price
    }
  }

  // Check cache with final price as part of cache key
  const cacheKey = `${resourceId}:${finalPrice}`;
  const cached = middlewareCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.mw(req, res, next);
  }

  // Build route config for this specific resource
  const routePath = `GET /resources/${resourceId}`;
  const routes: RoutesConfig = {
    [routePath]: {
      accepts: {
        scheme: "exact" as const,
        network,
        payTo: resource.walletAddress,
        price: finalPrice,
      },
      description: resource.title,
    },
  };

  const mw = paymentMiddleware(routes, sharedX402ResourceServer);

  // Cache it with the final price key
  middlewareCache.set(cacheKey, {
    mw,
    expiresAt: Date.now() + CACHE_TTL_MS,
  });

  return mw(req, res, next);
}
