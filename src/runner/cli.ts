#!/usr/bin/env ts-node
/**
 * Prox Scraper Platform — CLI Entry Point
 *
 * Usage:
 *   npx ts-node src/runner/cli.ts --retailer=kroger --zip=90046 --query=milk
 *   npx ts-node src/runner/cli.ts --retailer=walmart --zip=10001 --query="tide pods"
 *   npx ts-node src/runner/cli.ts --retailer=safeway --zip=94102 --query=chicken --json
 */

import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';
import chalk from 'chalk';
import { runJob } from './jobRunner';
import { circuitBreaker } from '../controls/circuitBreaker';
import { rateLimiter } from '../controls/rateLimiter';
import { spendGuardrail } from '../controls/spendGuardrail';
import { logger } from '../utils/logger';

// Handle --status before yargs demands retailer/zip/query
const rawArgs = hideBin(process.argv);
if (rawArgs.includes('--status')) {
  // Lazy import to avoid DB init before needed
  const { circuitBreaker: cb } = require('../controls/circuitBreaker');
  const { rateLimiter: rl } = require('../controls/rateLimiter');
  const { spendGuardrail: sg } = require('../controls/spendGuardrail');
  const chalk2 = require('chalk');
  console.log('');
  console.log(chalk2.bold.cyan('System Status'));
  console.log(chalk2.gray('─'.repeat(50)));
  const cbStatus = cb.getStatus();
  console.log(chalk2.bold('\nCircuit Breakers:'));
  if (Object.keys(cbStatus).length === 0) console.log(chalk2.gray('  (no retailers activated yet)'));
  else Object.entries(cbStatus).forEach(([r, s]: any) => {
    const icon = s.state === 'CLOSED' ? chalk2.green('●') : s.state === 'OPEN' ? chalk2.red('●') : chalk2.yellow('●');
    console.log(`  ${icon} ${r}: ${s.state} (failures: ${s.failures})`);
  });
  const rlStatus = rl.getStatus();
  console.log(chalk2.bold('\nRate Limiters:'));
  if (Object.keys(rlStatus).length === 0) console.log(chalk2.gray('  (no retailers activated yet)'));
  else Object.entries(rlStatus).forEach(([r, s]: any) => {
    console.log(`  ${chalk2.cyan(r)}: ${s.tokens} tokens remaining`);
  });
  const spend = sg.getHourlyStats();
  console.log(chalk2.bold('\nSpend This Hour:'));
  if (Object.keys(spend).length === 0) console.log(chalk2.gray('  (no requests yet)'));
  else Object.entries(spend).forEach(([r, c]: any) => console.log(`  ${chalk2.cyan(r)}: ${c} proxy requests`));
  console.log('');
  process.exit(0);
}

const argv = yargs(rawArgs)
  .option('retailer', {
    alias: 'r',
    type: 'string',
    description: 'Retailer name (kroger, walmart, safeway, target, costco, ralphs)',
    demandOption: true,
  })
  .option('zip', {
    alias: 'z',
    type: 'string',
    description: 'ZIP code for store location context',
    demandOption: true,
  })
  .option('query', {
    alias: 'q',
    type: 'string',
    description: 'Product search query',
    demandOption: true,
  })
  .option('json', {
    type: 'boolean',
    description: 'Output raw JSON (for piping to other tools)',
    default: false,
  })
  .help()
  .parseSync();

async function main() {
  if (argv.status) {
    printStatus();
    return;
  }

  const { retailer, zip, query } = argv;

  if (!argv.json) {
    console.log('');
    console.log(chalk.bold.cyan('╔════════════════════════════════════════╗'));
    console.log(chalk.bold.cyan('║   Prox Scraper Platform — Job Runner   ║'));
    console.log(chalk.bold.cyan('╚════════════════════════════════════════╝'));
    console.log('');
    console.log(chalk.gray(`  Retailer : ${chalk.white(retailer)}`));
    console.log(chalk.gray(`  ZIP      : ${chalk.white(zip)}`));
    console.log(chalk.gray(`  Query    : ${chalk.white(query)}`));
    console.log('');
  }

  try {
    const start = Date.now();
    const result = await runJob({ retailer, zip, query });
    const elapsed = Date.now() - start;

    if (argv.json) {
      console.log(JSON.stringify(result, null, 2));
      return;
    }

    // Human-readable output
    const sourceLabel = result.cached
      ? chalk.yellow('⚡ CACHE HIT')
      : chalk.green('🌐 LIVE SCRAPE');

    console.log(chalk.bold(`Results (${sourceLabel}${chalk.gray(` — ${elapsed}ms`)})`));
    console.log(chalk.gray('─'.repeat(60)));

    result.products.forEach((p, i) => {
      const price = p.sale_price
        ? `${chalk.green('$' + p.sale_price.toFixed(2))} ${chalk.gray.strikethrough('$' + p.regular_price?.toFixed(2))}`
        : p.regular_price
        ? chalk.white('$' + p.regular_price.toFixed(2))
        : chalk.gray('N/A');

      console.log(
        `  ${chalk.cyan(String(i + 1).padStart(2))}. ${chalk.white(p.product_name)}` +
        (p.size_raw ? chalk.gray(` (${p.size_raw})`) : '') +
        `  ${price}`
      );
    });

    console.log('');
    console.log(chalk.gray(`  ${result.products.length} products | cache_key=${result.cache_key.slice(0, 16)}...`));
    console.log('');

  } catch (err) {
    console.error('');
    console.error(chalk.red(`✗ Job failed: ${(err as Error).message}`));
    console.error('');
    process.exit(1);
  }
}

function printStatus() {
  console.log('');
  console.log(chalk.bold.cyan('System Status'));
  console.log(chalk.gray('─'.repeat(50)));

  const cbStatus = circuitBreaker.getStatus();
  console.log(chalk.bold('\nCircuit Breakers:'));
  if (Object.keys(cbStatus).length === 0) {
    console.log(chalk.gray('  (no retailers activated yet)'));
  } else {
    Object.entries(cbStatus).forEach(([retailer, state]) => {
      const icon = state.state === 'CLOSED' ? chalk.green('●') : state.state === 'OPEN' ? chalk.red('●') : chalk.yellow('●');
      console.log(`  ${icon} ${retailer}: ${state.state} (failures: ${state.failures})`);
    });
  }

  const rlStatus = rateLimiter.getStatus();
  console.log(chalk.bold('\nRate Limiters:'));
  if (Object.keys(rlStatus).length === 0) {
    console.log(chalk.gray('  (no retailers activated yet)'));
  } else {
    Object.entries(rlStatus).forEach(([retailer, state]) => {
      console.log(`  ${chalk.cyan(retailer)}: ${state.tokens} tokens remaining (window age: ${Math.round(state.windowAgeMs / 1000)}s)`);
    });
  }

  const spend = spendGuardrail.getHourlyStats();
  console.log(chalk.bold('\nSpend This Hour:'));
  if (Object.keys(spend).length === 0) {
    console.log(chalk.gray('  (no requests yet)'));
  } else {
    Object.entries(spend).forEach(([retailer, count]) => {
      console.log(`  ${chalk.cyan(retailer)}: ${count} proxy requests`);
    });
  }

  console.log('');
}

main().catch((err) => {
  logger.error('Unhandled error in CLI', { error: err.message });
  process.exit(1);
});
