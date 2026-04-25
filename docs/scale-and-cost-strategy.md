# Scale & Cost Strategy

**Prox Scraper Platform — 1-Page Write-Up**

---

## The Numbers

- 5,000 active users × 3 searches/day = **15,000 requests/day**
- 6 retailers, unique {retailer × zip × query} combinations ≪ 15,000 (high repetition)
- Proxy cost: ~$0.001–0.01/request → up to **$150/day unoptimized**
- Target with caching: < $15/day (90%+ cache hit rate)

---

## What Would Be Preloaded Nightly?

A nightly cron job (2 AM UTC, off-peak) preloads the **top 100 {retailer × zip × query} combinations** from the previous day's search volume. These are identified from the `job_log` table:

```sql
SELECT retailer, zip, query, COUNT(*) as searches
FROM job_log WHERE created_at > datetime('now', '-1 day')
GROUP BY retailer, zip, query ORDER BY searches DESC LIMIT 100;
```

Why this works: product prices at grocery retailers change daily at most, so results fresh at 2 AM are accurate for the entire next day. The top 100 combinations cover ~70–80% of daily search volume (Zipf's law — "milk", "chicken", "tide" dominate).

**Preloaded nightly:** staple queries (milk, bread, eggs, chicken, laundry detergent) × top 10 ZIP codes per retailer.

---

## What Would Be Triggered On-Demand?

Any request not covered by the nightly preload — novel queries, rare ZIP codes, or users in new markets. On-demand requests go through the full job runner pipeline: cache check → circuit breaker → rate limiter → scrape → cache.

**On-demand:** tail queries, new user ZIP codes, admin-forced refreshes, A/B test product variants.

---

## How to Prevent 100 Users Scraping "Tide Pods" Simultaneously

Three layers:

1. **TTL Cache** — first scrape writes the result to cache. All subsequent requests for `walmart:90046:tide pods` within the TTL window hit the cache. No duplicate scrapes.

2. **In-flight lock (production)** — Redis `SETNX` with 30-second TTL on the cache key. The first worker that claims the lock fires the scrape. Workers that arrive while the lock is held poll until the result appears. This closes the 300ms "stampede window" between the first cache miss and the result being written.

   ```
   User 1 → cache MISS → acquires lock → scrapes → writes cache → releases lock
   User 2 → cache MISS → lock already held → poll (50ms interval) → cache HIT
   User 3 → same as User 2
   ```

3. **Deduplication in job queue** — BullMQ's `jobId` deduplication rejects identical jobs already in the queue, so at most one scrape fires even if 100 requests arrive before the lock is acquired.

---

## How to Cache Results Efficiently

- **Cache key:** SHA-256 of `retailer:zip:query_normalized` (lowercase, whitespace-collapsed). This makes "Tide Pods", "tide pods", and "  tide  pods  " all hit the same entry.
- **TTL:** 1 hour for most products. 4 hours for non-perishable staples. 15 minutes for "sale price" queries near end-of-week (when sales flip).
- **Cache warming:** top queries preloaded at 2 AM reset the TTL, so cached entries rarely expire during peak hours (9 AM–9 PM).
- **Storage:** SQLite locally. Redis Cluster in production — O(1) GET/SET, native TTL, cluster-wide visibility across all worker instances.
- **Eviction:** LRU eviction policy in Redis. SQLite: scheduled `DELETE WHERE expires_at < ?` every 15 minutes.

---

## How This Scales to 5,000 Users

| Scale Stage | Architecture |
|---|---|
| **Current (demo)** | Single Node process, SQLite, mock scrapers |
| **MVP (< 500 users)** | Single server, Redis cache, real scraper CLIs, 2–3 workers |
| **Growth (500–5,000 users)** | Horizontal worker scaling, BullMQ job queue, Redis Cluster, nightly cron preload |
| **Scale (5,000+ users)** | Regional deployment (US West, US East), retailer-specific worker pools, dedicated proxy pools per retailer |

**Key scaling levers:**
1. Workers are stateless — add more worker pods without code changes
2. Redis provides shared cache and queue state
3. Per-retailer concurrency limits prevent any one retailer from monopolizing compute
4. Nightly preload reduces live scrape volume by 70–80%, so worker count doesn't need to scale linearly with users

**Back-of-envelope:** At 90% cache hit rate, 15,000 daily requests → ~1,500 live scrapes/day → ~62/hour → well within 3 workers × 30 req/min/retailer capacity.

---

## How to Control Search/Proxy/API Costs

| Control | Mechanism | Impact |
|---|---|---|
| **Deduplication** | SHA-256 cache key, in-flight lock | Eliminates redundant scrapes — biggest lever |
| **TTL caching** | 1-hour TTL, nightly preload | Reduces live scrapes by 80–90% |
| **Rate limiting** | Token bucket per retailer | Prevents proxy overuse from bursts |
| **Spend guardrail** | Hourly hard cap with alerting | Stops runaway bills from bugs |
| **Circuit breaker** | Fast-fail on unhealthy retailer | Stops wasting proxy requests on doomed scrapes |
| **Proxy tiering** | Residential proxies only for blocked retailers; datacenter IPs for permissive ones | Residential = 10× more expensive; use sparingly |
| **Batch preloading** | One nightly scrape per popular query | Amortizes cost across all users who would have triggered it individually |
| **Result reuse** | Same result served to all users who searched same item in same ZIP | Linear cost growth capped — adding users doesn't add proportional scrape volume |

**Estimated cost at scale:**
- 1,500 live scrapes/day × $0.005/request (residential proxy) = **$7.50/day**
- vs. $75/day unoptimized (all 15,000 requests hit proxy)
- **90% cost reduction** from caching alone

---

*Author: Bharanidharan Maheswaran — Prox Software Engineering Intern Technical Assessment, Track A*
