import { describe, it, expect, vi, beforeEach } from "vitest";

const { PAYMENTS, DISPUTES, RESOURCES } = vi.hoisted(() => ({
  PAYMENTS: { __table: "payments" },
  DISPUTES: { __table: "disputes" },
  RESOURCES: { __table: "resources" },
}));

vi.mock("../db/schema.js", () => ({
  payments: PAYMENTS,
  disputes: DISPUTES,
  resources: RESOURCES,
}));

let paymentsRows: any[] = [];
let disputesRows: any[] = [];
let insertReturning: any[] = [];
let updateReturning: any[] = [];
let capturedInsertValues: any = undefined;
let capturedUpdateValues: any = undefined;

vi.mock("../db/client.js", () => ({
  db: {
    select: () => ({
      from: (table: unknown) => ({
        where: () =>
          Promise.resolve(
            table === PAYMENTS ? paymentsRows : table === DISPUTES ? disputesRows : [],
          ),
      }),
    }),
    insert: (_table: unknown) => ({
      values: (v: any) => {
        capturedInsertValues = v;
        return { returning: () => Promise.resolve(insertReturning) };
      },
    }),
    update: (_table: unknown) => ({
      set: (v: any) => {
        capturedUpdateValues = v;
        return { where: () => ({ returning: () => Promise.resolve(updateReturning) }) };
      },
    }),
  },
}));

vi.mock("../lib/logger.js", () => ({
  getLogger: () => ({ warn: vi.fn(), error: vi.fn(), info: vi.fn() }),
}));

const { mockExecuteRefund } = vi.hoisted(() => ({ mockExecuteRefund: vi.fn() }));
vi.mock("./refundService.js", () => ({ executeRefund: mockExecuteRefund }));

vi.mock("../config.js", () => ({
  config: { OPENROUTER_API_KEY: undefined, OPENROUTER_MODEL: "test-model" },
}));

const { fileDispute, getDispute, ruleDispute, reviewDisputeWithAI } =
  await import("./disputeService.js");

const settledPayment = {
  id: "pay-1",
  resourceId: "res-1",
  payerAddress: "GBUYER",
  recipientAddress: "GCREATOR",
  amount: "5.0000000",
  paidAt: new Date("2026-01-01"),
};

const pendingDispute = {
  id: "dispute-1",
  resourceId: "res-1",
  buyerAddress: "GBUYER",
  amount: "5.0000000",
  reason: "not as described",
  status: "pending",
  refundTx: null,
  createdAt: new Date("2026-01-02"),
  resolvedAt: null,
};

describe("fileDispute", () => {
  beforeEach(() => {
    paymentsRows = [];
    disputesRows = [];
    insertReturning = [];
    capturedInsertValues = undefined;
  });

  it("rejects when no matching settled payment exists", async () => {
    paymentsRows = [];

    await expect(
      fileDispute({ resourceId: "res-1", buyerAddress: "GBUYER", amount: "5", reason: "bad" }),
    ).rejects.toThrow(/no matching settled payment/i);
  });

  it("rejects when an open dispute already exists for the same resource/buyer", async () => {
    paymentsRows = [settledPayment];
    disputesRows = [pendingDispute];

    await expect(
      fileDispute({ resourceId: "res-1", buyerAddress: "GBUYER", amount: "5", reason: "bad" }),
    ).rejects.toThrow(/open dispute already exists/i);
  });

  it("creates a pending dispute when a payment exists and no open dispute is present", async () => {
    paymentsRows = [settledPayment];
    disputesRows = [{ ...pendingDispute, status: "denied" }]; // resolved, not open
    insertReturning = [pendingDispute];

    const result = await fileDispute({
      resourceId: "res-1",
      buyerAddress: "GBUYER",
      amount: "5.0000000",
      reason: "not as described",
    });

    expect(result).toEqual(pendingDispute);
    expect(capturedInsertValues).toMatchObject({
      resourceId: "res-1",
      buyerAddress: "GBUYER",
      amount: "5.0000000",
      reason: "not as described",
      status: "pending",
    });
  });
});

describe("getDispute", () => {
  beforeEach(() => {
    disputesRows = [];
  });

  it("returns null when the dispute doesn't exist", async () => {
    disputesRows = [];
    expect(await getDispute("missing")).toBeNull();
  });

  it("returns the dispute when it exists", async () => {
    disputesRows = [pendingDispute];
    expect(await getDispute("dispute-1")).toEqual(pendingDispute);
  });
});

describe("ruleDispute", () => {
  beforeEach(() => {
    disputesRows = [];
    updateReturning = [];
    capturedUpdateValues = undefined;
    mockExecuteRefund.mockReset();
  });

  it("throws when the dispute doesn't exist", async () => {
    disputesRows = [];
    await expect(ruleDispute({ id: "missing", decision: "upheld" })).rejects.toThrow(/not found/i);
  });

  it("throws when the dispute is already resolved (idempotency)", async () => {
    disputesRows = [{ ...pendingDispute, status: "upheld", resolvedAt: new Date() }];
    await expect(ruleDispute({ id: "dispute-1", decision: "denied" })).rejects.toThrow(
      /already resolved/i,
    );
    expect(mockExecuteRefund).not.toHaveBeenCalled();
  });

  it("on 'denied' sets status without calling refundService", async () => {
    disputesRows = [pendingDispute];
    updateReturning = [{ ...pendingDispute, status: "denied", resolvedAt: new Date() }];

    const result = await ruleDispute({ id: "dispute-1", decision: "denied" });

    expect(result.status).toBe("denied");
    expect(mockExecuteRefund).not.toHaveBeenCalled();
    expect(capturedUpdateValues).toMatchObject({ status: "denied" });
  });

  it("on 'upheld' calls refundService and sets refund_tx when the transfer executes", async () => {
    disputesRows = [pendingDispute];
    mockExecuteRefund.mockResolvedValue({ executed: true, txHash: "tx-abc", amount: "5.0000000" });
    updateReturning = [
      { ...pendingDispute, status: "upheld", refundTx: "tx-abc", resolvedAt: new Date() },
    ];

    const result = await ruleDispute({ id: "dispute-1", decision: "upheld" });

    expect(mockExecuteRefund).toHaveBeenCalledWith({
      buyerAddress: "GBUYER",
      amount: "5.0000000",
    });
    expect(result.status).toBe("upheld");
    expect(result.refundTx).toBe("tx-abc");
    expect(capturedUpdateValues).toMatchObject({ status: "upheld", refundTx: "tx-abc" });
  });

  it("on 'upheld' still records the ruling with refund_tx=null when refund execution is disabled", async () => {
    disputesRows = [pendingDispute];
    mockExecuteRefund.mockResolvedValue({
      executed: false,
      reason: "refund_disabled",
      amount: "5.0000000",
    });
    updateReturning = [
      { ...pendingDispute, status: "upheld", refundTx: null, resolvedAt: new Date() },
    ];

    const result = await ruleDispute({ id: "dispute-1", decision: "upheld" });

    expect(result.status).toBe("upheld");
    expect(result.refundTx).toBeNull();
    expect(capturedUpdateValues).toMatchObject({ status: "upheld", refundTx: null });
  });
});

describe("reviewDisputeWithAI", () => {
  it("returns an 'unavailable' result without throwing when OPENROUTER_API_KEY is unset", async () => {
    const result = await reviewDisputeWithAI(
      { reason: "broken link", amount: "5.0000000" },
      { title: "Some Resource", description: "a dataset" },
    );

    expect(result.available).toBe(false);
    expect(result.recommendation).toMatch(/unavailable/i);
  });
});
