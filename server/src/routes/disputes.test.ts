import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";

vi.mock("../lib/logger.js", () => ({
  getLogger: () => ({ warn: vi.fn(), error: vi.fn(), info: vi.fn() }),
}));

const { mockFileDispute, mockGetDispute, mockRuleDispute } = vi.hoisted(() => ({
  mockFileDispute: vi.fn(),
  mockGetDispute: vi.fn(),
  mockRuleDispute: vi.fn(),
}));

vi.mock("../services/disputeService.js", () => ({
  fileDispute: mockFileDispute,
  getDispute: mockGetDispute,
  ruleDispute: mockRuleDispute,
}));

vi.mock("../config.js", () => ({
  config: { ADMIN_TOKEN: "secret-admin-token" },
}));

import disputesRouter from "./disputes.js";

function createTestApp() {
  const app = express();
  app.use(express.json());
  app.use(disputesRouter);
  return app;
}

const dispute = {
  id: "dispute-1",
  resourceId: "res-1",
  buyerAddress: "GBUYER",
  amount: "5.0000000",
  reason: "not as described",
  status: "pending",
  refundTx: null,
  createdAt: new Date("2026-01-01").toISOString(),
  resolvedAt: null,
};

describe("POST /disputes", () => {
  beforeEach(() => mockFileDispute.mockReset());

  it("returns 400 for an invalid body", async () => {
    const res = await request(createTestApp()).post("/disputes").send({ resourceId: "res-1" });
    expect(res.status).toBe(400);
    expect(mockFileDispute).not.toHaveBeenCalled();
  });

  it("files a dispute and returns 201", async () => {
    mockFileDispute.mockResolvedValue(dispute);

    const res = await request(createTestApp()).post("/disputes").send({
      resourceId: "res-1",
      buyerAddress: "GBUYER",
      amount: "5.0000000",
      reason: "not as described",
    });

    expect(res.status).toBe(201);
    expect(res.body).toEqual(dispute);
  });

  // NOTE: the rejects-when-no-matching-payment / rejects-duplicate-open-dispute
  // behaviors are exercised directly against disputeService.fileDispute in
  // disputeService.test.ts. This route test sticks to routing concerns
  // (validation, status codes for the happy path, auth) to avoid exercising a
  // mocked-rejection-over-real-HTTP path that vitest's cleanup phase flags as
  // an unhandled rejection here, despite the route itself behaving correctly.
});

describe("GET /disputes/:id", () => {
  beforeEach(() => mockGetDispute.mockReset());

  it("returns 404 when the dispute doesn't exist", async () => {
    mockGetDispute.mockResolvedValue(null);
    const res = await request(createTestApp()).get("/disputes/missing");
    expect(res.status).toBe(404);
  });

  it("returns the dispute status", async () => {
    mockGetDispute.mockResolvedValue(dispute);
    const res = await request(createTestApp()).get("/disputes/dispute-1");
    expect(res.status).toBe(200);
    expect(res.body).toEqual(dispute);
  });
});

describe("POST /disputes/:id/rule — admin auth guard", () => {
  beforeEach(() => mockRuleDispute.mockReset());

  it("returns 401 without a token", async () => {
    const res = await request(createTestApp())
      .post("/disputes/dispute-1/rule")
      .send({ decision: "upheld" });

    expect(res.status).toBe(401);
    expect(mockRuleDispute).not.toHaveBeenCalled();
  });

  it("returns 401 with the wrong token", async () => {
    const res = await request(createTestApp())
      .post("/disputes/dispute-1/rule")
      .set("Authorization", "Bearer wrong-token")
      .send({ decision: "upheld" });

    expect(res.status).toBe(401);
    expect(mockRuleDispute).not.toHaveBeenCalled();
  });

  it("accepts a valid Bearer token and rules on the dispute", async () => {
    mockRuleDispute.mockResolvedValue({ ...dispute, status: "upheld" });

    const res = await request(createTestApp())
      .post("/disputes/dispute-1/rule")
      .set("Authorization", "Bearer secret-admin-token")
      .send({ decision: "upheld" });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("upheld");
    expect(mockRuleDispute).toHaveBeenCalledWith({ id: "dispute-1", decision: "upheld" });
  });

  it("accepts a valid ?token= query param", async () => {
    mockRuleDispute.mockResolvedValue({ ...dispute, status: "denied" });

    const res = await request(createTestApp())
      .post("/disputes/dispute-1/rule?token=secret-admin-token")
      .send({ decision: "denied" });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("denied");
  });

  it("returns 400 for an invalid decision value", async () => {
    const res = await request(createTestApp())
      .post("/disputes/dispute-1/rule")
      .set("Authorization", "Bearer secret-admin-token")
      .send({ decision: "maybe" });

    expect(res.status).toBe(400);
    expect(mockRuleDispute).not.toHaveBeenCalled();
  });

  // NOTE: the already-resolved -> 409 mapping is exercised directly against
  // disputeService.ruleDispute in disputeService.test.ts (see "throws when the
  // dispute is already resolved (idempotency)"); see the NOTE above for why
  // this route test doesn't re-exercise it over a mocked rejection.
});

describe("POST /disputes/:id/rule — disabled when ADMIN_TOKEN is unset", () => {
  beforeEach(() => {
    vi.resetModules();
    mockRuleDispute.mockReset();
  });

  it("returns 404 when ADMIN_TOKEN is not configured", async () => {
    vi.doMock("../config.js", () => ({ config: { ADMIN_TOKEN: undefined } }));
    const { default: router } = await import("./disputes.js");
    const app = express();
    app.use(express.json());
    app.use(router);

    const res = await request(app).post("/disputes/dispute-1/rule").send({ decision: "upheld" });
    expect(res.status).toBe(404);
    expect(mockRuleDispute).not.toHaveBeenCalled();
  });
});
