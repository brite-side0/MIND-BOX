import { beforeEach, describe, expect, it, vi } from "vitest";

// Lease short-circuit branch of dynamicPaywall (ADR: Time-Limited Access Leases).
// A valid `Authorization: Lease <token>` must deliver WITHOUT a 402 and without
// even hitting the on-chain price path; any invalid/expired/revoked/absent token
// must fall through to the unchanged per-request 402 flow.

const mockPaymentMiddleware = vi.fn(
  () => (_req: unknown, _res: unknown, next: () => void) => next(),
);
const mockGetOnChainPrice = vi.fn();
const mockNormalizeUsdcPrice = vi.fn((value: string) => value);
const mockFindActiveLeaseByToken = vi.fn();

class MockOnChainLookupError extends Error {
  readonly cause?: unknown;
  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = "OnChainLookupError";
    this.cause = cause;
  }
}

vi.mock("@x402/express", () => ({ paymentMiddleware: mockPaymentMiddleware }));
vi.mock("../lib/x402.js", () => ({ network: "stellar:testnet", sharedX402ResourceServer: {} }));
vi.mock("../lib/logger.js", () => ({
  getLogger: () => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn() }),
}));
vi.mock("../services/registryClient.js", () => ({ getResource: vi.fn() }));
vi.mock("../lib/stellarRegistry.js", () => ({
  getOnChainPrice: mockGetOnChainPrice,
  normalizeUsdcPrice: mockNormalizeUsdcPrice,
  OnChainLookupError: MockOnChainLookupError,
}));
vi.mock("../services/leaseService.js", () => ({
  findActiveLeaseByToken: mockFindActiveLeaseByToken,
}));
vi.mock("../db/client.js", () => ({ db: { select: vi.fn() } }));

function makeDbSelect(resource: unknown) {
  const where = vi.fn(() => Promise.resolve(resource ? [resource] : []));
  const from = vi.fn(() => ({ where }));
  return { select: vi.fn(() => ({ from })) };
}

function listedResource(overrides: Record<string, unknown> = {}) {
  return {
    id: "r1",
    listed: true,
    price: "1.00",
    walletAddress: "GABC",
    title: "Test resource",
    onchainStatus: "none",
    ...overrides,
  };
}

function createResponse() {
  return { status: vi.fn().mockReturnThis(), json: vi.fn().mockReturnThis() } as any;
}

function createRequest(resourceId: string, headers: Record<string, unknown> = {}) {
  return { params: { id: resourceId }, headers } as any;
}

describe("dynamicPaywall lease short-circuit", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockPaymentMiddleware.mockReset();
    mockGetOnChainPrice.mockReset();
    mockNormalizeUsdcPrice.mockReset();
    mockFindActiveLeaseByToken.mockReset();
  });

  it("delivers without a 402 when a valid lease token is presented", async () => {
    const resource = listedResource({ id: "r1" });
    const { db } = await import("../db/client.js");
    (db as any).select = makeDbSelect(resource).select;
    const { dynamicPaywall } = await import("./dynamicPaywall.js");

    mockFindActiveLeaseByToken.mockResolvedValue({ id: "lease-1", resourceId: "r1" });

    const req = createRequest("r1", { authorization: "Lease lease_validtoken" });
    const res = createResponse();
    const next = vi.fn();

    await dynamicPaywall(req, res, next);

    expect(mockFindActiveLeaseByToken).toHaveBeenCalledWith("r1", "lease_validtoken");
    expect(next).toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalled();
    // The paid path is skipped entirely — no on-chain price lookup, no 402.
    expect(mockGetOnChainPrice).not.toHaveBeenCalled();
    expect(mockPaymentMiddleware).not.toHaveBeenCalled();
    // Resource + lease are attached for the delivery handler.
    expect((req as any).resource).toEqual(resource);
    expect((req as any).lease).toEqual({ id: "lease-1", resourceId: "r1" });
  });

  it("falls through to the per-request 402 flow when the lease token is invalid/expired", async () => {
    // Distinct id/price so the per-resource paymentMiddleware cache doesn't
    // collide with the no-header test below.
    const resource = listedResource({ id: "r2", price: "0.50" });
    const { db } = await import("../db/client.js");
    (db as any).select = makeDbSelect(resource).select;
    const { dynamicPaywall } = await import("./dynamicPaywall.js");

    mockFindActiveLeaseByToken.mockResolvedValue(null);
    mockGetOnChainPrice.mockResolvedValue({ price: "0.5000000", creator: "GABC" });
    mockNormalizeUsdcPrice.mockReturnValue("0.5000000");
    mockPaymentMiddleware.mockReturnValue((_req: any, _res: any, next: any) => next());

    const req = createRequest("r2", { authorization: "Lease lease_expired" });
    const res = createResponse();
    const next = vi.fn();

    await dynamicPaywall(req, res, next);

    // Lease was checked, missed, and the normal paid path ran.
    expect(mockFindActiveLeaseByToken).toHaveBeenCalled();
    expect(mockGetOnChainPrice).toHaveBeenCalled();
    expect(mockPaymentMiddleware).toHaveBeenCalled();
    expect(next).toHaveBeenCalled();
  });

  it("does not check leases and runs the paid flow when no Authorization header is present", async () => {
    const resource = listedResource({ id: "r3", price: "0.75" });
    const { db } = await import("../db/client.js");
    (db as any).select = makeDbSelect(resource).select;
    const { dynamicPaywall } = await import("./dynamicPaywall.js");

    mockGetOnChainPrice.mockResolvedValue({ price: "0.7500000", creator: "GABC" });
    mockNormalizeUsdcPrice.mockReturnValue("0.7500000");
    mockPaymentMiddleware.mockReturnValue((_req: any, _res: any, next: any) => next());

    const req = createRequest("r3", {});
    const res = createResponse();
    const next = vi.fn();

    await dynamicPaywall(req, res, next);

    expect(mockFindActiveLeaseByToken).not.toHaveBeenCalled();
    expect(mockPaymentMiddleware).toHaveBeenCalled();
    expect(next).toHaveBeenCalled();
  });
});
