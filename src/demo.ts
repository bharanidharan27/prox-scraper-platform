/**
 * Demo script — shows all features of the Prox Scraper Platform
 * Run: npx ts-node src/demo.ts
 */

import chalk from 'chalk';
import { runJob } from './runner/jobRunner';
import { getJobHistory } from './runner/jobRunner';
import { circuitBreaker } from './controls/circuitBreaker';
import { rateLimiter } from './controls/rateLimiter';
import { spendGuardrail } from './controls/spendGuardrail';
import { cacheStore } from './cache/store';
import { logger } from './utils/logger';

function banner(title: string) {
  const line = '═'.repeat(title.length + 4);
  console.log('');
  console.log(chalk.bold.cyan(`╔${line}╗`));
  console.log(chalk.bold.cyan(`║  ${title}  ║`));
  console.log(chalk.bold.cyan(`╚${line}╝`));
  console.log('');
}

function section(title: string) {
  console.log('');
  console.log(chalk.bold.yellow(`▶ ${title}`));
  console.log(chalk.gray('─'.repeat(60)));
}

async function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

async function main() {
  banner('Prox Scraper Platform — Live Demo');

  // ────────────────────────────────────────────────────────────────────────
  section('1. Basic scrape: Kroger + milk in 90046');
  // ────────────────────────────────────────────────────────────────────────
  const r1 = await runJob({ retailer: 'kroger', zip: '90046', query: 'milk' });
  console.log(chalk.green(`✓ Scraped ${r1.products.length} products in ${r1.duration_ms}ms`));
  r1.products.slice(0, 3).forEach((p) =>
    console.log(`  • ${p.product_name} ${p.size_raw ? `(${p.size_raw})` : ''} — $${p.regular_price}`)
  );

  // ────────────────────────────────────────────────────────────────────────
  section('2. Deduplication — same request hits cache (0ms)');
  // ────────────────────────────────────────────────────────────────────────
  const r2 = await runJob({ retailer: 'kroger', zip: '90046', query: 'milk' });
  if (r2.cached) {
    console.log(chalk.yellow(`⚡ CACHE HIT — returned ${r2.products.length} products in <1ms (no scrape fired)`));
    console.log(chalk.gray(`   Cache key: ${r2.cache_key.slice(0, 24)}...`));
  }

  // ────────────────────────────────────────────────────────────────────────
  section('3. Concurrent requests — 4 queries across 2 retailers');
  // ────────────────────────────────────────────────────────────────────────
  console.log(chalk.gray('Firing 4 concurrent scrapes (tide×walmart, chicken×kroger, milk×walmart, tide×kroger)...'));
  const t0 = Date.now();
  const [r3a, r3b, r3c, r3d] = await Promise.all([
    runJob({ retailer: 'walmart', zip: '10001', query: 'tide' }),
    runJob({ retailer: 'kroger', zip: '90046', query: 'chicken' }),
    runJob({ retailer: 'walmart', zip: '10001', query: 'milk' }),
    runJob({ retailer: 'kroger', zip: '10001', query: 'tide' }),
  ]);
  console.log(chalk.green(`✓ All 4 completed in ${Date.now() - t0}ms`));
  console.log(chalk.gray(`  walmart/tide: ${r3a.products.length} products (cached: ${r3a.cached})`));
  console.log(chalk.gray(`  kroger/chicken: ${r3b.products.length} products (cached: ${r3b.cached})`));
  console.log(chalk.gray(`  walmart/milk: ${r3c.products.length} products (cached: ${r3c.cached})`));
  console.log(chalk.gray(`  kroger/tide: ${r3d.products.length} products (cached: ${r3d.cached})`));

  // ────────────────────────────────────────────────────────────────────────
  section('4. Circuit breaker — simulate 5 failures to open circuit');
  // ────────────────────────────────────────────────────────────────────────
  console.log(chalk.gray('Simulating consecutive failures on "badretailer"...'));
  for (let i = 1; i <= 5; i++) {
    circuitBreaker.onFailure('badretailer');
    const status = circuitBreaker.getStatus()['badretailer'];
    const stateColor = status?.state === 'OPEN' ? chalk.red : chalk.yellow;
    console.log(`  Failure ${i}: state=${stateColor(status?.state ?? 'CLOSED')}`);
  }
  try {
    circuitBreaker.allowRequest('badretailer');
    console.log(chalk.red('  ERROR: Circuit should have been open!'));
  } catch (e) {
    console.log(chalk.green(`  ✓ Circuit correctly OPEN — fast-fail: ${(e as Error).message.slice(0, 60)}...`));
  }

  // ────────────────────────────────────────────────────────────────────────
  section('5. Rate limiter status');
  // ────────────────────────────────────────────────────────────────────────
  const rl = rateLimiter.getStatus();
  Object.entries(rl).forEach(([retailer, state]) => {
    console.log(
      `  ${chalk.cyan(retailer)}: ${state.tokens} tokens remaining in window`
    );
  });

  // ────────────────────────────────────────────────────────────────────────
  section('6. Spend guardrail status (hourly proxy request counts)');
  // ────────────────────────────────────────────────────────────────────────
  const spend = spendGuardrail.getHourlyStats();
  Object.entries(spend).forEach(([retailer, count]) => {
    console.log(`  ${chalk.cyan(retailer)}: ${count} proxy requests this hour`);
  });

  // ────────────────────────────────────────────────────────────────────────
  section('7. Job audit log (last 10 jobs)');
  // ────────────────────────────────────────────────────────────────────────
  const history = getJobHistory(10);
  history.forEach((job) => {
    const statusColor =
      job.status === 'success' ? chalk.green :
      job.status === 'deduped' ? chalk.yellow :
      job.status === 'failed' ? chalk.red : chalk.gray;
    console.log(
      `  ${statusColor(job.status.padEnd(8))} ` +
      `${chalk.cyan(job.retailer.padEnd(10))} ` +
      `"${job.query.padEnd(15)}" ` +
      `${job.cache_hit ? chalk.yellow('CACHED') : chalk.gray('LIVE  ')} ` +
      `${job.result_count != null ? job.result_count + ' results' : ''}`
    );
  });

  // ────────────────────────────────────────────────────────────────────────
  section('8. Cache maintenance — purge expired entries');
  // ────────────────────────────────────────────────────────────────────────
  const purged = cacheStore.purgeExpired();
  console.log(chalk.gray(`  Purged ${purged} expired cache entries`));

  banner('Demo complete ✓');
}

main().catch((err) => {
  logger.error('Demo failed', { error: err.message, stack: err.stack });
  process.exit(1);
});
