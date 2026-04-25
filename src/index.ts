/**
 * Prox Scraper Platform — Main export
 * Exposes all public APIs for programmatic use (e.g., from a future REST API layer)
 */

export { runJob, getJobHistory } from './runner/jobRunner';
export { cacheStore, buildCacheKey } from './cache/store';
export { circuitBreaker } from './controls/circuitBreaker';
export { rateLimiter } from './controls/rateLimiter';
export { spendGuardrail } from './controls/spendGuardrail';
export { RETAILER_CONFIGS, getRetailerConfig } from './utils/config';
export * from './utils/types';
