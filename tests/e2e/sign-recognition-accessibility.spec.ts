import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Locator, type Page } from "@playwright/test";

const CANONICAL_CAMERA_STATES = [
  "Camera off",
  "Camera initializing",
  "No person detected",
  "Upper body not fully visible",
  "Left hand missing",
  "Right hand missing",
  "Hands too close to the frame edge",
  "Lighting or tracking quality too poor",
  "Ready to sign",
  "Gesture in progress",
  "Processing",
  "Sign recognized",
  "Sign not recognized"
] as const;

async function openWorkspace(page: Page): Promise<void> {
  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1, name: "Recognition studio" })).toBeVisible();
  await expect(page.getByRole("note", { name: "Automated fixture capture notice" })).toBeVisible();
}

async function enableCameraAndSession(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Turn camera on" }).click();
  await expect(page.getByRole("button", { name: "Turn camera off" })).toBeEnabled();
  await page.getByRole("button", { name: "Start session" }).click();
  await expect(page.getByRole("button", { name: "Session active" })).toBeVisible();
}

function channel(value: number): number {
  const normalized = value / 255;
  return normalized <= 0.04045
    ? normalized / 12.92
    : ((normalized + 0.055) / 1.055) ** 2.4;
}

function luminance(rgb: [number, number, number]): number {
  return 0.2126 * channel(rgb[0]) + 0.7152 * channel(rgb[1]) + 0.0722 * channel(rgb[2]);
}

function contrast(left: [number, number, number], right: [number, number, number]): number {
  const lighter = Math.max(luminance(left), luminance(right));
  const darker = Math.min(luminance(left), luminance(right));
  return (lighter + 0.05) / (darker + 0.05);
}

function parseRgb(value: string): [number, number, number] {
  const channels = value.match(/[\d.]+/g)?.slice(0, 3).map(Number);
  if (!channels || channels.length !== 3) throw new Error(`Could not parse CSS color ${value}`);
  return channels as [number, number, number];
}

async function tabTo(page: Page, target: Locator, maximumTabs = 24): Promise<void> {
  for (let index = 0; index < maximumTabs; index += 1) {
    await page.keyboard.press("Tab");
    if (await target.evaluate((element) => element === document.activeElement)) return;
  }
  throw new Error("The target control was not reachable in the expected keyboard tab order");
}

async function expectWithinViewport(locator: Locator, viewportWidth: number): Promise<void> {
  const box = await locator.boundingBox();
  expect(box).not.toBeNull();
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width).toBeLessThanOrEqual(viewportWidth);
}

async function startAnnouncementCapture(page: Page): Promise<void> {
  await page.evaluate(() => {
    const announcement = document.querySelector('[aria-label="Meeting announcements"]');
    if (!announcement) throw new Error("Meeting announcements live region is missing");
    const messages: string[] = [];
    const recordMessage = (value: string | null | undefined) => {
      const message = value?.trim();
      if (message && messages.at(-1) !== message) messages.push(message);
    };
    new MutationObserver((records) => {
      for (const record of records) {
        if (record.type === "characterData") {
          // Chromium may coalesce multiple live-region writes before this callback.
          // oldValue preserves each intermediate announcement in that batch.
          recordMessage(record.oldValue);
          continue;
        }
        // Removed nodes retain the text that was exposed before a replacement.
        // Added nodes are live references, so read the live region once after the
        // batch instead of accidentally recording their final text out of order.
        for (const node of record.removedNodes) recordMessage(node.textContent);
      }
      recordMessage(announcement.textContent);
    }).observe(announcement, {
      characterData: true,
      characterDataOldValue: true,
      childList: true,
      subtree: true
    });
    (window as typeof window & { __signConnectA11yAnnouncements?: string[] })
      .__signConnectA11yAnnouncements = messages;
  });
}

async function capturedAnnouncements(page: Page): Promise<string[]> {
  return page.evaluate(() => (
    (window as typeof window & { __signConnectA11yAnnouncements?: string[] })
      .__signConnectA11yAnnouncements ?? []
  ));
}

