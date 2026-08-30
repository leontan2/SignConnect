import {
  expect,
  test,
  type APIRequestContext,
  type Browser,
  type BrowserContext,
  type Page
} from "@playwright/test";

declare global {
  interface Window {
    __signConnectReliableRoomSockets?: WebSocket[];
  }
}

type RoomEvent = {
  captionId?: string;
  meetingId?: string;
  sequence?: number;
  streamId?: string;
  text?: string;
  type: string;
};

const BASE_URL = process.env.SIGNCONNECT_E2E_BASE_URL || "http://127.0.0.1:3000";
const CONTROL_URL = process.env.SIGNCONNECT_E2E_CONTROL_URL;
const CONTROL_TOKEN = process.env.SIGNCONNECT_E2E_CONTROL_TOKEN;
const PUBLIC_ROOM_EVENT_TYPES = new Set([
  "caption.final",
  "participant.joined",
  "participant.left",
  "participant.updated",
  "room.joined",
  "room.snapshot",
  "signer.denied",
  "signer.granted",
  "signer.released"
]);
const ORDERED_PUBLIC_ROOM_EVENT_TYPES = new Set([
  "caption.final",
  "participant.joined",
  "participant.left",
  "participant.updated",
  "room.snapshot",
  "signer.granted",
  "signer.released"
]);

function collectRoomEvents(page: Page): RoomEvent[] {
  const events: RoomEvent[] = [];
  page.on("websocket", (socket) => {
    socket.on("framereceived", ({ payload }) => {
      try {
        const parsed = JSON.parse(payload.toString()) as Record<string, unknown>;
        if (typeof parsed.type !== "string" || !PUBLIC_ROOM_EVENT_TYPES.has(parsed.type)) return;
        const body = typeof parsed.payload === "object" && parsed.payload !== null
          ? parsed.payload as Record<string, unknown>
          : undefined;
        events.push({
          captionId: typeof parsed.captionId === "string" ? parsed.captionId : undefined,
          meetingId: typeof parsed.meetingId === "string" ? parsed.meetingId : undefined,
          sequence: typeof parsed.sequence === "number" ? parsed.sequence : undefined,
          streamId: typeof parsed.streamId === "string" ? parsed.streamId : undefined,
          text: typeof body?.text === "string" ? body.text : undefined,
          type: parsed.type
        });
      } catch {
        // Non-JSON protocol failures are covered by the dedicated privacy and
        // contract suites. This observer records valid public room events only.
      }
    });
  });
  return events;
}

function collectSentEventTypes(page: Page): string[] {
  const types: string[] = [];
  page.on("websocket", (socket) => {
    socket.on("framesent", ({ payload }) => {
      try {
        const parsed = JSON.parse(payload.toString()) as Record<string, unknown>;
        if (typeof parsed.type === "string") types.push(parsed.type);
      } catch {
        types.push("non-json");
      }
    });
  });
  return types;
}

function expectContiguousPublicSequence(events: RoomEvent[]): void {
  const sequences = events
    .filter((event) => ORDERED_PUBLIC_ROOM_EVENT_TYPES.has(event.type))
    .map((event) => event.sequence)
    .filter((sequence): sequence is number => sequence !== undefined);
  expect(sequences.length).toBeGreaterThanOrEqual(2);
  for (let index = 1; index < sequences.length; index += 1) {
    expect(sequences[index]).toBe(sequences[index - 1] + 1);
  }
}

async function exposeNativeSockets(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const NativeWebSocket = window.WebSocket;
    const sockets: WebSocket[] = [];
    class TrackedWebSocket extends NativeWebSocket {
      constructor(url: string | URL, protocols?: string | string[]) {
        if (protocols === undefined) super(url);
        else super(url, protocols);
        sockets.push(this);
      }
    }
    Object.defineProperty(window, "WebSocket", { configurable: false, value: TrackedWebSocket });
    Object.defineProperty(window, "__signConnectReliableRoomSockets", {
      configurable: false,
      value: sockets
    });
  });
}

