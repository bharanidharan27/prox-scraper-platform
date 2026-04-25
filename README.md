# Prox Scraper Platform

**Track A — Cost-Aware, High-Throughput Scraper Infrastructure**

A cloud-ready execution framework for running retailer product search scrapers reliably and cost-effectively at scale. Designed for 5,000 users × 3 searches/day across 6+ retailers with sub-5-second response targets.

---

## Quick Start

```bash
# Install dependencies
npm install

# Run a scrape job
npx ts-node src/runner/cli.ts --retailer=kroger --zip=90046 --query=milk

# Run the full feature demo (shows dedup, caching, circuit breaker, concurrency)
npx ts-node src/demo.ts

# JSON output (pipe-friendly)
npx ts-node src/runner/cli.ts --retailer=walmart --zip=10001 --query="tide pods" --json

# System status
npx ts-node src/runner/cli.ts --status
```

---

## Features

| Feature | Implementation |
|---|---|
| **TTL Cache** | SHA-256 keyed, 1-hour TTL, SQLite (dev) / Redis (prod) |
| **Deduplication** | Cache hit check before any scrape fires |
| **Concurrency Limits** | `p-limit` per retailer (e.g., Kroger max 3 parallel) |
| **Exponential Backoff** | `p-retry` with jitter, 3 attempts: 1s → 2s → 4s |
| **Circuit Breaker** | Per-retailer, CLOSED/OPEN/HALF_OPEN states |
| **Rate Limiter** | Token bucket per retailer (e.g., 30 req/min) |
| **Spend Guardrail** | Hourly hard cap on proxy requests with alerting |
| **Job Audit Log** | Every job persisted to SQLite with status + duration |
| **Structured Logging** | Winston, JSON format, file + console transports |
| **Config-Driven** | Add a new retailer in one place — zero other code changes |

---

## Architecture

See [`/docs/architecture.md`](docs/architecture.md) for:
- Full job flow diagram (request → cache → circuit breaker → rate limiter → scrape → cache)
- Cron vs Queue vs On-Demand decision matrix
- Component breakdown
- Secret management strategy (local `.env` → AWS Secrets Manager in prod)
- Logging + monitoring approach (Winston → Datadog / CloudWatch)
- Failure isolation strategy
- Production infrastructure diagram

---

## Tooling Decisions

### TypeScript
Strong typing makes the pipeline logic easy to follow and catch errors at compile time. The `ScrapeRequest / ScrapeResult / JobRecord` interfaces are the contract between every layer.

### `p-limit` for concurrency
Zero-dependency, battle-tested. Per-retailer limiter maps are lazy-initialized — adding a new retailer requires no changes to the runner. Alternative considered: `pQueue` (more overhead for this use case).

### `p-retry` for backoff
Clean API, composable with `p-limit`. Exponential backoff with jitter prevents thundering herd on retry storms. Alternative: manual `setTimeout` recursion — more error-prone.

### `better-sqlite3` for local persistence
Synchronous SQLite driver — no async overhead for cache reads/writes. Drop-in interface makes swapping to Redis in production straightforward (same `get`/`set` semantics). Alternative: PostgreSQL — overkill for a cache store, slower for local dev.

### Winston for logging
Structured JSON logging compatible with Datadog, CloudWatch, Loki. Child loggers attach `jobId` and `retailer` context to every message automatically. Alternative: `pino` — slightly faster, but Winston's transport system is better for multi-destination logging.

### Mock scraper (not real scraping)
The mock scraper simulates realistic latency (500ms–3s), random failures (10%), and product data. The real scraper would be a separate binary invoked via `child_process.spawn`, reading stdout as JSON. This separation means the runner is scraper-language-agnostic (Node, Python, Go).

---

## Matching Logic

This is Track A (infrastructure), not Track B/C (matching). The job runner treats scrapers as black boxes that return JSON. Matching quality is the scraper's responsibility. The runner's job is to run scrapers reliably, cheaply, and fast.

---

## Tradeoffs

