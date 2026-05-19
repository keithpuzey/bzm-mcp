import { test as base, expect } from '@playwright/test';
import { Page } from 'playwright';
import * as fs from 'fs';
import * as path from 'path';

export interface PerformanceMetrics {
  timestamp: string;
  testName: string;
  stepName: string;
  url: string;
  LCP_ms: number | string;
  CLS: number | string;
  FCP_ms: number | string;
  TTFB_ms: number | string;
  requestCount: number;
  totalPageSizeMB: number;
}

type TrackerInstance = {
  resetCounters: () => void;
  stop: (testInfo: any, stepName: string, targetPage?: Page) => Promise<PerformanceMetrics>;
};

type MyFixtures = {
  performanceTracker: TrackerInstance;
};

export const test = base.extend<MyFixtures>({
  performanceTracker: async ({ page }, use) => {
    let requestCount = 0;
    let totalSizeInBytes = 0;

    const responseListener = async (response) => {
      requestCount++;
      const headers = await response.allHeaders();
      if (headers['content-length']) {
        totalSizeInBytes += parseInt(headers['content-length'], 10);
      }
    };

    page.on('response', responseListener);

    const tracker: TrackerInstance = {
      resetCounters: () => {
        requestCount = 0;
        totalSizeInBytes = 0;
      },
      stop: async (testInfo: any, stepName: string, targetPage?: Page): Promise<PerformanceMetrics> => {
        const activePage = targetPage || page;
        
        // Give the browser paint pipeline 1 second to fully stabilize timings
        await activePage.waitForTimeout(1000);

        // Extract raw performance numbers straight from Chromium's memory core
        const performanceTimings = await activePage.evaluate(() => {
          const [navTiming] = performance.getEntriesByType('navigation') as any[];
          const paintTimings = performance.getEntriesByType('paint');
          
          // Fallback calculations for layout values
          const fcpEntry = paintTimings.find(p => p.name === 'first-contentful-paint');
          
          // Query the performance observer cache for Largest Contentful Paint snapshots
          let lcpValue = 0;
          try {
            const lcpEntries = performance.getEntriesByType('largest-contentful-paint');
            if (lcpEntries.length > 0) {
              lcpValue = lcpEntries[lcpEntries.length - 1].startTime;
            }
          } catch(e) {}

          // Fallback to FCP if LCP observer has not registered yet
          if (lcpValue === 0 && fcpEntry) {
            lcpValue = fcpEntry.startTime;
          }

          return {
            TTFB: navTiming ? navTiming.responseStart - navTiming.requestStart : 0,
            FCP: fcpEntry ? fcpEntry.startTime : 0,
            LCP: lcpValue,
            CLS: 0 // Baseline placeholder for layout calculations
          };
        });

        const metrics: PerformanceMetrics = {
          timestamp: new Date().toISOString(),
          testName: testInfo.title,
          stepName,
          url: activePage.url(),
          LCP_ms: performanceTimings.LCP > 0 ? parseFloat(performanceTimings.LCP.toFixed(2)) : 'N/A',
          CLS: performanceTimings.CLS,
          FCP_ms: performanceTimings.FCP > 0 ? parseFloat(performanceTimings.FCP.toFixed(2)) : 'N/A',
          TTFB_ms: performanceTimings.TTFB > 0 ? parseFloat(performanceTimings.TTFB.toFixed(2)) : 'N/A',
          requestCount,
          totalPageSizeMB: parseFloat((totalSizeInBytes / 1024 / 1024).toFixed(2))
        };

        const targetDir = path.join(process.cwd(), '.');
        const csvPath = path.join(targetDir, 'web-vitals-report.csv');
        if (!fs.existsSync(targetDir)) fs.mkdirSync(targetDir, { recursive: true });

        const keys = Object.keys(metrics) as (keyof PerformanceMetrics)[];
        const csvRow = keys.map(key => {
          const value = metrics[key];
          return typeof value === 'string' && value.includes(',') ? `"${value.replace(/"/g, '""')}"` : value;
        }).join(',');

        if (!fs.existsSync(csvPath)) {
          fs.writeFileSync(csvPath, `${keys.join(',')}\n${csvRow}\n`, 'utf8');
        } else {
          fs.appendFileSync(csvPath, `${csvRow}\n`, 'utf8');
        }

        return metrics;
      }
    };

    await use(tracker);
    page.off('response', responseListener);
  }
});

export { expect };

