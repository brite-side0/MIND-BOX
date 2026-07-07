import { describe, it, expect, beforeEach, vi } from "vitest";
import { hashLeaseToken } from "../utils/crypto.js";

// Offline unit tests for the lease service (ADR: Time-Limited Access Leases).
// The db client is fully mocked — no real Postgres. Markers distinguish which
// table a query targets so we can drive the resources vs. leases branches.
const { RES, LEA } = vi.hoisted(() => ({
  RES: { __table: "resources" },
  LEA: { __table: "leases" },
}));

vi.mock("../db/schema.js", () => ({ resources: RES, leases: LEA }));

let resourceRows: any[] = [];
let leaseSelectRows: any[] = [];
let insertReturning: any[] = [];
let updateReturning: any[] = [];
let capturedInsertValues: any = undefined;
let capturedUpdateSet: any = undefined;

vi.mock("../db/client.js", () => ({
  db: {
    select: () => ({
      from: (table: unknown) => ({
        where: () => Promise.resolve(table === RES ? resourceRows : leaseSelectRows),
      }),
    }),
    insert: () => ({
      values: (v: any) => {
        capturedInsertValues = v;
        return { returning: () => Promise.resolve(insertReturning) };
      },
    }),
    update: () => ({
      set: (s: any) => {
        capturedUpdateSet = s;
        return { where: () => ({ returning: () => Promise.resolve(updateReturning) }) };
      },
    }),
  },
}));

import {
  tierToSeconds,
  tierMultiplier,
  computeLeasePrice,
  isActive,
  createLease,
  findActiveLeaseByToken,
  revokeLease,
  DEFAULT_TIER_MULTIPLIERS,
} from "./leaseService.js";

describe("leaseService pure helpers", () => {
  describe("tierToSeconds", () => {
    it("maps each tier to its window length in seconds", () => {
      expect(tierToSeconds("1h")).toBe(3_600);
      expect(tierToSeconds("24h")).toBe(86_400);
      expect(tierToSeconds("7d")).toBe(604_800);
    });
  });

  describe("tierMultiplier", () => {
    it("returns the default platform multiplier for a tier", () => {
      expect(tierMultiplier("1h")).toBe(DEFAULT_TIER_MULTIPLIERS["1h"]);
      expect(tierMultiplier("24h")).toBe(10);
      expect(tierMultiplier("7d")).toBe(40);
    });

    it("honors a creator-supplied override policy", () => {
      const policy = { "1h": 2, "24h": 5, "7d": 20 } as const;
      expect(tierMultiplier("24h", policy)).toBe(5);
    });
  });

  describe("computeLeasePrice", () => {
    it("computes base × multiplier as a fixed 7-decimal USDC string", () => {
      // 0.50 × 10 (24h) = 5.0
      expect(computeLeasePrice("0.50", "24h")).toBe("5.0000000");
      // 1.00 × 3 (1h) = 3.0
      expect(computeLeasePrice("1.00", "1h")).toBe("3.0000000");
      // 0.10 × 40 (7d) = 4.0
      expect(computeLeasePrice("0.10", "7d")).toBe("4.0000000");
    });

    it("uses the override policy when provided", () => {
      const policy = { "1h": 2, "24h": 5, "7d": 20 } as const;
      expect(computeLeasePrice("1.00", "1h", policy)).toBe("2.0000000");
    });
  });

  describe("isActive", () => {
    const now = new Date("2026-07-07T12:00:00.000Z");

    it("returns true for an unexpired, non-revoked lease", () => {
      const lease = { expiresAt: new Date("2026-07-07T13:00:00.000Z"), revokedAt: null };
      expect(isActive(lease, now)).toBe(true);
    });

    it("returns false once the lease has expired (now > expiresAt)", () => {
      const lease = { expiresAt: new Date("2026-07-07T11:00:00.000Z"), revokedAt: null };
      expect(isActive(lease, now)).toBe(false);
    });

    it("returns false for a revoked lease even before expiry", () => {
      const lease = {
        expiresAt: new Date("2026-07-07T13:00:00.000Z"),
        revokedAt: new Date("2026-07-07T11:30:00.000Z"),
      };
      expect(isActive(lease, now)).toBe(false);
    });
  });
});

