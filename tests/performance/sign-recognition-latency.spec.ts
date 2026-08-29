import { expect, test } from "@playwright/test";

declare global {
  interface Window {
    __signConnectCompletionTimes?: number[];
    __signConnectCaptionRenderTimes?: number[];
  }
}

const WARMUP_CYCLES = 1;
const MEASURED_CYCLES = 20;
const LATENCY_BUDGET_MS = 1_000;

function nearestRank(values: number[], percentile: number): number {
  if (values.length === 0) throw new Error("Cannot calculate a percentile without samples");
  const sorted = [...values].sort((left, right) => left - right);
  const rank = Math.ceil(percentile * sorted.length);
  return sorted[Math.max(0, rank - 1)];
}

test("@performance renders synthetic caption finals below the nearest-rank p95 budget", async ({ page, browserName }, testInfo) => {
  test.setTimeout(120_000);
  await page.addInitScript(() => {
    const completionTimes: number[] = [];
    const captionRenderTimes: number[] = [];
    let observedCaptionCount = 0;
    window.addEventListener("signconnect:e2e-fixture-completion", () => {
      completionTimes.push(performance.now());
    });
    const observer = new MutationObserver(() => {
      const captionCount = document.querySelectorAll('[aria-label="Live transcript"] article').length;
      while (observedCaptionCount < captionCount) {
        captionRenderTimes.push(performance.now());
        observedCaptionCount += 1;
      }
    });
    window.addEventListener("DOMContentLoaded", () => {
      observer.observe(document.documentElement, { childList: true, subtree: true });
    }, { once: true });
    Object.defineProperty(window, "__signConnectCompletionTimes", {
      configurable: false,
      value: completionTimes
    });
    Object.defineProperty(window, "__signConnectCaptionRenderTimes", {
      configurable: false,
      value: captionRenderTimes
    });
  });

  await page.goto("/");
  await expect(page.getByTestId("e2e-fixture-capture-notice")).toBeVisible();
  await page.getByRole("button", { name: "Turn camera on" }).click();
  await expect(page.getByRole("button", { name: "Turn camera off" })).toBeEnabled();
  await page.getByRole("button", { name: "Start session" }).click();
  await expect(page.getByRole("button", { name: "Session active" })).toBeVisible();

  const samples: number[] = [];
  const totalCycles = WARMUP_CYCLES + MEASURED_CYCLES;
  const transcript = page.getByRole("region", { name: "Live transcript" });
  for (let cycle = 0; cycle < totalCycles; cycle += 1) {
    await page.getByRole("button", { name: "Start recognition" }).click();
    await expect(transcript.getByRole("article")).toHaveCount(cycle + 1, { timeout: 10_000 });
    const timing = await page.evaluate((expectedCompletions) => {
      const completionTimes = window.__signConnectCompletionTimes ?? [];
      const renderTimes = window.__signConnectCaptionRenderTimes ?? [];
      if (completionTimes.length !== expectedCompletions || renderTimes.length !== expectedCompletions) {
        throw new Error(
          `Expected ${expectedCompletions} completion/render markers, received ${completionTimes.length}/${renderTimes.length}`
        );
      }
      return {
        completionAt: completionTimes.at(-1)!,
        renderedAt: renderTimes.at(-1)!
      };
    }, cycle + 1);
    const durationMs = timing.renderedAt - timing.completionAt;
    expect(durationMs).toBeGreaterThanOrEqual(0);
    if (cycle >= WARMUP_CYCLES) samples.push(durationMs);

    await page.getByRole("button", { name: "Stop recognition" }).click();
    await expect(page.getByRole("button", { name: "Start recognition" })).toBeEnabled();
  }

  expect(samples).toHaveLength(MEASURED_CYCLES);
  const summary = {
    method: "nearest-rank",
    percentile: 95,
    sampleCount: samples.length,
    warmupCycles: WARMUP_CYCLES,
    p50Ms: Number(nearestRank(samples, 0.5).toFixed(2)),
    p95Ms: Number(nearestRank(samples, 0.95).toFixed(2)),
    minimumMs: Number(Math.min(...samples).toFixed(2)),
    maximumMs: Number(Math.max(...samples).toFixed(2)),
    budgetMs: LATENCY_BUDGET_MS,
    browser: browserName,
    project: testInfo.project.name,
    platform: process.platform
  };
  await testInfo.attach("sign-recognition-latency-summary", {
    body: Buffer.from(JSON.stringify(summary, null, 2)),
    contentType: "application/json"
  });
  console.log(`Sign-recognition latency summary: ${JSON.stringify(summary)}`);
  expect(summary.p95Ms, JSON.stringify(summary)).toBeLessThan(LATENCY_BUDGET_MS);
});
