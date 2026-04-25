/**
 * Token Bucket Rate Limiter — per-retailer
 *
 * Uses a simple token bucket algorithm:
 *   - Each retailer gets N tokens per window (e.g., 30 req/min)
 *   - Each request consumes 1 token
 *   - Tokens refill at window boundary
 *   - If no tokens remain, request is delayed (or rejected with a wait time)
 *
 * In production: replace with Redis INCR + EXPIRE for distributed rate limiting.
 * (Upstash Redis works great for this with zero infra overhead)
 *
 * This prevents:
 *   1. Proxy cost overruns
 *   2. Retailer IP bans from too-rapid requests
 *   3. API quota exhaustion
 */

import { logger } from '../utils/logger';
import { getRetailerConfig } from '../utils/config';

interface BucketState {
  tokens: number;
  windowStart: number;
}

export class RateLimiter {
  private buckets: Map<string, BucketState> = new Map();

  private getBucket(retailer: string): BucketState {
    const config = getRetailerConfig(retailer);
    const now = Date.now();

    if (!this.buckets.has(retailer)) {
      this.buckets.set(retailer, {
        tokens: config.rateLimit.maxRequests,
        windowStart: now,
      });
    }

    const bucket = this.buckets.get(retailer)!;

    // Refill on window boundary
    if (now - bucket.windowStart >= config.rateLimit.windowMs) {
      bucket.tokens = config.rateLimit.maxRequests;
      bucket.windowStart = now;
    }

    return bucket;
  }

  /**
   * Attempt to consume a token. Returns wait time in ms (0 = proceed immediately).
   */
  tryConsume(retailer: string): { allowed: boolean; waitMs: number } {
    const config = getRetailerConfig(retailer);
    const bucket = this.getBucket(retailer);

    if (bucket.tokens > 0) {
      bucket.tokens -= 1;
      return { allowed: true, waitMs: 0 };
    }

    // Calculate wait until next window refill
    const elapsed = Date.now() - bucket.windowStart;
    const waitMs = Math.max(0, config.rateLimit.windowMs - elapsed);

    logger.warn(
      `Rate limit reached for retailer=${retailer}. ` +
      `Wait ${Math.ceil(waitMs / 1000)}s for next window. ` +
      `(Limit: ${config.rateLimit.maxRequests} req/${config.rateLimit.windowMs / 1000}s)`
    );

    return { allowed: false, waitMs };
  }

  /**
   * Consume a token, waiting if necessary (async).
   * Use this when you want to automatically throttle without dropping requests.
   */
  async consume(retailer: string): Promise<void> {
    const { allowed, waitMs } = this.tryConsume(retailer);
    if (!allowed) {
      await new Promise((resolve) => setTimeout(resolve, waitMs + 100));
      // After wait, tokens should be refilled — consume now
      const bucket = this.getBucket(retailer);
      if (bucket.tokens > 0) {
        bucket.tokens -= 1;
      }
    }
  }

  getStatus(): Record<string, { tokens: number; windowAgeMs: number }> {
    const out: Record<string, { tokens: number; windowAgeMs: number }> = {};
    this.buckets.forEach((v, k) => {
      out[k] = { tokens: v.tokens, windowAgeMs: Date.now() - v.windowStart };
    });
    return out;
  }
}

export const rateLimiter = new RateLimiter();
