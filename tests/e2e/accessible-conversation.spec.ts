import { expect, test, type Browser, type BrowserContext, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

const BASE_URL = process.env.SIGNCONNECT_E2E_BASE_URL || "http://127.0.0.1:3000";

async function newParticipant(browser: Browser): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext({
    baseURL: BASE_URL,
    permissions: ["camera", "microphone"]
  });
  return { context, page: await context.newPage() };
}

async function openWorkspace(page: Page, roomCode?: string): Promise<void> {
  await page.goto(roomCode ? `/?room=${roomCode}` : "/");
  await expect(page.getByRole("note", { name: "Automated fixture capture notice" })).toBeVisible();
}

async function createRoom(page: Page, displayName: string): Promise<string> {
  await openWorkspace(page);
  await page.getByLabel("Display name").fill(displayName);
  await page.getByRole("button", { name: "Start session" }).click();
  await expect(page.getByRole("button", { name: "Session active" })).toBeVisible();
  const roomCode = (await page.locator(".room-identity strong").textContent())?.trim();
  expect(roomCode).toMatch(/^[A-Z2-9]{6}$/);
  return roomCode!;
}

async function joinRoom(page: Page, roomCode: string, displayName: string): Promise<void> {
  await openWorkspace(page, roomCode);
  await page.getByLabel("Display name").fill(displayName);
  await page.getByRole("button", { name: "Join room" }).click();
  await expect(page.getByRole("button", { name: "Session active" })).toBeVisible();
}

async function enableCamera(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Turn camera on" }).click();
  await expect(page.getByRole("button", { name: "Turn camera off" })).toBeEnabled();
}

function conversationEntries(page: Page) {
  return page.getByRole("region", { name: "Live transcript" }).getByRole("article");
}

async function hasLiveRemoteVideo(page: Page): Promise<boolean> {
  return page.getByTestId("remote-video").evaluate((element) => {
    const video = element as HTMLVideoElement;
    const stream = video.srcObject as MediaStream | null;
    return Boolean(stream?.getVideoTracks().some((track) => track.readyState === "live"));
  });
}

