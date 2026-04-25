# Architecture — Prox Scraper Platform

## System Overview

The Prox Scraper Platform is a cost-aware, high-throughput execution framework for running retailer product search scrapers reliably at scale. It handles 5,000 active users × 3 searches/day across 6+ retailers with sub-5-second response targets.

---

## Job Flow Diagram

```
                        ┌─────────────────────────────────────────────┐
                        │            Prox API / Consumer              │
                        │   (mobile app, web frontend, email worker)  │
                        └──────────────────┬──────────────────────────┘
                                           │  ScrapeRequest
                                           │  { retailer, zip, query }
                                           ▼
                        ┌─────────────────────────────────────────────┐
                        │              Job Runner                      │
                        │                                             │
                        │  1. buildCacheKey(retailer:zip:query)       │
                        │           │                                 │
                        │           ▼                                 │
                        │  ┌─────────────────┐                       │
                        │  │   Cache Store   │──── HIT ──────────────┼──► Return cached result
                        │  │  (Redis/SQLite) │                       │    (< 1ms, no proxy used)
                        │  └────────┬────────┘                       │
                        │           │ MISS                            │
                        │           ▼                                 │
                        │  ┌─────────────────┐                       │
                        │  │ Circuit Breaker │──── OPEN ─────────────┼──► Reject (fast-fail)
                        │  │  (per-retailer) │                       │
                        │  └────────┬────────┘                       │
                        │           │ CLOSED / HALF_OPEN              │
                        │           ▼                                 │
                        │  ┌─────────────────┐                       │
                        │  │ Spend Guardrail │──── EXCEEDED ─────────┼──► Reject (budget cap)
                        │  │ (hourly budget) │                       │
                        │  └────────┬────────┘                       │
                        │           │ OK                              │
                        │           ▼                                 │
                        │  ┌─────────────────┐                       │
                        │  │  Rate Limiter   │──── THROTTLED ────────┼──► Wait, then proceed
                        │  │ (token bucket)  │                       │
                        │  └────────┬────────┘                       │
                        │           │                                 │
                        │           ▼                                 │
                        │  ┌─────────────────┐                       │
                        │  │ Concurrency     │  p-limit per retailer │
                        │  │ Queue (p-limit) │  kroger: max 3 slots  │
                        │  └────────┬────────┘  walmart: max 3 slots │
                        │           │                                 │
                        │           ▼                                 │
                        │  ┌─────────────────────────────────────┐   │
                        │  │      Scraper Execution              │   │
                        │  │                                     │   │
                        │  │  pRetry (max 3, exponential backoff)│   │
                        │  │  1s → 2s → 4s (+ jitter)           │   │
                        │  │                                     │   │
                        │  │  spawn: node scrapers/kroger.js     │   │
                        │  │         --zip=... --query=...       │   │
                        │  │  stdout: JSON product array         │   │
                        └──┤                                     ├───┘
                           └────────────┬────────────────────────┘
                                        │
                           ┌────────────┴────────────┐
                           │                         │
                        SUCCESS                   FAILURE
                           │                         │
                           ▼                         ▼
                  ┌─────────────────┐      ┌──────────────────┐
                  │  Cache.set()    │      │ circuit.onFail() │
                  │  TTL=1hr        │      │ Log error        │
                  │  Log success    │      │ Throw to caller  │
                  └─────────────────┘      └──────────────────┘
```

---

## Cron vs Queue vs On-Demand Decision Matrix

| Trigger Type | What it handles | Why |
|---|---|---|
| **Nightly Cron** | Pre-warm top 50 queries per retailer per ZIP | Cache hit rate → cost reduction. "Milk" in 90046 is searched 1,000×/day — scrape it once nightly, serve from cache all day. |
| **Queue (BullMQ/SQS)** | User-triggered searches, cache misses | Async execution, retry handling, back-pressure. Queues prevent thundering herd when many users search the same item simultaneously. |
| **On-Demand (sync)** | Admin invalidation, forced refresh, status checks | Low volume, latency-sensitive operations that don't need queue overhead. |

### Concurrency Model

```
User A: walmart/90046/milk ──┐
User B: walmart/90046/milk ──┼──► SINGLE scrape fires (deduped via cache lock)
User C: walmart/90046/milk ──┘     All 3 users get same result

User D: kroger/10001/tide  ──► Separate queue (different retailer key)
```

In production, an in-flight lock (Redis SETNX with short TTL) prevents the "cache stampede" problem where 100 users trigger 100 identical scrapes in the same second before any result is cached.

---

## Component Architecture

