/**
 * Spend Guardrail — hourly proxy request budget per retailer
 *
 * Problem: Proxy providers charge per request (e.g., $0.001–0.01/request).
 * At 5,000 users × 3 searches/day = 15,000 requests/day without any caching.
 * After caching, real scrapes might be ~3,000–5,000/day = significant proxy bill.
 *
 * This guardrail enforces a hard cap on proxy requests per hour per retailer.
 * When the cap is hit:
 *   - New scrape requests are rejected (not queued — caller must handle)
 *   - An alert is logged (production: triggers PagerDuty / Slack alert)
 *   - The cap resets at the next hourly boundary
 *
 * In production: use Redis INCR with EXPIRE for atomic distributed counting.
 */

import { cacheStore } from '../cache/store';
import { SPEND_GUARDRAIL_MAX_REQUESTS_PER_HOUR } from '../utils/config';
import { logger } from '../utils/logger';

function getHourBucket(): string {
  const now = new Date();
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}-${String(now.getUTCDate()).padStart(2, '0')}-${String(now.getUTCHours()).padStart(2, '0')}`;
}

export class SpendGuardrail {
  /**
   * Record a proxy request and check if we're within budget.
   * Returns false if the guardrail is tripped (request should be blocked).
   */
  checkAndRecord(retailer: string): boolean {
    const db = cacheStore.getDb();
    const bucket = getHourBucket();

    db.prepare(`
      INSERT INTO spend_log (retailer, hour_bucket, request_count)
      VALUES (?, ?, 1)
      ON CONFLICT(retailer, hour_bucket) DO UPDATE SET
        request_count = request_count + 1
    `).run(retailer, bucket);

    // Purge rows older than 48 hours — keeps the table lean while retaining
    // yesterday's data for cost comparison queries in monitoring dashboards
    db.prepare(`
      DELETE FROM spend_log
      WHERE hour_bucket < strftime('%Y-%m-%d-%H', datetime('now', '-48 hours'))
    `).run();

    const row = db
      .prepare('SELECT request_count FROM spend_log WHERE retailer = ? AND hour_bucket = ?')
      .get(retailer, bucket) as { request_count: number } | undefined;

    const count = row?.request_count ?? 1;

    if (count > SPEND_GUARDRAIL_MAX_REQUESTS_PER_HOUR) {
      logger.error(
        `SPEND GUARDRAIL TRIPPED for retailer=${retailer}. ` +
        `${count} requests this hour (limit: ${SPEND_GUARDRAIL_MAX_REQUESTS_PER_HOUR}). ` +
        `Blocking until next hour. ACTION REQUIRED: check proxy costs.`
      );
      return false;
    }

    if (count > SPEND_GUARDRAIL_MAX_REQUESTS_PER_HOUR * 0.8) {
      logger.warn(
        `Spend warning: retailer=${retailer} at ${count}/${SPEND_GUARDRAIL_MAX_REQUESTS_PER_HOUR} ` +
        `proxy requests this hour (${Math.round(count / SPEND_GUARDRAIL_MAX_REQUESTS_PER_HOUR * 100)}%)`
      );
    }

    return true;
  }

  getHourlyStats(): Record<string, number> {
    const db = cacheStore.getDb();
    const bucket = getHourBucket();
    const rows = db
      .prepare('SELECT retailer, request_count FROM spend_log WHERE hour_bucket = ?')
      .all(bucket) as { retailer: string; request_count: number }[];

    return Object.fromEntries(rows.map((r) => [r.retailer, r.request_count]));
  }
}

export const spendGuardrail = new SpendGuardrail();
