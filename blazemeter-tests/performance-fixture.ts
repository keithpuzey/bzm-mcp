import { test as base, expect } from '@playwright/test';
import { CDPSession } from 'playwright';

// Define the shape of the metrics object we want to return
export interface PerformanceMetrics {
  vitals: {
    LCP?: number;
    INP?: number;
    CLS?: number;
    FCP?: number;
    TTFB?: number;
  };
  network: {
    requestCount: number;
    totalPageSizeMB: number;
    dnsLookupTimeMS: number;
  };
  timing: {
    documentCompleteTimeMS: number;
  };
}

// Extend the base test type to include our custom fixture
type MyFixtures = {
  performanceTracker: {
    start: () => Promise<void>;
    stop: () => Promise<PerformanceMetrics>;
  };
};

export const test = base.extend<MyFixtures>({
  performanceTracker: async ({ page }, use) => {
    const vitals: Record<string, number> = {};
    let requestCount = 0;
    let totalSizeInBytes = 0;
    let cdpSession: CDPSession;

    // 1. Expose function for Web Vitals
    await page.exposeFunction('onWebVitalsMetric', (metric: { name: string; value: number }) => {
      vitals[metric.name] = metric.value;
    });

    // 2. Setup network listeners
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

        // Inject the web-vitals monitoring library
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

        // Start CDP session for backend/engine tracking
        cdpSession = await page.context().newCDPSession(page);
        await cdpSession.send('Performance.enable');
      },

      stop: async (): Promise<PerformanceMetrics> => {
        // Remove network listener to prevent memory leaks
        page.off('response', responseListener);

        // Fetch document complete and DNS info from the browser context
        const browserTimings = await page.evaluate(() => {
          const [timing] = performance.getEntriesByType('navigation') as any[];
          return timing ? {
            dnsLookupTime: timing.domainLookupEnd - timing.domainLookupStart,
            documentCompleteTime: timing.domComplete
          } : { dnsLookupTime: 0, documentCompleteTime: 0 };
        });

        return {
          vitals,
          network: {
            requestCount,
            totalPageSizeMB: parseFloat((totalSizeInBytes / 1024 / 1024).toFixed(2)),
            dnsLookupTimeMS: browserTimings.dnsLookupTime,
          },
          timing: {
            documentCompleteTimeMS: browserTimings.documentCompleteTime
          }
        };
      }
    };

    // Pass the fixture to the test
    await use(tracker);
  },
});

export { expect };
