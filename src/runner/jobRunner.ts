/**
 * Job Runner — core execution engine
 *
 * Responsibilities:
 *   1. Deduplication: check cache before firing a scrape
 *   2. Concurrency: limit parallel scrapes per retailer via p-limit
 *   3. Rate limiting: token bucket per retailer
 *   4. Circuit breaking: fail-fast for unhealthy retailers
 *   5. Spend guardrail: enforce hourly proxy budget
 *   6. Execution: spawn mock scraper (or real scraper binary)
 *   7. Retry: exponential backoff with jitter on failure
 *   8. Logging: structured audit log to SQLite + Winston
 *   9. Caching: persist successful results with TTL
 *
 * Concurrency strategy:
 *   - p-limit creates per-retailer queues
 *   - Maps are populated lazily on first request for a retailer
 *   - Adding a new retailer requires zero code changes (config-driven)
 */

import pLimit from 'p-limit';
import pRetry from 'p-retry';
import { v4 as uuidv4 } from 'uuid';
import { ScrapeRequest, ScrapeResult, JobRecord } from '../utils/types';
import { cacheStore, buildCacheKey } from '../cache/store';
import { circuitBreaker } from '../controls/circuitBreaker';
import { rateLimiter } from '../controls/rateLimiter';
import { spendGuardrail } from '../controls/spendGuardrail';
import { getRetailerConfig } from '../utils/config';
import { runMockScraper } from '../scraper/mockScraper';
import { createJobLogger, logger } from '../utils/logger';

// Per-retailer concurrency limiters (lazy-initialized)
const concurrencyLimiters = new Map<string, ReturnType<typeof pLimit>>();

function getLimiter(retailer: string): ReturnType<typeof pLimit> {
  if (!concurrencyLimiters.has(retailer)) {
    const config = getRetailerConfig(retailer);
    concurrencyLimiters.set(retailer, pLimit(config.concurrencyLimit));
    logger.debug(`Created concurrency limiter for retailer=${retailer} (limit=${config.concurrencyLimit})`);
  }
  return concurrencyLimiters.get(retailer)!;
}

