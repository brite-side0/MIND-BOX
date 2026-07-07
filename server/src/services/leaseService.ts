import { and, eq } from "drizzle-orm";
import { db } from "../db/client.js";
import { leases, resources } from "../db/schema.js";
import { generateLeaseToken, hashLeaseToken } from "../utils/crypto.js";

// Time-Limited Access Leases (ADR: adr-time-limited-access-leases.md, Option A).
//
// Off-chain, server-authoritative leases. A buyer pays once for a window of
// access (a "duration tier") instead of paying per request. On purchase the
// server mints an opaque lease token, stores only its sha256 hash, and returns
// the plaintext token exactly once. Subsequent reads present the token via
// `Authorization: Lease <token>` and skip the 402 (see dynamicPaywall).

/** Duration tiers offered for a lease. */
export type DurationTier = "1h" | "24h" | "7d";

export const DURATION_TIERS = ["1h", "24h", "7d"] as const;

const SECONDS_PER_HOUR = 3_600;
const SECONDS_PER_DAY = 86_400;

// Tier -> window length in seconds.
const TIER_SECONDS: Record<DurationTier, number> = {
  "1h": SECONDS_PER_HOUR,
  "24h": 24 * SECONDS_PER_HOUR,
  "7d": 7 * SECONDS_PER_DAY,
};

// Default platform pricing policy: lease price = base price × multiplier.
// A window of unlimited reads costs more than a single per-request read, scaling
// with the window length. These defaults are the platform policy; per the ADR
// they are creator-configurable, so a caller may pass an override policy to the
// pure helpers below (kept simple: a plain tier -> multiplier map).
export type TierMultiplierPolicy = Record<DurationTier, number>;

export const DEFAULT_TIER_MULTIPLIERS: TierMultiplierPolicy = {
  "1h": 3,
  "24h": 10,
  "7d": 40,
};

const USDC_DECIMALS = 7;
const STROOPS_PER_USDC = 10n ** BigInt(USDC_DECIMALS);

/** True when `tier` is one of the supported duration tiers. */
export function isDurationTier(value: string): value is DurationTier {
  return (DURATION_TIERS as readonly string[]).includes(value);
}

/** Window length in seconds for a duration tier. */
export function tierToSeconds(tier: DurationTier): number {
  return TIER_SECONDS[tier];
}

/** Price multiplier for a duration tier under the given (or default) policy. */
export function tierMultiplier(
  tier: DurationTier,
  policy: TierMultiplierPolicy = DEFAULT_TIER_MULTIPLIERS,
): number {
  return policy[tier];
}

// Format i128 stroops back into a fixed 7-decimal USDC string. Mirrors
// stellarRegistry.stroopsToUsdc; kept local so the lease service stays free of
// the Stellar/registry/config import chain (and offline-testable).
function stroopsToUsdc(stroops: bigint): string {
  const negative = stroops < 0n;
  const abs = negative ? -stroops : stroops;
  const whole = abs / STROOPS_PER_USDC;
  const frac = abs % STROOPS_PER_USDC;
  const fracStr = frac.toString().padStart(USDC_DECIMALS, "0");
  return `${negative ? "-" : ""}${whole}.${fracStr}`;
}

// Parse a plain USDC decimal string (e.g. "0.50") into i128 stroops without
// floating point, so price math stays exact. Mirrors stellarRegistry's fixed
// 7-decimal convention.
function usdcToStroops(price: string): bigint {
  const trimmed = price.trim();
  if (!/^\d+(\.\d+)?$/.test(trimmed)) {
    throw new Error(`Invalid USDC price string: ${price}`);
  }
  const [whole, frac = ""] = trimmed.split(".");
  const fracPadded = (frac + "0".repeat(USDC_DECIMALS)).slice(0, USDC_DECIMALS);
  return BigInt(whole) * STROOPS_PER_USDC + BigInt(fracPadded);
}

/**
 * Lease price for a resource at a given tier: `base × multiplier`.
 *
 * `basePrice` is the resource's stored USDC price. TODO(#179 follow-up): the ADR
 * specifies the base price should be validated against the on-chain vault
 * registry (the same path dynamicPaywall uses via getOnChainPrice); for this
 * server-side milestone we use the DB price and defer that reuse. Computed in
 * integer stroops for exactness, then formatted back to a USDC string.
 */
