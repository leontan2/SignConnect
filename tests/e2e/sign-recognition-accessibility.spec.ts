import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Locator, type Page } from "@playwright/test";

async function openWorkspace(page: Page): Promise<void> {
  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1, name: "Accessible team sync" })).toBeVisible();
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

async function tabTo(page: Page, target: Locator, maximumTabs = 12): Promise<void> {
  for (let index = 0; index < maximumTabs; index += 1) {
    await page.keyboard.press("Tab");
    if (await target.evaluate((element) => element === document.activeElement)) return;
  }
  throw new Error("The target control was not reachable in the expected keyboard tab order");
}

test.describe("sign-recognition WCAG 2.2 AA validation", () => {
  test.setTimeout(30_000);

  test("exposes names, roles, descriptions, polite states, keyboard operation, and visible focus", async ({ page }) => {
    await openWorkspace(page);

    const start = page.getByRole("button", { name: "Start recognition" });
    await expect(start).toBeDisabled();
    await expect(start).toHaveAccessibleDescription(/turn on the camera and start a session/i);
    await expect(page.getByRole("region", { name: "Live transcript" })).toBeVisible();
    await expect(page.getByRole("status", { name: "Tracking announcement" })).toHaveAttribute("aria-live", "polite");
    await expect(page.getByRole("status", { name: "Recognition service status" })).toHaveAttribute("aria-live", "polite");
    await expect(page.locator(".caption-list")).toHaveAttribute("aria-live", "polite");

    const camera = page.getByRole("button", { name: "Turn camera on" });
    await tabTo(page, camera);
    const focusStyle = await camera.evaluate((element) => {
      const style = getComputedStyle(element);
      const adjacent = getComputedStyle(element.closest(".video-stage")!);
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
    await expect(page.getByText("Synthetic active gesture")).toBeVisible({ timeout: 15_000 });
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

  test("reflows at 320 CSS pixels and honors reduced motion", async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 720 });
    await page.emulateMedia({ reducedMotion: "reduce" });
    await openWorkspace(page);

    const dimensions = await page.evaluate(() => ({
      clientWidth: document.documentElement.clientWidth,
      scrollWidth: document.documentElement.scrollWidth
    }));
    expect(dimensions.scrollWidth).toBeLessThanOrEqual(dimensions.clientWidth);
    const recognitionBox = await page.getByRole("region", { name: "Live transcript" }).boundingBox();
    expect(recognitionBox).not.toBeNull();
    expect(recognitionBox!.x).toBeGreaterThanOrEqual(0);
    expect(recognitionBox!.x + recognitionBox!.width).toBeLessThanOrEqual(320);

    const transitionDuration = await page.locator(".video-stage video").evaluate((element) =>
      Number.parseFloat(getComputedStyle(element).transitionDuration) * 1000
    );
    expect(transitionDuration).toBeLessThanOrEqual(0.1);
  });

  test("has no automated WCAG A/AA violations in the completed recognition state", async ({ page }) => {
    await openWorkspace(page);
    await enableCameraAndSession(page);
    await page.getByRole("button", { name: "Start recognition" }).click();
    await expect(page.getByText("Synthetic active gesture")).toBeVisible({ timeout: 15_000 });

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
