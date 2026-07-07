import { describe, it, expect } from "vitest";
import { parseXPaymentResponse } from "./parseXPaymentResponse.js";

function encode(payload: unknown): string {
  return Buffer.from(JSON.stringify(payload)).toString("base64");
}

describe("parseXPaymentResponse", () => {
  it("extracts the settlement tx from the `transaction` field", () => {
    const header = encode({
      success: true,
      transaction: "abc123txhash",
      network: "stellar:testnet",
    });
    const { settlementTx, parseError } = parseXPaymentResponse(header);
    expect(settlementTx).toBe("abc123txhash");
    expect(parseError).toBeUndefined();
  });

  it("falls back to the `txHash` field when `transaction` is absent", () => {
    const header = encode({ success: true, txHash: "def456txhash" });
    const { settlementTx, parseError } = parseXPaymentResponse(header);
    expect(settlementTx).toBe("def456txhash");
    expect(parseError).toBeUndefined();
  });

  it("prefers `transaction` over `txHash` when both are present", () => {
    const header = encode({ transaction: "primary", txHash: "secondary" });
    const { settlementTx } = parseXPaymentResponse(header);
    expect(settlementTx).toBe("primary");
  });

  it("returns undefined without error for valid JSON missing any tx field", () => {
    const header = encode({ success: true, network: "stellar:testnet" });
    const { settlementTx, parseError } = parseXPaymentResponse(header);
    expect(settlementTx).toBeUndefined();
    expect(parseError).toBeUndefined();
  });

  it("returns a parseError for malformed base64/JSON", () => {
    const { settlementTx, parseError } = parseXPaymentResponse("not-valid-base64-json!!");
    expect(settlementTx).toBeUndefined();
    expect(parseError).toMatch(/Failed to decode/);
  });

  it("returns a parseError when the decoded value is not an object", () => {
    const header = Buffer.from(JSON.stringify(["an", "array"])).toString("base64");
    const { settlementTx, parseError } = parseXPaymentResponse(header);
    expect(settlementTx).toBeUndefined();
    expect(parseError).toMatch(/not an object/);
  });

  it("ignores empty-string tx fields", () => {
    const header = encode({ transaction: "", txHash: "" });
    const { settlementTx, parseError } = parseXPaymentResponse(header);
    expect(settlementTx).toBeUndefined();
    expect(parseError).toBeUndefined();
  });
});