async function newParticipant(browser: Browser): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext({
    baseURL: BASE_URL,
    permissions: ["camera"]
  });
  return { context, page: await context.newPage() };
}

async function openWorkspace(page: Page, roomCode?: string): Promise<void> {
  await page.goto(roomCode ? `/?room=${roomCode}` : "/");
  await expect(page.getByRole("note", { name: "Automated fixture capture notice" })).toContainText(
    "Synthetic normalized landmarks"
  );
}

async function createRoom(page: Page, displayName: string): Promise<string> {
  await openWorkspace(page);
  await page.getByLabel("Display name").fill(displayName);
  await page.getByRole("button", { name: "Start session" }).click();
  await expect(page.getByRole("button", { name: "Session active" })).toBeVisible();
  await expect(page.getByText(/^Connected$/)).toBeVisible();
  const roomCode = (await page.locator(".room-identity strong").textContent())?.trim();
  expect(roomCode).toMatch(/^[A-Z2-9]{6}$/);
  return roomCode!;
}

async function joinRoom(page: Page, roomCode: string, displayName: string): Promise<void> {
  await openWorkspace(page, roomCode);
  await page.getByLabel("Display name").fill(displayName);
  await page.getByRole("button", { name: "Join room" }).click();
  await expect(page.getByRole("button", { name: "Session active" })).toBeVisible();
  await expect(page.getByText(/^Connected$/)).toBeVisible();
}

async function enableRecognition(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Turn camera on" }).click();
  await expect(page.getByRole("button", { name: "Turn camera off" })).toBeEnabled();
  await page.getByRole("button", { name: "Start recognition" }).click();
  await expect(page.getByRole("button", { name: "Stop recognition" })).toBeVisible();
}

async function restartRecognition(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Stop recognition" }).click();
  await page.getByRole("button", { name: "Start recognition" }).click();
  await expect(page.getByRole("button", { name: "Stop recognition" })).toBeVisible();
}

async function controlService(
  request: APIRequestContext,
  service: "inference" | "realtime",
  action: "start" | "stop"
): Promise<void> {
  expect(CONTROL_URL, "Run browser specs through scripts/run-recognition-e2e.mjs").toBeTruthy();
  expect(CONTROL_TOKEN, "The full-stack runner did not provide its control token").toBeTruthy();
  const response = await request.post(`${CONTROL_URL}/control/${service}/${action}`, {
    headers: { "x-signconnect-e2e-token": CONTROL_TOKEN! }
  });
  expect(response.ok(), `${service} ${action} returned HTTP ${response.status()}`).toBe(true);
}

function captions(page: Page) {
  return page.getByRole("region", { name: "Live transcript" }).getByRole("article");
}

