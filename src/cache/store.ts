/**
 * TTL Cache Store — SQLite-backed (local/dev), Redis-compatible interface (prod)
 *
 * Design decision: We use SQLite locally to keep the demo dependency-free.
 * In production, swap to Redis (same get/set/del interface) for sub-millisecond
 * lookups, cluster-wide sharing, and native TTL support via EXPIRE.
 *
 * Cache key strategy: SHA-256(retailer:zip:query_normalized)
 * Normalization: lowercase, trim, collapse whitespace
 * TTL: 1 hour by default (configurable per retailer)
 *
 * Why cache at this layer (not HTTP):
 *   - HTTP-level caches can't deduplicate across concurrent workers
 *   - We need application-level logic to serve pending requests from the same cache
 *   - We can invalidate selectively (e.g., stale retailer, promo period)
 */

import Database from 'better-sqlite3';
import crypto from 'crypto';
import path from 'path';
import fs from 'fs';
import { ScrapeResult } from '../utils/types';
import { logger } from '../utils/logger';

const DB_PATH = path.join(process.cwd(), 'data', 'cache.db');

function ensureDbDir() {
  const dir = path.dirname(DB_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function openDb(): Database.Database {
  ensureDbDir();
  const db = new Database(DB_PATH);
  db.exec(`
    CREATE TABLE IF NOT EXISTS cache_entries (
      cache_key   TEXT PRIMARY KEY,
      retailer    TEXT NOT NULL,
      zip         TEXT NOT NULL,
      query       TEXT NOT NULL,
      payload     TEXT NOT NULL,
      created_at  INTEGER NOT NULL,
      expires_at  INTEGER NOT NULL
    );

    -- Index for fast TTL sweeps
    CREATE INDEX IF NOT EXISTS idx_cache_expires ON cache_entries(expires_at);

    -- Scrape job audit log
    CREATE TABLE IF NOT EXISTS job_log (
      id          TEXT PRIMARY KEY,
      retailer    TEXT NOT NULL,
      zip         TEXT NOT NULL,
      query       TEXT NOT NULL,
      status      TEXT NOT NULL,
      attempt     INTEGER NOT NULL DEFAULT 1,
      duration_ms INTEGER,
      result_count INTEGER,
      cache_hit   INTEGER NOT NULL DEFAULT 0,
      error       TEXT,
      created_at  TEXT NOT NULL,
      updated_at  TEXT NOT NULL
    );

    -- Spend tracking table (hourly proxy request counts)
    CREATE TABLE IF NOT EXISTS spend_log (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      retailer   TEXT NOT NULL,
      hour_bucket TEXT NOT NULL,
      request_count INTEGER NOT NULL DEFAULT 0,
      UNIQUE(retailer, hour_bucket)
    );
  `);
  return db;
}

export function buildCacheKey(retailer: string, zip: string, query: string): string {
  const normalized = `${retailer.toLowerCase()}:${zip.trim()}:${query.toLowerCase().trim().replace(/\s+/g, ' ')}`;
  return crypto.createHash('sha256').update(normalized).digest('hex');
}

export class CacheStore {
  private db: Database.Database;

  constructor() {
    this.db = openDb();
  }

  /**
   * Get a cached result. Returns null if missing or expired.
   */
  get(cacheKey: string): ScrapeResult | null {
    const now = Date.now();
    const row = this.db
      .prepare('SELECT payload, expires_at FROM cache_entries WHERE cache_key = ?')
      .get(cacheKey) as { payload: string; expires_at: number } | undefined;

    if (!row) return null;

    if (row.expires_at < now) {
      // Expired — delete and return miss
      this.db.prepare('DELETE FROM cache_entries WHERE cache_key = ?').run(cacheKey);
      logger.debug(`Cache expired for key ${cacheKey.slice(0, 12)}...`);
      return null;
    }

    logger.info(`Cache HIT for key ${cacheKey.slice(0, 12)}...`);
    return JSON.parse(row.payload) as ScrapeResult;
  }

  /**
   * Store a result with TTL in seconds.
   */
  set(cacheKey: string, result: ScrapeResult, ttlSeconds: number): void {
    const now = Date.now();
    const expiresAt = now + ttlSeconds * 1000;

    this.db.prepare(`
      INSERT OR REPLACE INTO cache_entries
        (cache_key, retailer, zip, query, payload, created_at, expires_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      cacheKey,
      result.request.retailer,
      result.request.zip,
      result.request.query,
      JSON.stringify(result),
      now,
      expiresAt
    );

    logger.debug(`Cache SET for key ${cacheKey.slice(0, 12)}... (TTL ${ttlSeconds}s)`);
  }

  /**
   * Check if key exists AND is fresh (used for deduplication before firing a job).
   */
  has(cacheKey: string): boolean {
    const now = Date.now();
    const row = this.db
      .prepare('SELECT expires_at FROM cache_entries WHERE cache_key = ?')
      .get(cacheKey) as { expires_at: number } | undefined;
    return !!row && row.expires_at > now;
  }

  /**
   * Purge all expired entries (run this as a periodic maintenance job).
   */
  purgeExpired(): number {
    const result = this.db
      .prepare('DELETE FROM cache_entries WHERE expires_at < ?')
      .run(Date.now());
    const count = result.changes;
    if (count > 0) logger.info(`Cache purge: removed ${count} expired entries`);
    return count;
  }

  /**
   * Invalidate cache for a specific retailer (e.g., after a pricing event).
   */
  invalidateRetailer(retailer: string): number {
    const result = this.db
      .prepare('DELETE FROM cache_entries WHERE retailer = ?')
      .run(retailer.toLowerCase());
    logger.info(`Cache invalidated for retailer=${retailer}: ${result.changes} entries removed`);
    return result.changes;
  }

  /** Raw DB access for job logging */
  getDb(): Database.Database {
    return this.db;
  }
}

// Singleton instance shared across the process
export const cacheStore = new CacheStore();
