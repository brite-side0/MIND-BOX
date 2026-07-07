import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockSubmitUsdcTransfer } = vi.hoisted(() => ({
  mockSubmitUsdcTransfer: vi.fn(),
}));

vi.mock("./registryClient.js", () => ({
  submitUsdcTransfer: mockSubmitUsdcTransfer,
}));

vi.mock("../lib/logger.js", () => ({
  getLogger: () => ({ warn: vi.fn(), error: vi.fn(), info: vi.fn() }),
}));

describe("executeRefund — refund disabled (no wallet configured)", () => {
  beforeEach(() => {
    vi.resetModules();
    mockSubmitUsdcTransfer.mockReset();
  });

  it("skips the transfer and reports refund_disabled when REFUND_WALLET_SECRET is unset", async () => {
    vi.doMock("../config.js", () => ({
      config: { REFUND_WALLET_SECRET: undefined, REFUND_MAX_AMOUNT: undefined },
    }));
    const { executeRefund } = await import("./refundService.js");

    const result = await executeRefund({ buyerAddress: "GBUYER", amount: "5.0000000" });

    expect(result).toEqual({ executed: false, reason: "refund_disabled", amount: "5.0000000" });
    expect(mockSubmitUsdcTransfer).not.toHaveBeenCalled();
  });
});

describe("executeRefund — wallet configured", () => {
  beforeEach(() => {
    vi.resetModules();
    mockSubmitUsdcTransfer.mockReset();
  });

  it("executes a transfer and returns the tx hash on success", async () => {
    vi.doMock("../config.js", () => ({
      config: { REFUND_WALLET_SECRET: "SSECRET", REFUND_MAX_AMOUNT: undefined },
    }));
    mockSubmitUsdcTransfer.mockResolvedValue({ txHash: "abc123", success: true });
    const { executeRefund } = await import("./refundService.js");

    const result = await executeRefund({ buyerAddress: "GBUYER", amount: "5.0000000" });

    expect(result).toEqual({ executed: true, txHash: "abc123", amount: "5.0000000" });
    expect(mockSubmitUsdcTransfer).toHaveBeenCalledWith({
      fromSecret: "SSECRET",
      toAddress: "GBUYER",
      amountStroops: 50_000_000n,
    });
  });

  it("caps the refund amount to REFUND_MAX_AMOUNT before transferring", async () => {
    vi.doMock("../config.js", () => ({
      config: { REFUND_WALLET_SECRET: "SSECRET", REFUND_MAX_AMOUNT: "2" },
    }));
    mockSubmitUsdcTransfer.mockResolvedValue({ txHash: "capped-tx", success: true });
    const { executeRefund } = await import("./refundService.js");

    const result = await executeRefund({ buyerAddress: "GBUYER", amount: "5.0000000" });

    expect(result.amount).toBe("2");
    expect(mockSubmitUsdcTransfer).toHaveBeenCalledWith({
      fromSecret: "SSECRET",
      toAddress: "GBUYER",
      amountStroops: 20_000_000n,
    });
  });

  it("reports failure without throwing when the transfer fails", async () => {
    vi.doMock("../config.js", () => ({
      config: { REFUND_WALLET_SECRET: "SSECRET", REFUND_MAX_AMOUNT: undefined },
    }));
    mockSubmitUsdcTransfer.mockResolvedValue({ txHash: "", success: false, error: "rpc down" });
    const { executeRefund } = await import("./refundService.js");

    const result = await executeRefund({ buyerAddress: "GBUYER", amount: "5.0000000" });

    expect(result.executed).toBe(false);
    expect(result.reason).toBe("rpc down");
  });
});