describe("leaseService.createLease", () => {
  beforeEach(() => {
    resourceRows = [{ id: "r1", price: "0.50", walletAddress: "GCREATOR" }];
    insertReturning = [{ id: "lease-1", resourceId: "r1", holderAddress: "GBUYER" }];
    capturedInsertValues = undefined;
  });

  it("mints an opaque token, stores only its hash, and computes amount + expiry", async () => {
    const before = Date.now();
    const { lease, token } = await createLease({
      resourceId: "r1",
      holderAddress: "GBUYER",
      durationTier: "24h",
    });

    // Plaintext token is returned once and looks like the opaque lease format.
    expect(token).toMatch(/^lease_[0-9a-f]{64}$/);
    expect(lease).toEqual({ id: "lease-1", resourceId: "r1", holderAddress: "GBUYER" });

    // Only the sha256 hash of the token is persisted — never the plaintext.
    expect(capturedInsertValues.tokenHash).toBe(hashLeaseToken(token));
    expect(capturedInsertValues.tokenHash).not.toBe(token);

    // amount = base (0.50) × 24h multiplier (10) = 5.0
    expect(capturedInsertValues.amount).toBe("5.0000000");

    // expiresAt ≈ now + 24h.
    const expiresMs = new Date(capturedInsertValues.expiresAt).getTime();
    expect(expiresMs).toBeGreaterThanOrEqual(before + 86_400_000);
    expect(expiresMs).toBeLessThanOrEqual(Date.now() + 86_400_000);
  });

  it("throws when the resource does not exist", async () => {
    resourceRows = [];
    await expect(
      createLease({ resourceId: "missing", holderAddress: "GBUYER", durationTier: "1h" }),
    ).rejects.toThrow("not found");
  });
});

describe("leaseService.findActiveLeaseByToken", () => {
  const now = new Date("2026-07-07T12:00:00.000Z");

  beforeEach(() => {
    leaseSelectRows = [];
  });

  it("returns the lease for a valid, active token", async () => {
    const lease = {
      id: "lease-1",
      resourceId: "r1",
      tokenHash: hashLeaseToken("lease_abc"),
      expiresAt: new Date("2026-07-07T13:00:00.000Z"),
      revokedAt: null,
    };
    leaseSelectRows = [lease];

    const result = await findActiveLeaseByToken("r1", "lease_abc", now);
    expect(result).toEqual(lease);
  });

  it("returns null for an unknown / wrong token (no matching hash)", async () => {
    leaseSelectRows = [];
    const result = await findActiveLeaseByToken("r1", "lease_wrong", now);
    expect(result).toBeNull();
  });

  it("returns null for an expired lease", async () => {
    leaseSelectRows = [
      {
        id: "l",
        resourceId: "r1",
        expiresAt: new Date("2026-07-07T11:00:00.000Z"),
        revokedAt: null,
      },
    ];
    const result = await findActiveLeaseByToken("r1", "lease_abc", now);
    expect(result).toBeNull();
  });

  it("returns null for a revoked lease", async () => {
    leaseSelectRows = [
      {
        id: "l",
        resourceId: "r1",
        expiresAt: new Date("2026-07-07T13:00:00.000Z"),
        revokedAt: new Date("2026-07-07T11:30:00.000Z"),
      },
    ];
    const result = await findActiveLeaseByToken("r1", "lease_abc", now);
    expect(result).toBeNull();
  });
});

describe("leaseService.revokeLease", () => {
  beforeEach(() => {
    updateReturning = [{ id: "lease-1", revokedAt: new Date() }];
    capturedUpdateSet = undefined;
  });

  it("stamps revoked_at and returns the affected rows", async () => {
    const now = new Date("2026-07-07T12:00:00.000Z");
    const rows = await revokeLease({ resourceId: "r1", holderAddress: "GBUYER", now });

    expect(capturedUpdateSet.revokedAt).toBe(now);
    expect(rows).toHaveLength(1);
  });
});
