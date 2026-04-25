# Runbook — Prox Scraper Platform

Operational guide for deployment, debugging, and incident response.

---

## 1. Local Setup

### Prerequisites
- Node.js 18+
- npm or yarn

### Install & Run

```bash
# Clone the repo
git clone https://github.com/bharanidharan27/prox-scraper-platform
cd prox-scraper-platform

# Install dependencies
npm install

# Copy env file and configure
cp .env.example .env

# Run a single scrape job
npx ts-node src/runner/cli.ts --retailer=kroger --zip=90046 --query=milk

# Run the full feature demo
npx ts-node src/demo.ts

# Run a search and get raw JSON output
npx ts-node src/runner/cli.ts --retailer=walmart --zip=10001 --query="tide pods" --json

# Check system status (circuit breakers, rate limits, spend)
npx ts-node src/runner/cli.ts --status

# Build production bundle
npm run build
```

### Available CLI Options

| Flag | Required | Description |
|---|---|---|
| `--retailer` / `-r` | ✓ | Retailer name (kroger, walmart, safeway, target, costco, ralphs) |
| `--zip` / `-z` | ✓ | ZIP code for store location context |
| `--query` / `-q` | ✓ | Product search query |
| `--json` | | Output raw JSON (pipe-friendly) |
| `--status` | | Show circuit breakers, rate limits, and spend stats |

---

## 2. Deployment

### Environment Variables

| Variable | Default | Description |
|---|---|---|
| `PROXY_URL` | — | Proxy provider endpoint |
| `PROXY_USERNAME` | — | Proxy auth username |
| `PROXY_PASSWORD` | — | Proxy auth password |
| `REDIS_URL` | `redis://localhost:6379` | Redis URL (prod cache + queue) |
| `CONCURRENCY_KROGER` | `3` | Max parallel Kroger scrapes |
| `CONCURRENCY_WALMART` | `3` | Max parallel Walmart scrapes |
| `CONCURRENCY_DEFAULT` | `2` | Max parallel scrapes for other retailers |
| `RATE_LIMIT_KROGER` | `30` | Requests per minute for Kroger |
| `RATE_LIMIT_WALMART` | `30` | Requests per minute for Walmart |
| `RATE_LIMIT_DEFAULT` | `20` | Requests per minute for other retailers |
| `CACHE_TTL_SECONDS` | `3600` | Cache TTL in seconds (1 hour) |
| `CIRCUIT_BREAKER_THRESHOLD` | `5` | Consecutive failures before circuit opens |
| `CIRCUIT_BREAKER_TIMEOUT_MS` | `60000` | Circuit open duration (60s) |
| `SPEND_GUARDRAIL_MAX_REQUESTS_PER_HOUR` | `500` | Max proxy requests/hour total |
| `MOCK_FAILURE_RATE` | `0.10` | Simulated failure rate (demo/dev only) |

### Adding a New Retailer

1. Add an entry to `src/utils/config.ts` → `RETAILER_CONFIGS`
2. Create a new scraper at `scrapers/<retailer>/index.ts` (or Python equivalent)
3. Register the scraper binary path in the runner (currently mock; production uses `child_process.spawn`)
4. No other code changes needed — the system is config-driven

---

## 3. Debugging Guide

### Symptom: "Circuit OPEN" errors for a retailer

**Cause:** 5+ consecutive scrape failures for that retailer.

**Steps:**
1. Check `logs/error.log` for the failure messages
2. Verify proxy is working: `curl -x $PROXY_URL https://www.kroger.com`
3. Check if the retailer changed their bot detection (common after deploys)
4. Wait 60 seconds (circuit auto-transitions to HALF_OPEN for a probe)
5. If probe succeeds, circuit closes automatically
6. If probe fails, investigate scraper logic

**Override (emergency only):**
```typescript
import { circuitBreaker } from './src/controls/circuitBreaker';
circuitBreaker.onSuccess('kroger'); // Force close circuit
```

---

### Symptom: Spend guardrail tripped

**Cause:** Exceeded `SPEND_GUARDRAIL_MAX_REQUESTS_PER_HOUR` proxy requests in a single hour.

**Steps:**
1. Check `data/cache.db` → `spend_log` table for which retailer is over-budget
2. Verify cache hit rate is healthy — low hit rates = too many live scrapes
3. Check for cache invalidation bug (mass-invalidation causes spike)
4. Raise the limit temporarily: `SPEND_GUARDRAIL_MAX_REQUESTS_PER_HOUR=1000`
5. Guardrail resets at top of next hour automatically

