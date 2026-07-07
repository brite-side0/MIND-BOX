import { and, isNull, lt, sql } from "drizzle-orm";
import { db } from "../db/client.js";
import { leases } from "../db/schema.js";
import { getLogger } from "../lib/logger.js";

// Lease expiry sweeper (ADR: adr-time-limited-access-leases.md, Follow-Up #3).
//
// Expiry is enforced at READ time (findActiveLeaseByToken checks `now <
// expires_at`), so this worker is pure housekeeping: it periodically counts the
// leases that have passed their window and are not already revoked, for
// observability. It mirrors retryPendingWorker's start/stop + interval shape.
//
// It deliberately does NOT delete rows — expired leases are retained as an audit
// trail (paired with their payments row). Should a hard cleanup ever be needed,
// it can be added here without touching the read path.

const WORKER_INTERVAL_MS = 60_000;

let intervalHandle: ReturnType<typeof setInterval> | null = null;

export function startLeaseExpiryWorker(): void {
  getLogger().info(
    { event: "lease_expiry_worker_start", intervalMs: WORKER_INTERVAL_MS },
    "starting lease-expiry sweeper worker",
  );

  void tick();
  intervalHandle = setInterval(() => void tick(), WORKER_INTERVAL_MS);
}

export function stopLeaseExpiryWorker(): void {
  if (intervalHandle) {
    clearInterval(intervalHandle);
    intervalHandle = null;
  }
}

export async function tick(): Promise<void> {
  try {
    const expired = await db
      .select()
      .from(leases)
      .where(and(lt(leases.expiresAt, sql`NOW()`), isNull(leases.revokedAt)));

    if (expired.length === 0) return;

    getLogger().info(
      { event: "lease_expiry_sweep", expiredCount: expired.length },
      "swept expired access leases (housekeeping)",
    );
  } catch (err) {
    getLogger().error(
      { event: "lease_expiry_worker_tick_error", err },
      "lease-expiry worker tick failed",
    );
  }
}
