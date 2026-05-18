// Important: Import 'test' from your custom library file, not the default playwright package
import { test, expect } from './performance-fixture';

test('Benchmark homepage performance', async ({ page, performanceTracker }) => {
  // 1. Tell the library to start listening
  await performanceTracker.start();

  // 2. Perform your standard user flow
  await page.goto('https://example.com');
  await page.click('#hero-cta-button'); // Interacting helps capture INP / CLS
  await page.waitForLoadState('networkidle');

  // 3. Stop the tracker and get your structured data back
  const metrics = await performanceTracker.stop();

import { test, expect } from './performance-fixture';

test('Verify Landing Page Performance', async ({ page, performanceTracker }, testInfo) => {
  await performanceTracker.start();

  await page.goto('https://example.com');
  await page.waitForLoadState('networkidle');

  // Pass testInfo context so the CSV logging engine tracks the exact test title automatically
  await performanceTracker.stop(testInfo);
});



  // 4. Print or Save the results (can be pushed to Datadog, InfluxDB, etc.)
  console.log('Test Metrics Summary:', JSON.stringify(metrics, null, 2));

  // 5. Enforce SLA / Budgets directly in your test assertion block
  expect(metrics.vitals.LCP).toBeLessThan(2500); // LCP must be under 2.5s
  expect(metrics.network.totalPageSizeMB).toBeLessThan(3.5); // Page bundle size check
  expect(metrics.network.requestCount).toBeLessThan(50); // Keep HTTP requests minimal
});