---

### Symptom: High retry rate (> 20%)

**Cause:** Proxy quality degradation, retailer rate limiting, or anti-bot triggers.

**Steps:**
1. Check `logs/combined.log` for retry patterns
2. Identify which retailer(s) are retrying
3. Try rotating proxy pool: update `PROXY_URL` to a different pool
4. Reduce concurrency temporarily: lower `CONCURRENCY_*` env vars
5. Check scraper version — retailer may have updated their HTML structure

---

### Symptom: Slow response times (> 5s)

**Cause:** Proxy latency, retailer slowness, or concurrency queue buildup.

**Steps:**
1. Check `logs/combined.log` for `duration_ms` values
2. Query job audit log:
   ```sql
   SELECT retailer, AVG(duration_ms), COUNT(*) FROM job_log
   WHERE status = 'success' AND created_at > datetime('now', '-1 hour')
   GROUP BY retailer;
   ```
3. If proxy latency is high → switch proxy provider or region
4. If queue buildup → increase `CONCURRENCY_*` limits
5. Check if nightly preload is running (high daytime cache hit rate = fast responses)

---

### Symptom: Cache not working (low hit rate)

**Steps:**
1. Check `data/cache.db` → `cache_entries` table for entries
2. Verify cache key normalization is consistent (check for whitespace/case differences)
3. Check TTL: `SELECT cache_key, datetime(expires_at/1000, 'unixepoch') FROM cache_entries LIMIT 10;`
4. Run manual purge: `cacheStore.purgeExpired()`
5. In production (Redis): `redis-cli TTL <cache_key>` to inspect key expiry

---

## 4. Database Schema Reference

### `cache_entries`
| Column | Type | Description |
|---|---|---|
| `cache_key` | TEXT PK | SHA-256 hash of retailer:zip:query_normalized |
| `retailer` | TEXT | Retailer name |
| `zip` | TEXT | ZIP code |
| `query` | TEXT | Search query |
| `payload` | TEXT | JSON-serialized ScrapeResult |
| `created_at` | INTEGER | Unix timestamp (ms) |
| `expires_at` | INTEGER | Unix timestamp (ms) when entry expires |

### `job_log`
| Column | Type | Description |
|---|---|---|
| `id` | TEXT PK | UUID |
| `retailer` | TEXT | Retailer name |
| `zip` | TEXT | ZIP code |
| `query` | TEXT | Search query |
| `status` | TEXT | queued / running / success / failed / retrying / deduped |
| `attempt` | INTEGER | Current attempt number |
| `duration_ms` | INTEGER | Execution time |
| `result_count` | INTEGER | Number of products returned |
| `cache_hit` | INTEGER | 1 if served from cache |
| `error` | TEXT | Error message if failed |
| `created_at` | TEXT | ISO timestamp |
| `updated_at` | TEXT | ISO timestamp |

### `spend_log`
| Column | Type | Description |
|---|---|---|
| `retailer` | TEXT | Retailer name |
| `hour_bucket` | TEXT | YYYY-MM-DD-HH (UTC) |
| `request_count` | INTEGER | Live proxy requests this hour |

---

## 5. Useful Queries

```sql
-- Jobs in last hour
SELECT status, COUNT(*) FROM job_log
WHERE created_at > datetime('now', '-1 hour')
GROUP BY status;

-- Cache hit rate today
SELECT
  SUM(CASE WHEN cache_hit = 1 THEN 1 ELSE 0 END) * 100.0 / COUNT(*) AS hit_rate_pct
FROM job_log WHERE created_at > datetime('now', '-24 hours');

-- Slowest retailers today
SELECT retailer, AVG(duration_ms) as avg_ms, MAX(duration_ms) as max_ms
FROM job_log WHERE status = 'success'
GROUP BY retailer ORDER BY avg_ms DESC;

-- Spend by retailer this hour
SELECT retailer, request_count FROM spend_log
WHERE hour_bucket = strftime('%Y-%m-%d-%H', 'now');

-- Failed jobs in last hour
SELECT retailer, query, error FROM job_log
WHERE status = 'failed' AND created_at > datetime('now', '-1 hour')
ORDER BY created_at DESC;
```
