import { RetailerConfig } from './types';

// ──────────────────────────────────────────────────────────────────────────────
// Retailer registry — add new retailers here, no code changes elsewhere needed
// In production, this config would be stored in a database or config service
// ──────────────────────────────────────────────────────────────────────────────

export const RETAILER_CONFIGS: Record<string, RetailerConfig> = {
  kroger: {
    name: 'kroger',
    concurrencyLimit: parseInt(process.env.CONCURRENCY_KROGER || '3'),
    rateLimit: {
      maxRequests: parseInt(process.env.RATE_LIMIT_KROGER || '30'),
      windowMs: 60_000, // 1 minute
    },
    cacheTtlSeconds: parseInt(process.env.CACHE_TTL_SECONDS || '3600'),
  },
  walmart: {
    name: 'walmart',
    concurrencyLimit: parseInt(process.env.CONCURRENCY_WALMART || '3'),
    rateLimit: {
      maxRequests: parseInt(process.env.RATE_LIMIT_WALMART || '30'),
      windowMs: 60_000,
    },
    cacheTtlSeconds: parseInt(process.env.CACHE_TTL_SECONDS || '3600'),
  },
  safeway: {
    name: 'safeway',
    concurrencyLimit: parseInt(process.env.CONCURRENCY_DEFAULT || '2'),
    rateLimit: {
      maxRequests: parseInt(process.env.RATE_LIMIT_DEFAULT || '20'),
      windowMs: 60_000,
    },
    cacheTtlSeconds: parseInt(process.env.CACHE_TTL_SECONDS || '3600'),
  },
  target: {
    name: 'target',
    concurrencyLimit: parseInt(process.env.CONCURRENCY_DEFAULT || '2'),
    rateLimit: {
      maxRequests: parseInt(process.env.RATE_LIMIT_DEFAULT || '20'),
      windowMs: 60_000,
    },
    cacheTtlSeconds: parseInt(process.env.CACHE_TTL_SECONDS || '3600'),
  },
  costco: {
    name: 'costco',
    concurrencyLimit: parseInt(process.env.CONCURRENCY_DEFAULT || '2'),
    rateLimit: {
      maxRequests: parseInt(process.env.RATE_LIMIT_DEFAULT || '20'),
      windowMs: 60_000,
    },
    cacheTtlSeconds: parseInt(process.env.CACHE_TTL_SECONDS || '3600'),
  },
  ralphs: {
    name: 'ralphs',
    concurrencyLimit: parseInt(process.env.CONCURRENCY_DEFAULT || '2'),
    rateLimit: {
      maxRequests: parseInt(process.env.RATE_LIMIT_DEFAULT || '20'),
      windowMs: 60_000,
    },
    cacheTtlSeconds: parseInt(process.env.CACHE_TTL_SECONDS || '3600'),
  },
};

export function getRetailerConfig(retailer: string): RetailerConfig {
  const config = RETAILER_CONFIGS[retailer.toLowerCase()];
  if (!config) {
    // Graceful fallback for unregistered retailers
    return {
      name: retailer.toLowerCase(),
      concurrencyLimit: parseInt(process.env.CONCURRENCY_DEFAULT || '2'),
      rateLimit: {
        maxRequests: parseInt(process.env.RATE_LIMIT_DEFAULT || '20'),
        windowMs: 60_000,
      },
      cacheTtlSeconds: parseInt(process.env.CACHE_TTL_SECONDS || '3600'),
    };
  }
  return config;
}

export const CIRCUIT_BREAKER_THRESHOLD = parseInt(
  process.env.CIRCUIT_BREAKER_THRESHOLD || '5'
);
export const CIRCUIT_BREAKER_TIMEOUT_MS = parseInt(
  process.env.CIRCUIT_BREAKER_TIMEOUT_MS || '60000'
);
export const SPEND_GUARDRAIL_MAX_REQUESTS_PER_HOUR = parseInt(
  process.env.SPEND_GUARDRAIL_MAX_REQUESTS_PER_HOUR || '500'
);
