import { expect, test } from "@playwright/test";

declare global {
  interface Window {
    __signConnectGestureDispatchTimes?: number[];
    __signConnectCaptionRenderTimes?: number[];
  }
}

const WARMUP_CYCLES = 1;
const MEASURED_CYCLES = 20;
const LATENCY_BUDGET_MS = 1_000;
const COMPLETED_GESTURE_FRAME_COUNT = 30;

function nearestRank(values: number[], percentile: number): number {
  if (values.length === 0) throw new Error("Cannot calculate a percentile without samples");
  const sorted = [...values].sort((left, right) => left - right);
  const rank = Math.ceil(percentile * sorted.length);
  return sorted[Math.max(0, rank - 1)];
}

test("@performance renders synthetic caption finals below the nearest-rank p95 budget", async ({ page, browserName }, testInfo) => {
  test.setTimeout(120_000);
  await page.addInitScript(({ completedGestureFrameCount }) => {
    const gestureDispatchTimes: number[] = [];
    const captionRenderTimes: number[] = [];
    const dispatchedFramesByStream = new Map<string, number>();
    let observedCaptionCount = 0;
    const nativeSend = window.WebSocket.prototype.send;
    window.WebSocket.prototype.send = function send(data): void {
      nativeSend.call(this, data);
      if (typeof data !== "string") return;
      try {
        const event = JSON.parse(data) as Record<string, unknown>;
        if (event.type !== "landmark.chunk"
          || typeof event.streamId !== "string"
          || !Array.isArray(event.frames)) {
          return;
        }
        const priorFrameCount = dispatchedFramesByStream.get(event.streamId) ?? 0;
        const nextFrameCount = priorFrameCount + event.frames.length;
        dispatchedFramesByStream.set(event.streamId, nextFrameCount);
        if (priorFrameCount < completedGestureFrameCount
          && nextFrameCount >= completedGestureFrameCount) {
          gestureDispatchTimes.push(performance.now());
        }
      } catch {
        // Non-JSON WebSocket traffic is outside the recognition timing seam.
      }
    };
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
    Object.defineProperty(window, "__signConnectGestureDispatchTimes", {
      configurable: false,
      value: gestureDispatchTimes
    });
    Object.defineProperty(window, "__signConnectCaptionRenderTimes", {
      configurable: false,
      value: captionRenderTimes
    });
  }, { completedGestureFrameCount: COMPLETED_GESTURE_FRAME_COUNT });

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
    await expect.poll(
      () => page.evaluate(() => window.__signConnectGestureDispatchTimes?.length ?? 0),
      { message: `completed gesture ${cycle + 1} was dispatched`, timeout: 10_000 }
    ).toBe(cycle + 1);
    await expect(transcript.getByRole("article")).toHaveCount(cycle + 1, { timeout: 10_000 });
    await expect.poll(
      () => page.evaluate(() => window.__signConnectCaptionRenderTimes?.length ?? 0),
      { message: `caption ${cycle + 1} was rendered`, timeout: 10_000 }
    ).toBe(cycle + 1);
    const timing = await page.evaluate((sampleIndex) => {
      const dispatchTimes = window.__signConnectGestureDispatchTimes ?? [];
      const renderTimes = window.__signConnectCaptionRenderTimes ?? [];
      const dispatchedAt = dispatchTimes[sampleIndex];
      const renderedAt = renderTimes[sampleIndex];
      if (dispatchedAt === undefined || renderedAt === undefined) {
        throw new Error(
          `Missing dispatch/render markers for sample ${sampleIndex + 1}; received ${dispatchTimes.length}/${renderTimes.length}`
        );
      }
      return {
        dispatchedAt,
        renderedAt
      };
    }, cycle);
    const durationMs = timing.renderedAt - timing.dispatchedAt;
    expect(durationMs).toBeGreaterThanOrEqual(0);
    if (cycle >= WARMUP_CYCLES) samples.push(durationMs);

    await page.getByRole("button", { name: "Stop recognition" }).click();
    await expect(page.getByRole("button", { name: "Start recognition" })).toBeEnabled();
  }

  expect(samples).toHaveLength(MEASURED_CYCLES);
  const summary = {
    method: "nearest-rank",
    measurementStart: "completed-gesture-dispatch",
    measurementEnd: "caption-dom-render",
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
