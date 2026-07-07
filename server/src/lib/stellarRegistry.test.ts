import { describe, it, expect, vi } from "vitest";

// stellarRegistry's default fetcher pulls in registryClient (and through it the
// real config, which process.exits on missing env). All tests inject their own
// fetcher, so mock the module boundary away entirely.
vi.mock("../services/registryClient.js", () => ({
  getResource: vi.fn(),
}));

import { createCache, getOnChainPrice, OnChainLookupError } from "./stellarRegistry.js";

const TTL_MS = 5 * 60 * 1000;
const GRACE_MS = 10 * 60 * 1000;

function fixedNow(ms: number) {
  return () => ms;
}

describe("getOnChainPrice stale-on-error fallback", () => {
  it("returns a fresh fetch and caches it (no fallback involved)", async () => {
    const cache = createCache();
    const fetcher = vi.fn().mockResolvedValue({ price: 5_000_000n, creator: "GCREATOR" });

    const result = await getOnChainPrice("res-1", {
      cache,
      fetcher,
      now: fixedNow(1_000),
      ttlMs: TTL_MS,
      staleGraceMs: GRACE_MS,
    });

    expect(result).toEqual({ price: "0.5000000", creator: "GCREATOR", cached: false });
    expect(result.stale).toBeUndefined();
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("serves an expired cache entry with stale:true when the fetch fails within the grace window", async () => {
    const cache = createCache();
    cache.set("res-1", { price: "0.5000000", creator: "GCREATOR", fetchedAt: 0 });
    const fetcher = vi.fn().mockRejectedValue(new Error("rpc down"));

    // TTL expired (t > ttl) but within ttl + grace.
    const t = TTL_MS + 60_000;
    const result = await getOnChainPrice("res-1", {
      cache,
      fetcher,
      now: fixedNow(t),
      ttlMs: TTL_MS,
      staleGraceMs: GRACE_MS,
    });

    expect(result.price).toBe("0.5000000");
    expect(result.creator).toBe("GCREATOR");
    expect(result.cached).toBe(true);
    expect(result.stale).toBe(true);
  });

  it("throws when the fetch fails and the cache entry is beyond the grace window", async () => {
    const cache = createCache();
    cache.set("res-1", { price: "0.5000000", creator: "GCREATOR", fetchedAt: 0 });
    const fetcher = vi.fn().mockRejectedValue(new Error("rpc down"));

    const t = TTL_MS + GRACE_MS + 1;
    await expect(
      getOnChainPrice("res-1", {
        cache,
        fetcher,
        now: fixedNow(t),
        ttlMs: TTL_MS,
        staleGraceMs: GRACE_MS,
      }),
    ).rejects.toBeInstanceOf(OnChainLookupError);
  });

  it("throws when the fetch fails and there is no cache entry at all", async () => {
    const cache = createCache();
    const fetcher = vi.fn().mockRejectedValue(new Error("rpc down"));

    await expect(
      getOnChainPrice("res-1", {
        cache,
        fetcher,
        now: fixedNow(1_000),
        ttlMs: TTL_MS,
        staleGraceMs: GRACE_MS,
      }),
    ).rejects.toBeInstanceOf(OnChainLookupError);
  });

  it("still serves a within-TTL cache entry without calling the fetcher", async () => {
    const cache = createCache();
    cache.set("res-1", { price: "0.5000000", creator: "GCREATOR", fetchedAt: 0 });
    const fetcher = vi.fn();

    const result = await getOnChainPrice("res-1", {
      cache,
      fetcher,
      now: fixedNow(TTL_MS - 1),
      ttlMs: TTL_MS,
      staleGraceMs: GRACE_MS,
    });

    expect(result.cached).toBe(true);
    expect(result.stale).toBeUndefined();
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("throws when a resource is not found on-chain (no fallback for null records)", async () => {
    const cache = createCache();
    const fetcher = vi.fn().mockResolvedValue(null);

    await expect(
      getOnChainPrice("res-1", { cache, fetcher, now: fixedNow(1_000) }),
    ).rejects.toBeInstanceOf(OnChainLookupError);
  });
});
