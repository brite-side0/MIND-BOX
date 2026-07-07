import { Router, type Router as RouterType, type Request, type Response } from "express";
import { validate } from "../middleware/validate.js";
import { fileDisputeSchema, ruleDisputeSchema } from "../schemas/requests.js";
import { fileDispute, getDispute, ruleDispute } from "../services/disputeService.js";
import { config } from "../config.js";
import { getLogger } from "../lib/logger.js";

// Dispute API (ADR: adr-refund-escrow-mechanism.md, Option C: Server-Mediated
// Partial Refunds).
//
// NOTE: mindbox_dispute / mindbox_dispute_status MCP tools are a follow-up
// (ADR Recommended Follow-Up Issue #1) and are intentionally out of scope here.
//
// No dedicated rate limiter is wired to POST /disputes: the existing limiters
// in middleware/rateLimiters.ts are IP/wallet limiters purpose-built for
// verify-content and publish, keyed off config knobs (RATE_LIMIT_VERIFY_*,
// RATE_LIMIT_PUBLISH_*) specific to those routes. Reusing them here would
// either misuse an unrelated budget or require new RATE_LIMIT_DISPUTE_* config
// wiring, which is more than a trivial reuse — left as a follow-up.

const router: RouterType = Router();

function isAdminAuthorized(req: Request): boolean {
  if (!config.ADMIN_TOKEN) return false;
  const provided =
    req.headers.authorization?.replace(/^Bearer\s+/i, "") ??
    (req.query["token"] as string | undefined);
  return provided === config.ADMIN_TOKEN;
}

// POST /disputes — buyer files a dispute.
router.post("/disputes", validate(fileDisputeSchema), async (req: Request, res: Response) => {
  const { resourceId, buyerAddress, amount, reason } = req.body as {
    resourceId: string;
    buyerAddress: string;
    amount: string;
    reason: string;
  };

  try {
    const dispute = await fileDispute({ resourceId, buyerAddress, amount, reason });
    res.status(201).json(dispute);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to file dispute";
    getLogger().warn({ event: "dispute_file_failed", resourceId, buyerAddress, error: message });
    res.status(400).json({ error: message });
  }
});

// GET /disputes/:id — public dispute status lookup.
router.get("/disputes/:id", async (req: Request, res: Response) => {
  const dispute = await getDispute(req.params.id as string);
  if (!dispute) {
    res.status(404).json({ error: "Dispute not found" });
    return;
  }
  res.json(dispute);
});

// POST /disputes/:id/rule — admin ruling. Gated by ADMIN_TOKEN via Bearer auth
// or ?token=, mirroring routes/metrics.ts's gating pattern exactly. If
// ADMIN_TOKEN is unset, the endpoint is disabled (404) — same convention as
// /metrics when METRICS_TOKEN is unset.
router.post(
  "/disputes/:id/rule",
  (req: Request, res: Response, next) => {
    if (!config.ADMIN_TOKEN) {
      res.status(404).end();
      return;
    }
    if (!isAdminAuthorized(req)) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
    next();
  },
  validate(ruleDisputeSchema),
  async (req: Request, res: Response) => {
    const { decision } = req.body as { decision: "upheld" | "denied" };
    try {
      const dispute = await ruleDispute({ id: req.params.id as string, decision });
      res.json(dispute);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to rule on dispute";
      const status = /not found/i.test(message) ? 404 : 409;
      res.status(status).json({ error: message });
    }
  },
);

export default router;
