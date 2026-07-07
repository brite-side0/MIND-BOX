import { describe, it, expect } from "vitest";
import { isValidStatusTransition, hasOpenDispute, capRefundAmount } from "./disputeHelpers.js";

describe("isValidStatusTransition", () => {
  it("allows pending -> upheld", () => {
    expect(isValidStatusTransition("pending", "upheld")).toBe(true);
  });

  it("allows pending -> denied", () => {
    expect(isValidStatusTransition("pending", "denied")).toBe(true);
  });

  it("rejects re-ruling an already-upheld dispute", () => {
    expect(isValidStatusTransition("upheld", "denied")).toBe(false);
    expect(isValidStatusTransition("upheld", "upheld")).toBe(false);
  });

  it("rejects re-ruling an already-denied dispute", () => {
    expect(isValidStatusTransition("denied", "upheld")).toBe(false);
  });
});

describe("hasOpenDispute", () => {
  it("returns true when a pending dispute exists", () => {
    expect(hasOpenDispute([{ status: "denied" }, { status: "pending" }])).toBe(true);
  });

  it("returns false when no dispute is pending", () => {
    expect(hasOpenDispute([{ status: "denied" }, { status: "upheld" }])).toBe(false);
  });

  it("returns false for an empty list", () => {
    expect(hasOpenDispute([])).toBe(false);
  });
});

describe("capRefundAmount", () => {
  it("returns the full amount when no cap is configured", () => {
    expect(capRefundAmount("10.0000000", undefined)).toBe("10.0000000");
  });

  it("returns the full amount when it's under the cap", () => {
    expect(capRefundAmount("5", "10")).toBe("5");
  });

  it("caps the amount when it exceeds the configured maximum", () => {
    expect(capRefundAmount("100", "10")).toBe("10");
  });

  it("returns the amount unchanged when equal to the cap", () => {
    expect(capRefundAmount("10", "10")).toBe("10");
  });
});