function isCanonicalGuidanceAnnouncement(message: string): boolean {
  return CANONICAL_CAMERA_STATES.some((state) => message.startsWith(`${state}. `));
}

test.describe("sign-recognition WCAG 2.2 AA validation", () => {
  test.setTimeout(30_000);

  test("exposes names, roles, descriptions, polite states, keyboard operation, and visible focus", async ({ page }) => {
    await openWorkspace(page);

    const start = page.getByRole("button", { name: "Start recognition" });
    await expect(start).toBeDisabled();
    await expect(start).toHaveAccessibleDescription(/turn on the camera and start a session/i);
    await expect(page.getByRole("region", { name: "Live transcript" })).toBeVisible();
    const announcement = page.getByRole("status", { name: "Meeting announcements" });
    await expect(announcement).toHaveAttribute("aria-live", "polite");
    await expect(announcement).toHaveAttribute("aria-atomic", "true");
    await expect(page.locator("[aria-live]")).toHaveCount(1);

    const camera = page.getByRole("button", { name: "Turn camera on" });
    await tabTo(page, camera);
    const focusStyle = await camera.evaluate((element) => {
      const style = getComputedStyle(element);
      const adjacent = getComputedStyle(element.closest(".capture-console")!);
      return {
        adjacentBackground: adjacent.backgroundColor,
        outline: style.outlineColor,
        outlineStyle: style.outlineStyle,
        outlineWidth: Number.parseFloat(style.outlineWidth)
      };
    });
    expect(focusStyle.outlineStyle).not.toBe("none");
    expect(focusStyle.outlineWidth).toBeGreaterThanOrEqual(2);
    expect(contrast(parseRgb(focusStyle.outline), parseRgb(focusStyle.adjacentBackground))).toBeGreaterThanOrEqual(3);
    await page.keyboard.press("Enter");
    await expect(page.getByRole("button", { name: "Turn camera off" })).toBeEnabled();
    await page.getByRole("button", { name: "Start session" }).click();
    await expect(page.getByRole("button", { name: "Session active" })).toBeVisible();

    await tabTo(page, start);
    await expect(start).toBeFocused();
    const startFocusStyle = await start.evaluate((element) => {
      const style = getComputedStyle(element);
      return {
        outlineStyle: style.outlineStyle,
        outlineWidth: Number.parseFloat(style.outlineWidth)
      };
    });
    expect(startFocusStyle.outlineStyle).not.toBe("none");
    expect(startFocusStyle.outlineWidth).toBeGreaterThanOrEqual(2);

    await page.keyboard.press("Enter");
    await expect(page.getByRole("button", { name: "Stop recognition" })).toBeVisible();
    await expect(
      page
        .getByRole("region", { name: "Live transcript" })
        .locator("article.caption-entry")
        .getByText("Synthetic active gesture", { exact: true })
    ).toBeVisible({ timeout: 15_000 });
    await expect(page.getByRole("note").filter({ hasText: "Mock integration model" })).toContainText(
      /not validated SGSL recognition/i
    );

    const controls = page.locator("button:visible, a[href]:visible");
    const controlCount = await controls.count();
    expect(controlCount).toBeGreaterThan(0);
    for (let index = 0; index < controlCount; index += 1) {
      const box = await controls.nth(index).boundingBox();
      expect(box, `interactive control ${index} has no rendered box`).not.toBeNull();
      expect(box!.width, `interactive control ${index} is narrower than 24 CSS px`).toBeGreaterThanOrEqual(24);
      expect(box!.height, `interactive control ${index} is shorter than 24 CSS px`).toBeGreaterThanOrEqual(24);
    }
  });

  test("exposes one stable camera-readiness value and announces guidance through one live region", async ({ page }) => {
    await openWorkspace(page);

    const readiness = page.getByLabel("Camera readiness", { exact: true });
    await expect(readiness).toHaveCount(1);
    await expect(readiness).toHaveAttribute("aria-label", "Camera readiness");
    await expect(readiness.locator("strong")).toHaveText("Camera off");
    await expect(readiness.locator("p")).toContainText(/turn on the camera/i);
    await expect(readiness.locator("strong")).toBeVisible();
    await expect(readiness.locator("p")).toBeVisible();
    await expect(readiness).not.toHaveAttribute("aria-live");

    const announcement = page.getByRole("status", { name: "Meeting announcements" });
    await expect(page.locator("[aria-live]")).toHaveCount(1);
    await expect(announcement).toHaveAttribute("aria-live", "polite");
    await expect(announcement).toHaveAttribute("aria-atomic", "true");
    await startAnnouncementCapture(page);

    await enableCameraAndSession(page);
    await expect(readiness).toHaveAttribute("aria-label", "Camera readiness");
    await expect(readiness.locator("strong")).toHaveText("Camera initializing");
    await page.getByRole("button", { name: "Start recognition" }).click();

    await expect.poll(async () => (
      (await capturedAnnouncements(page)).some(isCanonicalGuidanceAnnouncement)
    )).toBe(true);
    await expect(
      page
        .getByRole("region", { name: "Live transcript" })
        .locator("article.caption-entry")
        .getByText("Synthetic active gesture", { exact: true })
    ).toBeVisible({ timeout: 15_000 });
    await expect.poll(async () => (
      (await capturedAnnouncements(page)).some((message) => message.startsWith("Sign recognized. "))
    )).toBe(true);
    const announcedStates = (await capturedAnnouncements(page))
      .filter(isCanonicalGuidanceAnnouncement)
      .map((message) => message.slice(0, message.indexOf(". ")));
    const announcedStateSet = new Set(announcedStates);
    for (const requiredState of [
      "No person detected",
      "Upper body not fully visible",
      "Left hand missing",
      "Right hand missing",
      "Hands too close to the frame edge",
      "Lighting or tracking quality too poor",
      "Ready to sign",
      "Gesture in progress",
      "Processing",
      "Sign recognized"
    ]) {
      expect(announcedStateSet, `${requiredState} was not announced`).toContain(requiredState);
    }
    await expect(page.locator("[aria-live]")).toHaveCount(1);
    await expect(readiness.locator("strong")).toHaveText(new RegExp(`^(${CANONICAL_CAMERA_STATES.join("|")})$`));
    await expect(readiness.locator("p")).not.toHaveText("");
  });

  test("keeps the optional tracking overlay keyboard operable without moving focus", async ({ page }) => {
    await openWorkspace(page);
    await enableCameraAndSession(page);

    const toggle = page.getByRole("button", { name: "Tracking overlay", exact: true });
    const overlay = page.locator("canvas.landmark-overlay");
    await expect(toggle).toHaveCount(1);
    await expect(toggle).toHaveAttribute("aria-pressed", /^(true|false)$/);
    await expect(toggle.locator(".sc-button__label")).toHaveText(/Tracking overlay: (On|Off)/);
    await expect(overlay).toHaveAttribute("aria-hidden", "true");

    const initialPressed = await toggle.getAttribute("aria-pressed");
    await tabTo(page, toggle, 20);
    await expect(toggle).toBeFocused();
    const focusStyle = await toggle.evaluate((element) => {
      const style = getComputedStyle(element);
      return {
        outlineStyle: style.outlineStyle,
        outlineWidth: Number.parseFloat(style.outlineWidth)
      };
    });
    expect(focusStyle.outlineStyle).not.toBe("none");
    expect(focusStyle.outlineWidth).toBeGreaterThanOrEqual(2);

    await page.keyboard.press("Space");
    const nextPressed = initialPressed === "true" ? "false" : "true";
    await expect(toggle).toHaveAttribute("aria-pressed", nextPressed);
    await expect(toggle.locator(".sc-button__label")).toHaveText(
      nextPressed === "true" ? "Tracking overlay: On" : "Tracking overlay: Off"
    );
    await expect(toggle).toBeFocused();
    if (nextPressed === "true") await expect(overlay).toBeVisible();
    else await expect(overlay).toBeHidden();

    await page.keyboard.press("Enter");
    await expect(toggle).toHaveAttribute("aria-pressed", initialPressed!);
    await expect(toggle).toBeFocused();
    await expect(page.getByRole("button", { name: "Start recognition" })).toBeEnabled();
    const readiness = page.getByLabel("Camera readiness", { exact: true });
    await expect(readiness.locator("strong")).toBeVisible();
    await expect(readiness.locator("p")).toBeVisible();
  });

  test("reflows at 320 CSS pixels and honors reduced motion", async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 720 });
    await page.emulateMedia({ reducedMotion: "reduce" });
    await openWorkspace(page);

    const dimensions = await page.evaluate(() => ({
      clientWidth: document.documentElement.clientWidth,
      scrollWidth: document.documentElement.scrollWidth
    }));
    expect(dimensions.scrollWidth).toBeLessThanOrEqual(dimensions.clientWidth);
    await expectWithinViewport(page.getByRole("region", { name: "Live transcript" }), 320);
    await expectWithinViewport(page.getByLabel("Camera readiness", { exact: true }), 320);
    await expectWithinViewport(page.getByRole("button", { name: "Tracking overlay", exact: true }), 320);

    await enableCameraAndSession(page);
    await page.getByRole("button", { name: "Start recognition" }).click();
    await expect(
      page
        .getByRole("region", { name: "Live transcript" })
        .locator("article.caption-entry")
        .getByText("Synthetic active gesture", { exact: true })
    ).toBeVisible({ timeout: 15_000 });

    const completedDimensions = await page.evaluate(() => ({
      clientWidth: document.documentElement.clientWidth,
      scrollWidth: document.documentElement.scrollWidth
    }));
    expect(completedDimensions.scrollWidth).toBeLessThanOrEqual(completedDimensions.clientWidth);
    await expectWithinViewport(page.getByRole("region", { name: "Live transcript" }), 320);
    await expectWithinViewport(page.getByLabel("Camera readiness", { exact: true }), 320);
    await expectWithinViewport(page.getByRole("button", { name: "Tracking overlay", exact: true }), 320);

    const motion = await page
      .locator(".stage-viewport video, .recognition-scan, .caption-entry, .recognition-toggle")
      .evaluateAll((elements) => elements.map((element) => {
        const style = getComputedStyle(element);
        const milliseconds = (value: string) => Math.max(...value.split(",").map((duration) => {
          const trimmed = duration.trim();
          return trimmed.endsWith("ms") ? Number.parseFloat(trimmed) : Number.parseFloat(trimmed) * 1000;
        }));
        return {
          animationDurationMs: milliseconds(style.animationDuration),
          animationIterations: style.animationIterationCount,
          transitionDurationMs: milliseconds(style.transitionDuration)
        };
      }));
    expect(motion).not.toHaveLength(0);
    for (const style of motion) {
      expect(style.animationDurationMs).toBeLessThanOrEqual(0.1);
      expect(style.animationIterations).not.toContain("infinite");
      expect(style.transitionDurationMs).toBeLessThanOrEqual(0.1);
    }
  });

  test("has no automated WCAG A/AA violations in the completed recognition state", async ({ page }) => {
    await openWorkspace(page);
    await enableCameraAndSession(page);
    await page.getByRole("button", { name: "Start recognition" }).click();
    await expect(
      page
        .getByRole("region", { name: "Live transcript" })
        .locator("article.caption-entry")
        .getByText("Synthetic active gesture", { exact: true })
    ).toBeVisible({ timeout: 15_000 });

    const results = await new AxeBuilder({ page })
      .withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"])
      .analyze();
    const violations = results.violations.map((violation) => ({
      id: violation.id,
      impact: violation.impact,
      help: violation.help,
      targets: violation.nodes.slice(0, 5).map((node) => node.target)
    }));
    expect(violations).toEqual([]);
  });
});