| Decision | Tradeoff |
|---|---|
| SQLite over Redis locally | No network overhead, easy setup — but not shared across processes. In prod, Redis is required for multi-worker dedup. |
| In-memory circuit breaker | Same caveat — in prod, state lives in Redis so all workers share it. |
| Mock scraper | Eliminates real scraping complexity for the demo. In production, each retailer scraper is a separate deployable with its own dependencies and failure modes. |
| 1-hour cache TTL | Conservative — prices can change intraday. A smarter system would use shorter TTLs for sale items and longer TTLs for stable staples. |
| p-retry max 3 attempts | Enough to handle transient proxy failures without hammering a broken retailer. Circuit breaker handles systematic failures. |

---

## Scale & Cost Strategy

See [`/docs/scale-and-cost-strategy.md`](docs/scale-and-cost-strategy.md) — covers:
- Nightly preload strategy (top 100 queries per retailer)
- In-flight deduplication (prevents "100 users scraping milk simultaneously")
- Cost model: 90% cache hit rate → $7.50/day vs $75/day unoptimized
- Scaling path: single server → horizontal workers → regional deployment
- Proxy cost controls (residential vs datacenter tiering)

---

## Runbook

See [`/docs/runbook.md`](docs/runbook.md) for:
- Full setup and deploy instructions
- Environment variable reference
- Adding a new retailer (one config change)
- Debugging guide for circuit breaker, spend guardrail, retry storms, cache misses
- Useful SQL queries for monitoring

---

## Project Structure

```
prox-scraper-platform/
├── src/
│   ├── runner/
│   │   ├── jobRunner.ts      # Core orchestration engine
│   │   └── cli.ts            # CLI entry point
│   ├── cache/
│   │   └── store.ts          # TTL cache (SQLite/Redis)
│   ├── controls/
│   │   ├── circuitBreaker.ts # Per-retailer failure isolation
│   │   ├── rateLimiter.ts    # Token bucket rate limiting
│   │   └── spendGuardrail.ts # Hourly proxy budget enforcement
│   ├── scraper/
│   │   └── mockScraper.ts    # Simulated scraper (prod: real CLI)
│   └── utils/
│       ├── types.ts          # TypeScript interfaces
│       ├── config.ts         # Retailer registry
│       └── logger.ts         # Structured logging
├── docs/
│   ├── architecture.md
│   ├── runbook.md
│   └── scale-and-cost-strategy.md
├── data/                     # Auto-created: SQLite DB
├── logs/                     # Auto-created: log files
├── .env.example
├── package.json
├── tsconfig.json
└── README.md
```

---

## Demo Output

```
╔════════════════════════════════════════╗
║   Prox Scraper Platform — Live Demo   ║
╚════════════════════════════════════════╝

▶ 1. Basic scrape: Kroger + milk in 90046
──────────────────────────────────────────────────────────────
✓ Scraped 6 products in 1243ms
  • Kroger Whole Milk (1 gallon) — $3.29
  • Organic Valley Whole Milk (1/2 gallon) — $4.99
  • Horizon Organic 2% Milk (1 gallon) — $6.49

▶ 2. Deduplication — same request hits cache (0ms)
──────────────────────────────────────────────────────────────
⚡ CACHE HIT — returned 6 products in <1ms (no scrape fired)
   Cache key: a3f91c2e4b8d7...

▶ 3. Concurrent requests — 4 queries across 2 retailers
──────────────────────────────────────────────────────────────
Firing 4 concurrent scrapes...
✓ All 4 completed in 2847ms
  walmart/tide: 5 products (cached: false)
  kroger/chicken: 5 products (cached: false)
  walmart/milk: 6 products (cached: false)
  kroger/tide: 5 products (cached: false)

▶ 4. Circuit breaker — simulate 5 failures to open circuit
──────────────────────────────────────────────────────────────
  Failure 1: state=CLOSED
  Failure 5: state=OPEN
  ✓ Circuit correctly OPEN — fast-fail: Circuit OPEN for retailer=badretailer...
```

---

*Bharanidharan Maheswaran | ASU Computer Science | bmahesw1@asu.edu*
*Prox Software Engineering Intern Technical Assessment — Track A*