async function expectUsableCameraFraming(
  page: Page,
  minimumHeightRatio: number,
  maximumHeightRatio?: number
): Promise<void> {
  const workspace = page.getByRole("region", { name: "Camera workspace" });
  const stage = workspace.locator(".stage-viewport");
  const video = stage.locator("video.visible");
  const overlay = stage.locator("canvas.landmark-overlay");
  await workspace.scrollIntoViewIfNeeded();
  await expect(workspace).toBeVisible();
  await expect(stage).toBeVisible();
  await expect(video).toBeVisible();

  const viewport = page.viewportSize();
  const stageBox = await stage.boundingBox();
  const videoBox = await video.boundingBox();
  const overlayBox = await overlay.boundingBox();
  expect(viewport).not.toBeNull();
  expect(stageBox).not.toBeNull();
  expect(videoBox).not.toBeNull();
  expect(overlayBox).not.toBeNull();
  expect(stageBox!.width).toBeGreaterThan(320);
  expect(stageBox!.height / stageBox!.width).toBeGreaterThanOrEqual(minimumHeightRatio);
  if (maximumHeightRatio !== undefined) {
    expect(stageBox!.height / stageBox!.width).toBeLessThanOrEqual(maximumHeightRatio);
  }
  expect(stageBox!.x).toBeGreaterThanOrEqual(0);
  expect(stageBox!.x + stageBox!.width).toBeLessThanOrEqual(viewport!.width + 1);
  expect(videoBox!.width).toBeCloseTo(stageBox!.width, 0);
  expect(videoBox!.height).toBeCloseTo(stageBox!.height, 0);
  expect(overlayBox!.width).toBeCloseTo(stageBox!.width, 0);
  expect(overlayBox!.height).toBeCloseTo(stageBox!.height, 0);
  const mediaGeometry = await video.evaluate((element) => {
    const style = getComputedStyle(element);
    return {
      objectFit: style.objectFit,
      objectPosition: style.objectPosition,
      videoHeight: element.videoHeight,
      videoWidth: element.videoWidth
    };
  });
  expect(mediaGeometry.videoWidth).toBeGreaterThan(0);
  expect(mediaGeometry.videoHeight).toBeGreaterThan(0);
  expect(mediaGeometry.videoWidth / mediaGeometry.videoHeight).toBeCloseTo(4 / 3, 1);
  expect(mediaGeometry.objectFit).toBe("contain");
  expect(mediaGeometry.objectPosition).toBe("50% 50%");
  const containScale = Math.min(
    stageBox!.width / mediaGeometry.videoWidth,
    stageBox!.height / mediaGeometry.videoHeight
  );
  const containedVideoWidth = mediaGeometry.videoWidth * containScale;
  const containedVideoHeight = mediaGeometry.videoHeight * containScale;
  expect(stageBox!.width - containedVideoWidth).toBeLessThanOrEqual(2);
  expect(stageBox!.height - containedVideoHeight).toBeLessThanOrEqual(2);
  await expect.poll(() => overlay.evaluate((element) => {
    const pixelRatio = Math.min(window.devicePixelRatio || 1, 2);
    return element.width === Math.round(element.clientWidth * pixelRatio)
      && element.height === Math.round(element.clientHeight * pixelRatio);
  })).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth))
    .toBeLessThanOrEqual(1);

  const cameraControl = page.getByRole("button", { name: "Turn camera off" });
  const recognitionControl = page.getByRole("button", { name: /^(Start|Stop) recognition$/ });
  await cameraControl.scrollIntoViewIfNeeded();
  await expect(cameraControl).toBeVisible();
  await expect(cameraControl).toBeInViewport();
  await expect(recognitionControl).toBeVisible();
  await expect(recognitionControl).toBeInViewport();
  await expect(recognitionControl).toBeEnabled();
}

