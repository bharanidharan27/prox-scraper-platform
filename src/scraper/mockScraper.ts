/**
 * Mock Scraper CLI — simulates a real retailer scraper
 *
 * In production, each retailer has its own scraper binary (Node or Python).
 * The job runner invokes them as child processes via spawn/exec.
 *
 * This mock:
 *   - Accepts { retailer, zip, query } via CLI args
 *   - Simulates realistic latency (500ms–3s)
 *   - Generates realistic product data
 *   - Simulates failure modes (10% random failure, configurable)
 *   - Outputs JSON to stdout (standard scraper contract)
 *
 * The job runner reads stdout and parses the JSON result.
 * This decouples the runner from scraper implementation details.
 */

import { ProductResult, ScrapeResult } from '../utils/types';

// Configurable failure rate via env (used in integration tests)
const FAILURE_RATE = parseFloat(process.env.MOCK_FAILURE_RATE || '0.10');
const SLOW_RATE = parseFloat(process.env.MOCK_SLOW_RATE || '0.15');

const PRODUCT_TEMPLATES: Record<string, Partial<ProductResult>[]> = {
  milk: [
    { product_name: 'Kroger Whole Milk', size_raw: '1 gallon', regular_price: 3.29, image_url: 'https://images.example.com/milk-whole.jpg' },
    { product_name: 'Organic Valley Whole Milk', size_raw: '1/2 gallon', regular_price: 4.99, sale_price: 3.99 },
    { product_name: "Horizon Organic 2% Milk", size_raw: '1 gallon', regular_price: 6.49 },
    { product_name: 'Fairlife Ultra-Filtered Whole Milk', size_raw: '52 fl oz', regular_price: 5.99 },
    { product_name: "Lactaid Whole Milk", size_raw: '1/2 gallon', regular_price: 5.49, sale_price: 4.49 },
    { product_name: 'Store Brand 2% Milk', size_raw: '1 gallon', regular_price: 2.89, unit_price: '$0.023/fl oz' },
  ],
  tide: [
    { product_name: 'Tide Original Liquid Detergent', size_raw: '64 fl oz', regular_price: 11.99, sale_price: 8.99 },
    { product_name: 'Tide Pods 3-in-1', size_raw: '42 count', regular_price: 14.99 },
    { product_name: 'Tide Free & Gentle', size_raw: '92 fl oz', regular_price: 15.99, sale_price: 12.49 },
    { product_name: 'Tide HE Turbo Clean', size_raw: '100 fl oz', regular_price: 13.99 },
    { product_name: 'Tide Plus Downy', size_raw: '64 fl oz', regular_price: 12.99, sale_price: 9.99 },
  ],
  chicken: [
    { product_name: 'Boneless Skinless Chicken Breasts', size_raw: '3 lb', regular_price: 8.97, unit_price: '$2.99/lb' },
    { product_name: 'Organic Chicken Thighs', size_raw: '2.5 lb', regular_price: 9.99, sale_price: 7.99, unit_price: '$3.20/lb' },
    { product_name: 'Rotisserie Chicken', size_raw: '2 lb avg', regular_price: 7.99 },
    { product_name: 'Chicken Drumsticks Family Pack', size_raw: '5 lb', regular_price: 7.45, unit_price: '$1.49/lb' },
    { product_name: 'Air-Chilled Chicken Breasts', size_raw: '1.5 lb', regular_price: 6.99, sale_price: 5.49 },
  ],
};

function generateProducts(retailer: string, zip: string, query: string): ProductResult[] {
  const key = query.toLowerCase().split(' ')[0];
  const templates = PRODUCT_TEMPLATES[key] || [
    { product_name: `${retailer} ${query}`, size_raw: '1 unit', regular_price: 4.99 },
    { product_name: `Generic ${query}`, size_raw: '2 pack', regular_price: 7.99 },
    { product_name: `Premium ${query}`, size_raw: 'Large', regular_price: 12.99 },
  ];

  const now = new Date().toISOString();

  return templates.map((t, i) => ({
    product_name: t.product_name || `${query} Product ${i + 1}`,
    size_raw: t.size_raw || null,
    regular_price: t.regular_price || null,
    sale_price: t.sale_price || null,
    unit_price: t.unit_price || null,
    product_url: `https://www.${retailer}.com/p/${query.replace(/\s/g, '-').toLowerCase()}-${i + 1}`,
    image_url: t.image_url || `https://images.${retailer}.com/${query.replace(/\s/g, '_')}_${i + 1}.jpg`,
    retailer,
    scraped_at: now,
  }));
}

export async function runMockScraper(
  retailer: string,
  zip: string,
  query: string
): Promise<ScrapeResult> {
  // Simulate realistic network latency
  const basLatency = SLOW_RATE > Math.random() ? 2500 : 500;
  const latency = basLatency + Math.random() * 1000;
  await new Promise((r) => setTimeout(r, latency));

  // Simulate random scraper failures
  if (Math.random() < FAILURE_RATE) {
    throw new Error(
      `Scraper error for retailer=${retailer}: ` +
      ['Connection timeout', 'CAPTCHA encountered', 'Rate limited by retailer', '503 Service Unavailable'][
        Math.floor(Math.random() * 4)
      ]
    );
  }

  const products = generateProducts(retailer, zip, query);
  const start = Date.now() - latency;

  return {
    request: { retailer, zip, query },
    products,
    cached: false,
    cache_key: '',
    duration_ms: Math.round(latency),
    scraped_at: new Date().toISOString(),
  };
}