function logJob(job: Partial<JobRecord>): void {
  const db = cacheStore.getDb();
  const now = new Date().toISOString();

  const existing = db
    .prepare('SELECT id FROM job_log WHERE id = ?')
    .get(job.id) as { id: string } | undefined;

  if (existing) {
    db.prepare(`
      UPDATE job_log SET
        status = ?, attempt = ?, duration_ms = ?,
        result_count = ?, cache_hit = ?, error = ?, updated_at = ?
      WHERE id = ?
    `).run(
      job.status, job.attempt ?? 1, job.duration_ms ?? null,
      job.result_count ?? null, job.cache_hit ? 1 : 0, job.error ?? null,
      now, job.id
    );
  } else {
    db.prepare(`
      INSERT INTO job_log
        (id, retailer, zip, query, status, attempt, duration_ms, result_count, cache_hit, error, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      job.id, job.retailer, job.zip, job.query,
      job.status, job.attempt ?? 1, job.duration_ms ?? null,
      job.result_count ?? null, job.cache_hit ? 1 : 0, job.error ?? null,
      now, now
    );
  }
}

/**
 * Execute a scrape job with all cost controls applied.
 * This is the single entry point for all scrape requests.
 */
export async function runJob(request: ScrapeRequest): Promise<ScrapeResult> {
  const jobId = uuidv4();
  const jLogger = createJobLogger(jobId, request.retailer);
  const config = getRetailerConfig(request.retailer);
  const cacheKey = buildCacheKey(request.retailer, request.zip, request.query);

  jLogger.info(`Job queued: retailer=${request.retailer} zip=${request.zip} query="${request.query}"`);

  // ── 1. DEDUPLICATION: Check cache before doing any work ──────────────────
  const cached = cacheStore.get(cacheKey);
  if (cached) {
    jLogger.info(`Deduped (cache hit) — returning ${cached.products.length} cached products`);
    logJob({
      id: jobId,
      retailer: request.retailer,
      zip: request.zip,
      query: request.query,
      status: 'deduped',
      result_count: cached.products.length,
      cache_hit: true,
    });
    return { ...cached, cached: true, cache_key: cacheKey };
  }

  // ── 2. CIRCUIT BREAKER: Fail-fast if retailer is unhealthy ───────────────
  try {
    circuitBreaker.allowRequest(request.retailer);
  } catch (err) {
    jLogger.error(`Circuit open — rejecting job: ${(err as Error).message}`);
    logJob({
      id: jobId,
      retailer: request.retailer,
      zip: request.zip,
      query: request.query,
      status: 'failed',
      error: (err as Error).message,
      cache_hit: false,
    });
    throw err;
  }

  // ── 3. SPEND GUARDRAIL: Hourly budget check ──────────────────────────────
  if (!spendGuardrail.checkAndRecord(request.retailer)) {
    const errMsg = `Spend guardrail exceeded for retailer=${request.retailer}`;
    logJob({
      id: jobId,
      retailer: request.retailer,
      zip: request.zip,
      query: request.query,
      status: 'failed',
      error: errMsg,
      cache_hit: false,
    });
    throw new Error(errMsg);
  }

  // ── 4. RATE LIMITER: Throttle requests ───────────────────────────────────
  await rateLimiter.consume(request.retailer);

  logJob({
    id: jobId,
    retailer: request.retailer,
    zip: request.zip,
    query: request.query,
    status: 'queued',
    cache_hit: false,
  });

  // ── 5. CONCURRENCY LIMITER + RETRY: Run inside per-retailer limiter ──────
  const limiter = getLimiter(request.retailer);

  const result = await limiter(async () => {
    const startTime = Date.now();

    logJob({
      id: jobId,
      retailer: request.retailer,
      zip: request.zip,
      query: request.query,
      status: 'running',
      cache_hit: false,
    });

    jLogger.info(`Job started (concurrency slot acquired)`);

    // Exponential backoff retry: 1s → 2s → 4s, max 3 attempts
    const scrapeResult = await pRetry(
      async (attemptNumber) => {
        if (attemptNumber > 1) {
          jLogger.warn(`Retry attempt ${attemptNumber}`);
          logJob({
            id: jobId,
            retailer: request.retailer,
            zip: request.zip,
            query: request.query,
            status: 'retrying',
            attempt: attemptNumber,
            cache_hit: false,
          });
        }

        const result = await runMockScraper(request.retailer, request.zip, request.query);
        return result;
      },
      {
        retries: 3,
        factor: 2,
        minTimeout: 1000,
        maxTimeout: 8000,
        randomize: true, // jitter prevents thundering herd on retry storm
        onFailedAttempt: (error) => {
          jLogger.warn(
            `Attempt ${error.attemptNumber} failed: ${error.message}. ` +
            `${error.retriesLeft} retries left.`
          );
          circuitBreaker.onFailure(request.retailer);
        },
      }
    );

    const duration = Date.now() - startTime;
    scrapeResult.duration_ms = duration;
    scrapeResult.cache_key = cacheKey;

    // ── 6. SUCCESS PATH ─────────────────────────────────────────────────────
    circuitBreaker.onSuccess(request.retailer);

    jLogger.info(
      `Job success — ${scrapeResult.products.length} products in ${duration}ms`
    );

    // Cache the result with retailer-specific TTL
    cacheStore.set(cacheKey, scrapeResult, config.cacheTtlSeconds);

    logJob({
      id: jobId,
      retailer: request.retailer,
      zip: request.zip,
      query: request.query,
      status: 'success',
      attempt: 1,
      duration_ms: duration,
      result_count: scrapeResult.products.length,
      cache_hit: false,
    });

    return scrapeResult;
  });

  return result;
}

/**
 * Retrieve recent job history from the audit log.
 */
export function getJobHistory(limit = 20): JobRecord[] {
  const db = cacheStore.getDb();
  return db
    .prepare('SELECT * FROM job_log ORDER BY created_at DESC LIMIT ?')
    .all(limit) as JobRecord[];
}