export function computeLeasePrice(
  basePrice: string,
  tier: DurationTier,
  policy: TierMultiplierPolicy = DEFAULT_TIER_MULTIPLIERS,
): string {
  const baseStroops = usdcToStroops(basePrice);
  const multiplier = tierMultiplier(tier, policy);
  // Multiplier may be fractional in a custom policy; round to the nearest stroop.
  const resultStroops = BigInt(Math.round(Number(baseStroops) * multiplier));
  return stroopsToUsdc(resultStroops);
}

/** Minimal shape needed to decide whether a lease currently grants access. */
export interface LeaseActivity {
  expiresAt: Date | string;
  revokedAt: Date | string | null;
}

/**
 * A lease grants access while it is unexpired AND not revoked. Expiry is purely
 * time-based (`now < expiresAt`); revocation (`revokedAt` set) makes a lease
 * inactive immediately, even before expiry.
 */
export function isActive(lease: LeaseActivity, now: Date = new Date()): boolean {
  if (lease.revokedAt !== null && lease.revokedAt !== undefined) return false;
  return now.getTime() < new Date(lease.expiresAt).getTime();
}

/**
 * Create a lease: mint an opaque token, store its hash, and compute the window.
 * Returns the persisted lease plus the plaintext token, which is surfaced to the
 * buyer exactly once and never stored.
 */
export async function createLease(input: {
  resourceId: string;
  holderAddress: string;
  durationTier: DurationTier;
  paymentTx?: string | null;
  policy?: TierMultiplierPolicy;
}): Promise<{ lease: typeof leases.$inferSelect; token: string }> {
  const resource = await db
    .select()
    .from(resources)
    .where(eq(resources.id, input.resourceId))
    .then((rows) => rows[0] ?? null);

  if (!resource) {
    throw new Error(`Resource ${input.resourceId} not found`);
  }

  const amount = computeLeasePrice(resource.price, input.durationTier, input.policy);
  const token = generateLeaseToken();
  const tokenHash = hashLeaseToken(token);
  const expiresAt = new Date(Date.now() + tierToSeconds(input.durationTier) * 1000);

  const [lease] = await db
    .insert(leases)
    .values({
      resourceId: input.resourceId,
      holderAddress: input.holderAddress,
      tokenHash,
      amount,
      paymentTx: input.paymentTx ?? null,
      expiresAt,
    })
    .returning();

  return { lease, token };
}

/**
 * Resolve an active lease for `(resourceId, token)`. The plaintext token is
 * hashed and matched against `token_hash`; the lease is returned only when it is
 * currently active (unexpired and not revoked). Any miss returns null so the
 * paywall falls back to the per-request flow.
 */
export async function findActiveLeaseByToken(
  resourceId: string,
  token: string,
  now: Date = new Date(),
): Promise<typeof leases.$inferSelect | null> {
  const tokenHash = hashLeaseToken(token);
  const lease = await db
    .select()
    .from(leases)
    .where(and(eq(leases.resourceId, resourceId), eq(leases.tokenHash, tokenHash)))
    .then((rows) => rows[0] ?? null);

  if (!lease) return null;
  return isActive(lease, now) ? lease : null;
}

/** All leases (active or not) held by an address for a resource. */
export async function getLeasesForHolder(
  resourceId: string,
  holderAddress: string,
): Promise<Array<typeof leases.$inferSelect>> {
  return db
    .select()
    .from(leases)
    .where(and(eq(leases.resourceId, resourceId), eq(leases.holderAddress, holderAddress)));
}

/**
 * Revoke every not-yet-revoked lease held by an address for a resource by
 * stamping `revoked_at`. Revocation is immediate — validation treats a revoked
 * lease as inactive even before expiry. Returns the updated rows.
 */
export async function revokeLease(input: {
  resourceId: string;
  holderAddress: string;
  now?: Date;
}): Promise<Array<typeof leases.$inferSelect>> {
  return db
    .update(leases)
    .set({ revokedAt: input.now ?? new Date() })
    .where(
      and(eq(leases.resourceId, input.resourceId), eq(leases.holderAddress, input.holderAddress)),
    )
    .returning();
}
