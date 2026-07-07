import { describe, it, expect, beforeEach, vi } from "vitest";
import express from "express";
import request from "supertest";
import { createHash } from "node:crypto";

// Offline route tests for the lease API (ADR: Time-Limited Access Leases).
// x402 payment settlement is mocked to a passthrough (mirrors dynamicPaywall's
// test), so these assert route wiring: pricing/paywall delegation, one-time
// token return, payments-row parity, and creator-authenticated revocation.

const { PUBLISHERS, RESOURCES, PAYMENTS } = vi.hoisted(() => ({
  PUBLISHERS: { __table: "publishers" },
  RESOURCES: { __table: "resources" },
  PAYMENTS: { __table: "payments" },
}));

vi.mock("../db/schema.js", () => ({
  publishers: PUBLISHERS,
  resources: RESOURCES,
  payments: PAYMENTS,
}));

const VALID_API_KEY = "mv_owner-key";
const VALID_API_KEY_HASH = createHash("sha256").update(VALID_API_KEY).digest("hex");

const ownerPublisher = {
  id: "pub-1",
  name: "Alice",
  email: "alice@example.com",
  walletAddress: "GCREATOR",
  apiKeyHash: VALID_API_KEY_HASH,
  createdAt: new Date("2026-01-01"),
};

let publishersRows: any[] = [];
let resourcesRows: any[] = [];
let paymentsReturning: any[] = [];
let capturedPaymentValues: any = undefined;

vi.mock("../db/client.js", () => ({
  db: {
    select: () => ({
      from: (table: unknown) => ({
        where: () =>
          Promise.resolve(
            table === PUBLISHERS ? publishersRows : table === RESOURCES ? resourcesRows : [],
          ),
      }),
    }),
    insert: (_table: unknown) => ({
      values: (v: any) => {
        capturedPaymentValues = v;
        return { returning: () => Promise.resolve(paymentsReturning) };
      },
    }),
  },
}));

// x402 settlement: passthrough (payment already "settled").
vi.mock("@x402/express", () => ({
  paymentMiddleware: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));
vi.mock("../lib/x402.js", () => ({ network: "stellar:testnet", sharedX402ResourceServer: {} }));
vi.mock("../lib/logger.js", () => ({
  getLogger: () => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn() }),
}));

const { mockCreateLease, mockGetLeasesForHolder, mockRevokeLease } = vi.hoisted(() => ({
  mockCreateLease: vi.fn(),
  mockGetLeasesForHolder: vi.fn(),
  mockRevokeLease: vi.fn(),
}));

vi.mock("../services/leaseService.js", () => ({
  createLease: mockCreateLease,
  getLeasesForHolder: mockGetLeasesForHolder,
  revokeLease: mockRevokeLease,
  // Pure pricing helper used by the route's paywall; deterministic stub.
  computeLeasePrice: () => "5.0000000",
}));

import leaseRouter from "./leases.js";

function createTestApp() {
  const app = express();
  app.use(express.json());
  app.use(leaseRouter);
  return app;
}

