// ──────────────────────────────────────────────
// Core domain types for Prox Scraper Platform
// ──────────────────────────────────────────────

export interface ScrapeRequest {
  retailer: string;
  zip: string;
  query: string;
}

export interface ProductResult {
  product_name: string;
  size_raw: string | null;
  regular_price: number | null;
  sale_price: number | null;
  unit_price: string | null;
  product_url: string;
  image_url: string | null;
  retailer: string;
  scraped_at: string;
}

export interface ScrapeResult {
  request: ScrapeRequest;
  products: ProductResult[];
  cached: boolean;
  cache_key: string;
  duration_ms: number;
  scraped_at: string;
}

export type JobStatus = 'queued' | 'running' | 'success' | 'failed' | 'retrying' | 'deduped';

export interface JobRecord {
  id: string;
  retailer: string;
  zip: string;
  query: string;
  status: JobStatus;
  attempt: number;
  created_at: string;
  updated_at: string;
  duration_ms: number | null;
  error: string | null;
  result_count: number | null;
  cache_hit: boolean;
}

export type CircuitState = 'CLOSED' | 'OPEN' | 'HALF_OPEN';

export interface CircuitBreakerState {
  retailer: string;
  state: CircuitState;
  failures: number;
  last_failure_at: number | null;
  opened_at: number | null;
}

export interface RateLimitConfig {
  maxRequests: number;   // per window
  windowMs: number;      // window in ms
}

export interface RetailerConfig {
  name: string;
  concurrencyLimit: number;
  rateLimit: RateLimitConfig;
  cacheTtlSeconds: number;
}