test.describe("Accessible typed and video conversation", () => {
  test.describe.configure({ mode: "serial" });
  test.setTimeout(75_000);

  test("shares attributed messages and bounds a long transcript with local clear controls", async ({ browser }) => {
    const host = await newParticipant(browser);
    const guest = await newParticipant(browser);
    try {
      const roomCode = await createRoom(host.page, "Host Message");
      await joinRoom(guest.page, roomCode, "Guest Message");
      await expect(host.page.getByLabel("People in this room").getByRole("listitem")).toHaveCount(2);

      await guest.page.getByLabel("Message the room").fill("Guest response");
      await guest.page.getByRole("button", { name: "Send message" }).click();

      for (let index = 1; index <= 18; index += 1) {
        await host.page.getByLabel("Message the room").fill(`Shared message ${index}`);
        await host.page.getByRole("button", { name: "Send message" }).click();
      }

      await expect(conversationEntries(host.page)).toHaveCount(19);
      await expect(conversationEntries(guest.page)).toHaveCount(19);
      await expect(guest.page.getByRole("region", { name: "Live transcript" })).toContainText("Host Message typed");
      await expect(guest.page.getByText("Shared message 18", { exact: true })).toBeVisible();
      await expect(host.page.getByText("HM", { exact: true }).first()).toBeVisible();
      await expect(host.page.getByText("GM", { exact: true }).first()).toBeVisible();

      const participantTreatments = await host.page.locator("article.caption-entry").evaluateAll((entries) => {
        const hostEntry = entries.find((entry) => entry.textContent?.includes("Shared message 1"));
        const guestEntry = entries.find((entry) => entry.textContent?.includes("Guest response"));
        if (!hostEntry || !guestEntry) return null;
        const hostStyle = getComputedStyle(hostEntry);
        const guestStyle = getComputedStyle(guestEntry);
        return {
          host: `${hostStyle.borderLeftColor}|${hostStyle.backgroundColor}`,
          guest: `${guestStyle.borderLeftColor}|${guestStyle.backgroundColor}`
        };
      });
      expect(participantTreatments).not.toBeNull();
      expect(participantTreatments?.host).not.toBe(participantTreatments?.guest);

      const panelLayout = await host.page.locator(".intelligence-panel").evaluate((panel) => {
        const history = panel.querySelector(".conversation-history");
        const composer = panel.querySelector(".message-composer");
        const recognitionStatus = panel.querySelector(".system-health");
        if (!history || !composer || !recognitionStatus) return null;
        return {
          historyBeforeComposer: Boolean(history.compareDocumentPosition(composer) & Node.DOCUMENT_POSITION_FOLLOWING),
          composerBeforeStatus: Boolean(composer.compareDocumentPosition(recognitionStatus) & Node.DOCUMENT_POSITION_FOLLOWING),
          bottomGap: Math.abs(panel.getBoundingClientRect().bottom - recognitionStatus.getBoundingClientRect().bottom)
        };
      });
      expect(panelLayout).toMatchObject({ historyBeforeComposer: true, composerBeforeStatus: true });
      expect(panelLayout?.bottomGap).toBeLessThanOrEqual(2);

      const scrollMetrics = await host.page.locator(".caption-list").evaluate((element) => ({
        clientHeight: element.clientHeight,
        overflowY: getComputedStyle(element).overflowY,
        scrollHeight: element.scrollHeight
      }));
      expect(scrollMetrics.overflowY).toBe("auto");
      expect(scrollMetrics.scrollHeight).toBeGreaterThan(scrollMetrics.clientHeight);
      await expect.poll(() => host.page.locator(".caption-list").evaluate((element) => (
        element.scrollHeight - element.clientHeight - element.scrollTop
      ))).toBeLessThanOrEqual(2);

      await host.page.locator(".caption-list").evaluate((element) => {
        element.scrollTop = 0;
        element.dispatchEvent(new Event("scroll"));
      });
      await guest.page.getByLabel("Message the room").fill("Unread while reviewing");
      await guest.page.getByRole("button", { name: "Send message" }).click();
      await expect(host.page.getByRole("button", { name: "1 new message. Jump to latest" })).toBeVisible();
      await host.page.getByRole("button", { name: "1 new message. Jump to latest" }).click();
      await expect.poll(() => host.page.locator(".caption-list").evaluate((element) => (
        element.scrollHeight - element.clientHeight - element.scrollTop
      ))).toBeLessThanOrEqual(2);

      await expect(conversationEntries(host.page)).toHaveCount(20);
      await expect(conversationEntries(guest.page)).toHaveCount(20);

      await host.page.getByRole("button", { name: "Clear transcript" }).click();
      await expect(conversationEntries(host.page)).toHaveCount(0);
      await expect(conversationEntries(guest.page)).toHaveCount(20);
    } finally {
      await guest.context.close();
      await host.context.close();
    }
  });

  test("establishes an explicitly accepted peer call, carries remote video, and synchronizes media controls", async ({ browser }) => {
    const host = await newParticipant(browser);
    const guest = await newParticipant(browser);
    try {
      const roomCode = await createRoom(host.page, "Host Video");
      await joinRoom(guest.page, roomCode, "Guest Video");
      await expect(host.page.getByLabel("People in this room").getByRole("listitem")).toHaveCount(2);
      await expect(guest.page.getByLabel("People in this room").getByRole("listitem")).toHaveCount(2);
      await enableCamera(host.page);
      await enableCamera(guest.page);

      await expect(host.page.getByLabel("Call participant").locator("option:checked")).toHaveText("Guest Video");
      await expect(host.page.getByRole("button", { name: "Start call" })).toBeEnabled();
      await host.page.getByRole("button", { name: "Start call" }).click();
      await expect(guest.page.getByRole("button", { name: "Accept call" })).toBeVisible();
      await expect(guest.page.getByText(/accepting shares your active camera/i)).toBeVisible();
      await guest.page.getByRole("button", { name: "Accept call" }).click();

      await expect(host.page.getByLabel("Call status")).toHaveText("Connected", { timeout: 20_000 });
      await expect(guest.page.getByLabel("Call status")).toHaveText("Connected", { timeout: 20_000 });
      await expect.poll(() => hasLiveRemoteVideo(host.page), { timeout: 20_000 }).toBe(true);
      await expect.poll(() => hasLiveRemoteVideo(guest.page), { timeout: 20_000 }).toBe(true);
      const accessibility = await new AxeBuilder({ page: host.page })
        .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"])
        .analyze();
      expect(accessibility.violations).toEqual([]);

      await host.page.getByRole("button", { name: "Mute call microphone" }).click();
      await expect(guest.page.getByLabel("Remote media state")).toContainText("Remote microphone muted");
      await host.page.getByRole("button", { name: "Pause call camera" }).click();
      await expect(guest.page.getByText("Remote camera paused", { exact: true }).first()).toBeVisible();
      await host.page.getByRole("button", { name: "Resume call camera" }).click();
      await expect(guest.page.getByLabel("Remote media state")).toContainText("Remote camera on");

      await host.page.getByRole("button", { name: "End call" }).click();
      await expect(host.page.getByLabel("Call status")).toHaveText("Not in a call");
      await expect(guest.page.getByLabel("Call status")).toHaveText("Not in a call");
      await expect(guest.page.getByTestId("remote-video")).not.toHaveClass(/visible/);
    } finally {
      await guest.context.close();
      await host.context.close();
    }
  });

  test("shows the same completed signed sentence to both meeting participants", async ({ browser }) => {
    const signer = await newParticipant(browser);
    const reader = await newParticipant(browser);
    try {
      const roomCode = await createRoom(signer.page, "Host Signer");
      await joinRoom(reader.page, roomCode, "Guest Reader");
      await expect(signer.page.getByLabel("People in this room").getByRole("listitem")).toHaveCount(2);
      await enableCamera(signer.page);
      await enableCamera(reader.page);

      await signer.page.getByRole("button", { name: "Start call" }).click();
      await expect(reader.page.getByRole("button", { name: "Accept call" })).toBeVisible();
      await reader.page.getByRole("button", { name: "Accept call" }).click();
      await expect(signer.page.getByLabel("Call status")).toHaveText("Connected", { timeout: 20_000 });
      await expect(reader.page.getByLabel("Call status")).toHaveText("Connected", { timeout: 20_000 });

      await signer.page.getByRole("button", { name: "Start recognition" }).click();

      const signerSentence = signer.page.locator("article.sign-entry");
      const readerSentence = reader.page.locator("article.sign-entry");
      await expect(signerSentence).toHaveCount(1, { timeout: 20_000 });
      await expect(readerSentence).toHaveCount(1, { timeout: 20_000 });
      await expect(signerSentence).toContainText("I need help.", { timeout: 20_000 });
      await expect(readerSentence).toContainText("I need help.", { timeout: 20_000 });
      await expect(signerSentence).toContainText("Sentence complete");
      await expect(readerSentence).toContainText("Sentence complete");
      await expect(signerSentence).toContainText("Host Signer (you) signed");
      await expect(readerSentence).toContainText("Host Signer signed");
      await expect(signer.page.getByText("Need", { exact: true })).toHaveCount(0);
      await expect(reader.page.getByText("Need", { exact: true })).toHaveCount(0);

      await reader.page.getByLabel("Message the room").fill("I am here to help.");
      await reader.page.getByRole("button", { name: "Send message" }).click();
      await expect(conversationEntries(signer.page)).toHaveCount(2);
      await expect(conversationEntries(reader.page)).toHaveCount(2);
      await expect(signer.page.getByText("I am here to help.", { exact: true })).toBeVisible();
      await expect(reader.page.getByText("I am here to help.", { exact: true })).toBeVisible();
    } finally {
      await reader.context.close();
      await signer.context.close();
    }
  });
});