test.describe("Milestone 2 reliable room acceptance", () => {
  test.describe.configure({ mode: "serial" });
  test.setTimeout(60_000);

  test("two participant workspaces receive one ordered caption exactly once", async ({ browser }) => {
    const host = await newParticipant(browser);
    const guest = await newParticipant(browser);
    const hostEvents = collectRoomEvents(host.page);
    const guestEvents = collectRoomEvents(guest.page);
    try {
      const roomCode = await createRoom(host.page, "Host Ada");
      await joinRoom(guest.page, roomCode, "Guest Lin");
      await expect(host.page.getByLabel("People in this room").getByRole("listitem")).toHaveCount(2);
      await expect(guest.page.getByLabel("People in this room").getByRole("listitem")).toHaveCount(2);

      await enableRecognition(host.page);
      await expect(captions(host.page)).toHaveCount(1, { timeout: 15_000 });
      await expect(captions(guest.page)).toHaveCount(1, { timeout: 15_000 });
      await expect(captions(host.page)).toContainText("Synthetic active gesture");
      await expect(captions(guest.page)).toContainText("Synthetic active gesture");

      await expect.poll(() => hostEvents.filter((event) => event.type === "caption.final").length).toBe(1);
      await expect.poll(() => guestEvents.filter((event) => event.type === "caption.final").length).toBe(1);
      const hostCaption = hostEvents.find((event) => event.type === "caption.final")!;
      const guestCaption = guestEvents.find((event) => event.type === "caption.final")!;
      expect(hostCaption).toMatchObject({
        captionId: expect.stringMatching(
          /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
        ),
        meetingId: guestCaption.meetingId,
        sequence: guestCaption.sequence,
        text: "Synthetic active gesture"
      });
      expect(hostCaption.sequence).toBeGreaterThan(0);
      expect(hostCaption.captionId).toBe(guestCaption.captionId);
      expectContiguousPublicSequence(hostEvents);
      expectContiguousPublicSequence(guestEvents);
      await expect(host.page.getByText(/room updates arrived out of order/i)).toHaveCount(0);
      await expect(guest.page.getByText(/room updates arrived out of order/i)).toHaveCount(0);

      await host.page.waitForTimeout(1_200);
      await expect(captions(host.page)).toHaveCount(1);
      await expect(captions(guest.page)).toHaveCount(1);
    } finally {
      await guest.context.close();
      await host.context.close();
    }
  });

  test("reconnect does not replay the last caption and produces a fresh-stream caption", async ({ browser }) => {
    const host = await newParticipant(browser);
    const guest = await newParticipant(browser);
    const hostEvents = collectRoomEvents(host.page);
    const guestEvents = collectRoomEvents(guest.page);
    try {
      await exposeNativeSockets(host.page);
      const roomCode = await createRoom(host.page, "Host Reconnect");
      await joinRoom(guest.page, roomCode, "Guest Reconnect");
      await enableRecognition(host.page);
      await expect(captions(host.page)).toHaveCount(1, { timeout: 15_000 });
      await expect(captions(guest.page)).toHaveCount(1, { timeout: 15_000 });
      const captionId = hostEvents.find((event) => event.type === "caption.final")?.captionId;
      expect(captionId).toBeTruthy();

      await host.page.evaluate(() => {
        const activeSocket = window.__signConnectReliableRoomSockets
          ?.filter((socket) => socket.readyState === WebSocket.OPEN)
          .at(-1);
        if (!activeSocket) throw new Error("The host realtime socket is unavailable");
        activeSocket.close(4000, "E2E participant reconnect");
      });
      await expect(host.page.getByText(/^Reconnecting in \d+ ms$/i)).toBeVisible();
      await expect(host.page.getByText(/Connection recovered/i)).toBeVisible({ timeout: 20_000 });
      await expect(guest.page.getByText(/^Connected$/)).toBeVisible();
      await expect(host.page.getByLabel("People in this room").getByRole("listitem")).toHaveCount(2);
      await expect(guest.page.getByLabel("People in this room").getByRole("listitem")).toHaveCount(2);

      const restart = host.page.getByRole("button", { name: "Start recognition" });
      if (await restart.isVisible().catch(() => false)) await restart.click();
      await expect(captions(host.page)).toHaveCount(2, { timeout: 15_000 });
      await expect(captions(guest.page)).toHaveCount(2, { timeout: 15_000 });
      await host.page.waitForTimeout(500);
      const hostCaptions = hostEvents.filter((event) => event.type === "caption.final");
      const guestCaptions = guestEvents.filter((event) => event.type === "caption.final");
      expect(hostEvents.filter((event) => event.type === "caption.final" && event.captionId === captionId)).toHaveLength(1);
      expect(guestEvents.filter((event) => event.type === "caption.final" && event.captionId === captionId)).toHaveLength(1);
      expect(hostCaptions).toHaveLength(2);
      expect(guestCaptions).toHaveLength(2);
      expect(new Set(hostCaptions.map((event) => event.captionId)).size).toBe(2);
      expect(new Set(guestCaptions.map((event) => event.captionId)).size).toBe(2);
      expect(new Set(hostCaptions.map((event) => event.streamId)).size).toBe(2);
      expect(new Set(guestCaptions.map((event) => event.streamId)).size).toBe(2);
    } finally {
      await guest.context.close();
      await host.context.close();
    }
  });

  test("only the granted participant uploads landmarks until signer access is released", async ({ browser }) => {
    const host = await newParticipant(browser);
    const guest = await newParticipant(browser);
    const guestSentTypes = collectSentEventTypes(guest.page);
    try {
      const roomCode = await createRoom(host.page, "Host Owner");
      await joinRoom(guest.page, roomCode, "Guest Waiting");
      await enableRecognition(host.page);
      await expect(captions(host.page)).toHaveCount(1, { timeout: 15_000 });

      await guest.page.getByRole("button", { name: "Turn camera on" }).click();
      await expect(guest.page.getByRole("button", { name: "Turn camera off" })).toBeEnabled();
      await guest.page.getByRole("button", { name: "Start recognition" }).click();
      await expect(guest.page.getByLabel("Capture controls")
        .getByText(/another participant is the active signer/i)).toBeVisible();
      await expect(guest.page.getByRole("button", { name: "Start recognition" })).toBeEnabled();
      expect(guestSentTypes.filter((type) => type === "landmark.chunk")).toHaveLength(0);

      await host.page.getByRole("button", { name: "Stop recognition" }).click();
      await guest.page.getByRole("button", { name: "Start recognition" }).click();
      await expect(guest.page.getByRole("button", { name: "Stop recognition" })).toBeVisible();
      await expect.poll(() => guestSentTypes.filter((type) => type === "landmark.chunk").length)
        .toBeGreaterThan(0);
    } finally {
      await guest.context.close();
      await host.context.close();
    }
  });

  test("recognition failure leaves the room available for another participant", async ({ browser, request }) => {
    const host = await newParticipant(browser);
    const guest = await newParticipant(browser);
    let inferenceStopped = false;
    try {
      const roomCode = await createRoom(host.page, "Host Resilience");
      await enableRecognition(host.page);
      await expect(captions(host.page)).toHaveCount(1, { timeout: 15_000 });

      await controlService(request, "inference", "stop");
      inferenceStopped = true;
      await restartRecognition(host.page);
      await expect(host.page.getByLabel("Recognition service status")).toContainText(
        /temporarily unavailable/i,
        { timeout: 10_000 }
      );

      await joinRoom(guest.page, roomCode, "Guest During Failure");
      await expect(host.page.getByLabel("People in this room").getByRole("listitem")).toHaveCount(2);
      await expect(guest.page.getByLabel("People in this room").getByRole("listitem")).toHaveCount(2);
      await expect(host.page.getByRole("button", { name: "Session active" })).toBeVisible();
      await expect(guest.page.getByRole("button", { name: "Session active" })).toBeVisible();
      await expect(captions(host.page)).toHaveCount(1);
      await expect(captions(guest.page)).toHaveCount(0);

      await controlService(request, "inference", "start");
      inferenceStopped = false;
      await restartRecognition(host.page);
      await expect(host.page.getByLabel("Recognition service status")).toContainText(
        /recognition is ready/i,
        { timeout: 15_000 }
      );
      await expect(captions(host.page)).toHaveCount(2, { timeout: 15_000 });
      await expect(captions(guest.page)).toHaveCount(1, { timeout: 15_000 });
      await expect(host.page.getByRole("button", { name: "Session active" })).toBeVisible();
      await expect(guest.page.getByRole("button", { name: "Session active" })).toBeVisible();
    } finally {
      if (inferenceStopped) await controlService(request, "inference", "start");
      await guest.context.close();
      await host.context.close();
    }
  });

  test("camera workspace keeps a useful human framing at desktop and narrow widths", async ({ browser }) => {
    const participant = await newParticipant(browser);
    try {
      await participant.page.setViewportSize({ width: 1440, height: 900 });
      await createRoom(participant.page, "Camera Framing");
      await enableRecognition(participant.page);
      await expect(captions(participant.page)).toContainText(
        "Synthetic active gesture",
        { timeout: 15_000 }
      );
      await expectUsableCameraFraming(participant.page, 0.7, 0.8);

      await participant.page.setViewportSize({ width: 720, height: 900 });
      await expectUsableCameraFraming(participant.page, 0.7);
    } finally {
      await participant.context.close();
    }
  });
});
