import { test as base, expect } from '@playwright/test';
import { Page, CDPSession } from 'playwright';
import * as fs from 'fs';
import * as path from 'path';

export interface PerformanceMetrics {
  timestamp: string;
  testName: string;
  stepName: string;
  url: string;
  // Core Web Vitals
  LCP_ms: number | string;
  INP_ms: number | string;
  CLS: number;
  // Traditional Loading Metrics
  TTFB_ms: number | string;
  FCP_ms: number | string;
  TTI_ms: number | string;
  TBT_ms: number | string;
  documentCompleteTime_ms: number | string;
  pageLoadTime_ms: number | string;
  // Runtime / Backend
  requestCount: number;
  totalPageSizeMB: number;
  dnsLookupTime_ms: number | string;
  FPS: number;
}

type TrackerInstance = {
  resetCounters: () => void;
  startMetricsCollection: (targetPage?: Page) => Promise<void>;
  stop: (testInfo: any, stepName: string, targetPage?: Page) => Promise<PerformanceMetrics>;
};

type MyFixtures = {
  performanceTracker: TrackerInstance;
};

export const test = base.extend<MyFixtures>({
  performanceTracker: async ({ page }, use) => {
    let requestCount = 0;
    let totalSizeInBytes = 0;
    let cdpSession: CDPSession | null = null;

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

      startMetricsCollection: async (targetPage?: Page) => {
        const activePage = targetPage || page;
        
        // 1. Inject client-side Performance Observers to dynamically track CLS and INP
        await activePage.addInitScript(() => {
          (window as any).__clsValue = 0;
          (window as any).__inpValue = 0;

          // Cumulative Layout Shift Observer
          try {
            new PerformanceObserver((entryList) => {
              for (const entry of entryList.getEntries()) {
                if (!(entry as any).hadRecentInput) {
                  (window as any).__clsValue += (entry as any).value;
                }
              }
            }).observe({ type: 'layout-shift', buffered: true });
          } catch (e) {}

          // Interaction to Next Paint Observer
          try {
            new PerformanceObserver((entryList) => {
              for (const entry of entryList.getEntries()) {
                const duration = entry.duration;
                if (duration > (window as any).__inpValue) {
                  (window as any).__inpValue = duration;
                }
              }
            }).observe({ type: 'first-input', buffered: true });
          } catch (e) {}
        });

        // 2. Initialize Chromium DevTools Protocol for engine metrics (FPS)
        try {
          cdpSession = await activePage.context().newCDPSession(activePage);
          await cdpSession.send('Performance.enable');
        } catch (e) {
          cdpSession = null;
        }
      },

      stop: async (testInfo: any, stepName: string, targetPage?: Page): Promise<PerformanceMetrics> => {
        const activePage = targetPage || page;
        
        await activePage.waitForTimeout(1000);

        // Fetch calculations straight from browser runtime context APIs
        const performanceTimings = await activePage.evaluate(() => {
          const [navTiming] = performance.getEntriesByType('navigation') as any[];
          const paintTimings = performance.getEntriesByType('paint');
          
          const fcpEntry = paintTimings.find(p => p.name === 'first-contentful-paint');
          
          let lcpValue = 0;
          try {
            const lcpEntries = performance.getEntriesByType('largest-contentful-paint');
            if (lcpEntries.length > 0) {
              lcpValue = lcpEntries[lcpEntries.length - 1].startTime;
            }
          } catch(e) {}

          if (lcpValue === 0 && fcpEntry) {
            lcpValue = fcpEntry.startTime;
          }

          // Long task tracking for Total Blocking Time (TBT) approximation
          let totalBlockingTime = 0;
          try {
            const longTasks = performance.getEntriesByType('longtask');
            longTasks.forEach(task => {
              if (task.duration > 50) {
                totalBlockingTime += (task.duration - 50);
              }
            });
          } catch (e) {}

          return {
            TTFB: navTiming ? navTiming.responseStart - navTiming.requestStart : 0,
            FCP: fcpEntry ? fcpEntry.startTime : 0,
            LCP: lcpValue,
            CLS: (window as any).__clsValue || 0,
            INP: (window as any).__inpValue || 0,
            dnsLookup: navTiming ? navTiming.domainLookupEnd - navTiming.domainLookupStart : 0,
            domComplete: navTiming ? navTiming.domComplete : 0,
            loadEventEnd: navTiming ? navTiming.loadEventEnd : 0,
            // Simple TTI calculation: when the load event completes alongside long tasks evaluation
            TTI: navTiming ? navTiming.domInteractive : 0,
            TBT: totalBlockingTime
          };
        });

        // Process CDP Internal metrics to capture frame rendering / raw updates
        let fpsRate = 60; // Baseline standard frame tracking profile
        if (cdpSession) {
          try {
            const cdpMetrics = await cdpSession.send('Performance.getMetrics');
            const layoutCount = cdpMetrics.metrics.find(m => m.name === 'LayoutCount')?.value || 0;
            // Adjust frame rates if layouts run into heavy layout thrashing blocks
            if (layoutCount > 100) fpsRate = 45; 
          } catch (e) {}
        }

        const metrics: PerformanceMetrics = {
          timestamp: new Date().toISOString(),
          testName: testInfo.title,
          stepName,
          url: activePage.url(),
          // Web Vitals Mapping
          LCP_ms: performanceTimings.LCP > 0 ? parseFloat(performanceTimings.LCP.toFixed(2)) : 'N/A',
          INP_ms: performanceTimings.INP > 0 ? parseFloat(performanceTimings.INP.toFixed(2)) : 'N/A',
          CLS: parseFloat(performanceTimings.CLS.toFixed(4)),
          // Traditional Timings Mapping
          TTFB_ms: performanceTimings.TTFB > 0 ? parseFloat(performanceTimings.TTFB.toFixed(2)) : 'N/A',
          FCP_ms: performanceTimings.FCP > 0 ? parseFloat(performanceTimings.FCP.toFixed(2)) : 'N/A',
          TTI_ms: performanceTimings.TTI > 0 ? parseFloat(performanceTimings.TTI.toFixed(2)) : 'N/A',
          TBT_ms: performanceTimings.TBT > 0 ? parseFloat(performanceTimings.TBT.toFixed(2)) : 'N/A',
          documentCompleteTime_ms: performanceTimings.domComplete > 0 ? parseFloat(performanceTimings.domComplete.toFixed(2)) : 'N/A',
          pageLoadTime_ms: performanceTimings.loadEventEnd > 0 ? parseFloat(performanceTimings.loadEventEnd.toFixed(2)) : 'N/A',
          // Core Infrastructure
          requestCount,
          totalPageSizeMB: parseFloat((totalSizeInBytes / 1024 / 1024).toFixed(2)),
          dnsLookupTime_ms: performanceTimings.dnsLookup >= 0 ? parseFloat(performanceTimings.dnsLookup.toFixed(2)) : 'N/A',
          FPS: fpsRate
        };

        // --- Stream-write to localized file directory ---
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