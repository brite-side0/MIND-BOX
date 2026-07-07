/**
 * Parses an X-PAYMENT-RESPONSE / PAYMENT-RESPONSE header value and extracts
 * the settlement transaction reference, if present.
 *
 * Mirrors parseXPayment.ts's decode + error-handling shape: base64-decode,
 * JSON.parse, then defensively probe known field names. The installed
 * @x402/core `SettleResponse` type (dist/cjs/x402Client-*.d.ts) declares a
 * `transaction: string` field; loggingFacilitator.summarizeSettle() also
 * defensively checks `txHash` in case an older/alternate facilitator shape is
 * in play, so this does the same.
 *
 * @returns settlementTx string, or undefined if none found or header is
 *   invalid/missing the field. Never throws.
 */
export function parseXPaymentResponse(header: string): {
  settlementTx: string | undefined;
  parseError: string | undefined;
} {
  let decoded: unknown;
  try {
    decoded = JSON.parse(Buffer.from(header, "base64").toString("utf8"));
  } catch (err) {
    return {
      settlementTx: undefined,
      parseError: `Failed to decode X-PAYMENT-RESPONSE header: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  if (!decoded || typeof decoded !== "object" || Array.isArray(decoded)) {
    return {
      settlementTx: undefined,
      parseError: "X-PAYMENT-RESPONSE decoded value is not an object",
    };
  }

  const d = decoded as Record<string, unknown>;

  if (typeof d.transaction === "string" && d.transaction) {
    return { settlementTx: d.transaction, parseError: undefined };
  }
  if (typeof d.txHash === "string" && d.txHash) {
    return { settlementTx: d.txHash, parseError: undefined };
  }

  return { settlementTx: undefined, parseError: undefined };
}
