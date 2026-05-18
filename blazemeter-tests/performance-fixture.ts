import { test as base, expect } from '@playwright/test';
import { CDPSession } from 'playwright';
import * as fs from 'fs';
import * as path from 'path';

// Flattened structure designed explicitly for table formats like CSV
export interface PerformanceMetrics {
  timestamp: string;
  testName: string;
  url: string;
  LCP_ms: number | string;
  INP_ms: number | string;
  CLS: number | string;
  FCP_ms: number | string;
  TTFB_ms: number | string;
  requestCount: number;
  totalPageSizeMB: number;
  dnsLookupTimeMS: number;
  documentCompleteTimeMS: number;
}

type MyFixtures = {
  performanceTracker: {
    start: () => Promise<void>;
    stop: (testInfo: any) => Promise<PerformanceMetrics>;
  };
};

export const test = base.extend<MyFixtures>({
  performanceTracker: async ({ page }, use) => {
    const vitals: Record<string, number> = {};
    let requestCount = 0;
    let totalSizeInBytes = 0;
    let cdpSession: CDPSession;

    // Listeners and Injectors remain the same
    await page.exposeFunction('onWebVitalsMetric', (metric: { name: string; value: number }) => {
      vitals[metric.name] = metric.value;
    });

    const responseListener = async (response) => {
      requestCount++;
      const headers = await response.allHeaders();
      if (headers['content-length']) {
        totalSizeInBytes += parseInt(headers['content-length'], 10);
      }
    };

    const tracker = {
      start: async () => {
        page.on('response', responseListener);

        await page.addInitScript(() => {
          const script = document.createElement('script');
          script.src = 'https://unpkg.com/web-vitals@4/dist/web-vitals.attribution.iife.js';
          script.onload = () => {
            // @ts-ignore
            webVitals.onLCP(window.onWebVitalsMetric);
            // @ts-ignore
            webVitals.onINP(window.onWebVitalsMetric);
            // @ts-ignore
            webVitals.onCLS(window.onWebVitalsMetric);
            // @ts-ignore
            webVitals.onFCP(window.onWebVitalsMetric);
            // @ts-ignore
            webVitals.onTTFB(window.onWebVitalsMetric);
          };
          document.head.appendChild(script);
        });

        cdpSession = await page.context().newCDPSession(page);
        await cdpSession.send('Performance.enable');
      },

      stop: async (testInfo: any): Promise<PerformanceMetrics> => {
        page.off('response', responseListener);

        const browserTimings = await page.evaluate(() => {
          const [timing] = performance.getEntriesByType('navigation') as any[];
          return timing ? {
            dnsLookupTime: timing.domainLookupEnd - timing.domainLookupStart,
            documentCompleteTime: timing.domComplete
          } : { dnsLookupTime: 0, documentCompleteTime: 0 };
        });

        // Construct flat row object
        const metrics: PerformanceMetrics = {
          timestamp: new Date().toISOString(),
          testName: testInfo.title,
          url: page.url(),
          LCP_ms: vitals.LCP ?? 'N/A',
          INP_ms: vitals.INP ?? 'N/A',
          CLS: vitals.CLS ?? 'N/A',
          FCP_ms: vitals.FCP ?? 'N/A',
          TTFB_ms: vitals.TTFB ?? 'N/A',
          requestCount,
          totalPageSizeMB: parseFloat((totalSizeInBytes / 1024 / 1024).toFixed(2)),
          dnsLookupTimeMS: browserTimings.dnsLookupTime,
          documentCompleteTimeMS: browserTimings.documentCompleteTime
        };

        // --- CSV Generation Engine ---
        const targetDir = path.join(process.cwd(), 'performance-results');
        const csvPath = path.join(targetDir, 'web-vitals-report.csv');

        // Create the results folder if missing
        if (!fs.existsSync(targetDir)) {
          fs.mkdirSync(targetDir, { recursive: true });
        }

        const keys = Object.keys(metrics) as (keyof PerformanceMetrics)[];
        
        // Ensure values containing commas are safely wrapped in double quotes
        const csvRow = keys.map(key => {
          const value = metrics[key];
          if (typeof value === 'string' && value.includes(',')) {
            return `"${value.replace(/"/g, '""')}"`;
          }
          return value;
        }).join(',');

        if (!fs.existsSync(csvPath)) {
          // If file doesn't exist, build schema head + append initial row data
          const csvHeader = keys.join(',');
          fs.writeFileSync(csvPath, `${csvHeader}\n${csvRow}\n`, 'utf8');
        } else {
          // File exists: simply stream append the row to prevent file overrides
          fs.appendFileSync(csvPath, `${csvRow}\n`, 'utf8');
        }

        return metrics;
      }
    };

    await use(tracker);
  },
});

export { expect };