describe("POST /resources/:id/leases — purchase", () => {
  beforeEach(() => {
    resourcesRows = [
      { id: "r1", listed: true, price: "0.50", walletAddress: "GCREATOR", title: "Doc" },
    ];
    paymentsReturning = [
      {
        id: "pay-1",
        recipientAddress: "GCREATOR",
        amount: "5.0000000",
        paidAt: new Date("2026-07-07"),
      },
    ];
    capturedPaymentValues = undefined;
    mockCreateLease.mockReset();
    mockCreateLease.mockResolvedValue({
      lease: {
        id: "lease-1",
        resourceId: "r1",
        holderAddress: "GBUYER",
        amount: "5.0000000",
        createdAt: new Date("2026-07-07"),
        expiresAt: new Date("2026-07-08"),
      },
      token: "lease_plaintexttoken",
    });
  });

  it("creates a lease, writes a payments row, and returns the token once", async () => {
    const res = await request(createTestApp())
      .post("/resources/r1/leases")
      .send({ durationTier: "24h", holderAddress: "GBUYER" });

    expect(res.status).toBe(201);
    expect(res.body.token).toBe("lease_plaintexttoken");
    expect(res.body.lease).toMatchObject({
      id: "lease-1",
      durationTier: "24h",
      amount: "5.0000000",
    });
    expect(mockCreateLease).toHaveBeenCalledWith({
      resourceId: "r1",
      holderAddress: "GBUYER",
      durationTier: "24h",
    });
    // Observability parity: a payments row is written for the lease purchase.
    expect(capturedPaymentValues).toMatchObject({
      resourceId: "r1",
      payerAddress: "GBUYER",
      recipientAddress: "GCREATOR",
      amount: "5.0000000",
    });
    expect(res.body.receipt.paymentId).toBe("pay-1");
  });

  it("returns 400 for an invalid duration tier", async () => {
    const res = await request(createTestApp())
      .post("/resources/r1/leases")
      .send({ durationTier: "99y", holderAddress: "GBUYER" });

    expect(res.status).toBe(400);
    expect(mockCreateLease).not.toHaveBeenCalled();
  });

  it("returns 404 when the resource is not listed", async () => {
    resourcesRows = [
      { id: "r1", listed: false, price: "0.50", walletAddress: "GCREATOR", title: "Doc" },
    ];

    const res = await request(createTestApp())
      .post("/resources/r1/leases")
      .send({ durationTier: "24h", holderAddress: "GBUYER" });

    expect(res.status).toBe(404);
    expect(mockCreateLease).not.toHaveBeenCalled();
  });

  it("returns 400 when no holder address can be determined", async () => {
    const res = await request(createTestApp())
      .post("/resources/r1/leases")
      .send({ durationTier: "24h" });

    expect(res.status).toBe(400);
    expect(mockCreateLease).not.toHaveBeenCalled();
  });
});

describe("GET /resources/:id/leases/me — list holder leases", () => {
  beforeEach(() => {
    mockGetLeasesForHolder.mockReset();
  });

  it("returns 400 without a holder query parameter", async () => {
    const res = await request(createTestApp()).get("/resources/r1/leases/me");
    expect(res.status).toBe(400);
    expect(mockGetLeasesForHolder).not.toHaveBeenCalled();
  });

  it("returns the holder's leases without exposing token hashes", async () => {
    mockGetLeasesForHolder.mockResolvedValue([
      {
        id: "lease-1",
        resourceId: "r1",
        holderAddress: "GBUYER",
        tokenHash: "secret-hash",
        amount: "5.0000000",
        createdAt: new Date("2026-07-07"),
        expiresAt: new Date("2026-07-08"),
        revokedAt: null,
      },
    ]);

    const res = await request(createTestApp()).get("/resources/r1/leases/me?holder=GBUYER");

    expect(res.status).toBe(200);
    expect(mockGetLeasesForHolder).toHaveBeenCalledWith("r1", "GBUYER");
    expect(res.body).toHaveLength(1);
    expect(res.body[0]).toMatchObject({ id: "lease-1", holderAddress: "GBUYER" });
    expect(res.body[0].tokenHash).toBeUndefined();
  });
});

describe("POST /resources/:id/leases/:holder/revoke — creator revocation", () => {
  beforeEach(() => {
    publishersRows = [ownerPublisher];
    resourcesRows = [{ id: "r1", publisherId: "pub-1", walletAddress: "GCREATOR" }];
    mockRevokeLease.mockReset();
    mockRevokeLease.mockResolvedValue([{ id: "lease-1" }]);
  });

  it("returns 401 without an API key", async () => {
    const res = await request(createTestApp()).post("/resources/r1/leases/GBUYER/revoke");
    expect(res.status).toBe(401);
    expect(mockRevokeLease).not.toHaveBeenCalled();
  });

  it("returns 403 when the caller does not own the resource", async () => {
    resourcesRows = [{ id: "r1", publisherId: "someone-else", walletAddress: "GCREATOR" }];

    const res = await request(createTestApp())
      .post("/resources/r1/leases/GBUYER/revoke")
      .set("x-api-key", VALID_API_KEY);

    expect(res.status).toBe(403);
    expect(mockRevokeLease).not.toHaveBeenCalled();
  });

  it("revokes the holder's leases for the owning creator", async () => {
    const res = await request(createTestApp())
      .post("/resources/r1/leases/GBUYER/revoke")
      .set("x-api-key", VALID_API_KEY);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ resourceId: "r1", holderAddress: "GBUYER", revokedCount: 1 });
    expect(mockRevokeLease).toHaveBeenCalledWith({ resourceId: "r1", holderAddress: "GBUYER" });
  });
});