```
prox-scraper-platform/
├── src/
│   ├── runner/
│   │   ├── jobRunner.ts      # Core orchestration (dedup → circuit → rate → concurrency → scrape → cache)
│   │   └── cli.ts            # CLI entry point
│   ├── cache/
│   │   └── store.ts          # TTL cache (SQLite local / Redis prod)
│   ├── controls/
│   │   ├── circuitBreaker.ts # Per-retailer circuit breaker (CLOSED/OPEN/HALF_OPEN)
│   │   ├── rateLimiter.ts    # Token bucket rate limiter per retailer
│   │   └── spendGuardrail.ts # Hourly proxy budget enforcement
│   ├── scraper/
│   │   └── mockScraper.ts    # Simulates real scraper binary (stdout JSON contract)
│   └── utils/
│       ├── types.ts          # Shared TypeScript interfaces
│       ├── config.ts         # Retailer registry & configuration
│       └── logger.ts         # Winston structured logging
├── docs/
│   ├── architecture.md       # This document
│   ├── runbook.md            # Operational guide
│   └── scale-and-cost-strategy.md
└── data/
    └── cache.db              # SQLite (auto-created on first run)
```

---

## Secret Management Strategy

### Local / Development
- Secrets stored in `.env` (gitignored)
- `.env.example` committed with placeholder values
- `dotenv` loads at runtime

### Production
- **AWS Secrets Manager** or **GCP Secret Manager** for all credentials
- Secrets injected as environment variables by the container orchestrator (ECS task definition / Cloud Run job)
- Application code reads from `process.env` — same interface, no code changes between envs
- Secrets are versioned and rotated without redeployment
- IAM roles grant least-privilege access (a Kroger scraper job can only read Kroger secrets)
- Proxy credentials (username/password) rotated monthly, or on leak detection

### Secret Categories
| Secret | Storage | Rotation |
|---|---|---|
| Proxy provider credentials | Secrets Manager | Monthly |
| Retailer API keys (if any) | Secrets Manager | On change |
| Database connection strings | Secrets Manager | On rotation |
| Scraper session cookies | Redis (short TTL) | Per session |

---

## Logging + Monitoring Strategy

### Structured Logging (Winston)
All log entries include: `timestamp`, `level`, `jobId`, `retailer`, `message`, and optional metadata (duration, result_count, error).

Log format is JSON in production for ingestion by:
- **Datadog** or **AWS CloudWatch** for centralized log management
- **Grafana Loki** for cost-effective log storage

### Metrics to Track
| Metric | Alert Threshold | Why |
|---|---|---|
| Cache hit rate | < 60% | Indicates cache misconfiguration or TTL too short |
| Scrape success rate per retailer | < 85% | May indicate anti-bot changes, need proxy rotation |
| p95 response time | > 5s | SLA breach |
| Circuit breaker opens | Any | Immediate retailer health investigation |
| Proxy requests/hour | > 80% of cap | Spend risk, trigger cache warm-up |
| Retry rate | > 20% | Proxy quality degradation |

### Alerting
- Circuit breaker opens → PagerDuty (P1)
- Spend guardrail >90% → Slack alert (P2)
- Scrape success rate <85% for any retailer → Slack alert (P2)
- Nightly preload job failure → PagerDuty (P2)

---

## Failure Isolation Strategy

1. **Per-retailer circuit breakers** — a single failing retailer cannot cascade to others
2. **Per-retailer concurrency limiters** — a slow retailer doesn't starve others of workers
3. **Per-retailer rate limiters** — proxy cost overrun at one retailer doesn't impact others
4. **Scraper processes isolated** — each scraper runs as a separate process; a crash doesn't bring down the runner
5. **Spend guardrail** — hard hourly cap prevents runaway proxy bills from bugs or attacks
6. **Job audit log** — every job is persisted before execution; failures are fully traceable
7. **Retry with jitter** — exponential backoff prevents thundering herd on transient failures

---

## Production Infrastructure (Recommended)

```
                   ┌─────────────────┐
                   │  Load Balancer  │
                   └────────┬────────┘
                            │
              ┌─────────────┴─────────────┐
              │                           │
     ┌────────▼────────┐       ┌──────────▼────────┐
     │   API Service   │       │  Background Worker │
     │  (Express/Hono) │       │  (BullMQ consumer) │
     │  Handles sync   │       │  Handles async     │
     │  on-demand jobs │       │  queue jobs        │
     └────────┬────────┘       └──────────┬─────────┘
              │                           │
              └───────────┬───────────────┘
                          │
             ┌────────────▼────────────┐
             │     Redis Cluster       │
             │  - Job queue (BullMQ)   │
             │  - Cache store          │
             │  - Rate limiter state   │
             │  - Circuit breaker state│
             │  - In-flight locks      │
             └─────────────────────────┘
```

Workers are stateless containers — horizontal scaling by adding more worker instances.
Redis provides shared state so all workers see the same circuit breaker status and cache.
