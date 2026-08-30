import { expect, test, type APIRequestContext, type Page } from "@playwright/test";

declare global {
  interface Window {
    __signConnectE2eSockets?: WebSocket[];
    __signConnectE2eObserverSocket?: WebSocket;
    __signConnectObserverEvents?: string[];
  }
}

type FrameSummary = {
  direction: "sent" | "received";
  socketIndex: number;
  type: string;
  streamId?: string;
  sequence?: number;
  text?: string;
  modelVersion?: string;
  mockModel?: boolean;
};

type SocketDiagnostics = {
  urls: string[];
  frames: FrameSummary[];
};

const CONTROL_URL = process.env.SIGNCONNECT_E2E_CONTROL_URL;
const CONTROL_TOKEN = process.env.SIGNCONNECT_E2E_CONTROL_TOKEN;
const SIMULATOR_ENABLED = process.env.SIGNCONNECT_E2E_SIMULATOR === "true";

function collectSocketDiagnostics(page: Page): SocketDiagnostics {
  const diagnostics: SocketDiagnostics = { urls: [], frames: [] };
  page.on("websocket", (socket) => {
    const socketIndex = diagnostics.urls.push(socket.url()) - 1;
    const summarize = (direction: FrameSummary["direction"], payload: string | Buffer) => {
      if (diagnostics.frames.length >= 64) return;
      try {
        const parsed = JSON.parse(payload.toString()) as Record<string, unknown>;
        const body = typeof parsed.payload === "object" && parsed.payload !== null
          ? parsed.payload as Record<string, unknown>
          : undefined;
        diagnostics.frames.push({
          direction,
          socketIndex,
          type: typeof parsed.type === "string" ? parsed.type : "malformed",
          streamId: typeof parsed.streamId === "string" ? parsed.streamId : undefined,
          sequence: typeof parsed.sequence === "number" ? parsed.sequence : undefined,
          text: typeof body?.text === "string" ? body.text : undefined,
          modelVersion: typeof body?.modelVersion === "string" ? body.modelVersion : undefined,
          mockModel: typeof body?.mockModel === "boolean" ? body.mockModel : undefined
        });
      } catch {
        diagnostics.frames.push({ direction, socketIndex, type: "non-json" });
      }
    };
    socket.on("framesent", ({ payload }) => summarize("sent", payload));
    socket.on("framereceived", ({ payload }) => summarize("received", payload));
  });
  return diagnostics;
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
    Object.defineProperty(window, "__signConnectE2eSockets", { configurable: false, value: sockets });
  });
}

async function openWorkspace(page: Page): Promise<void> {
  await page.goto("/");
  await expect(page.getByRole("note", { name: "Automated fixture capture notice" })).toContainText(
    "Synthetic normalized landmarks"
  );
}

async function enableCameraAndSession(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Turn camera on" }).click();
  await expect(page.getByRole("button", { name: "Turn camera off" })).toBeEnabled();
  await page.getByRole("button", { name: "Start session" }).click();
  await expect(page.getByRole("button", { name: "Session active" })).toBeVisible();
  await expect(page.getByText(/^Connected$/)).toBeVisible();
}

async function startRecognitionWithKeyboard(page: Page): Promise<void> {
  const start = page.getByRole("button", { name: "Start recognition" });
  await start.focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("button", { name: "Stop recognition" })).toBeVisible();
}

async function restartRecognition(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Stop recognition" }).click();
  const start = page.getByRole("button", { name: "Start recognition" });
  await expect(start).toBeEnabled();
  await start.click();
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

async function injectServerEvent(page: Page, event: Record<string, unknown>): Promise<void> {
  await page.evaluate((payload) => {
    const socket = window.__signConnectE2eSockets
      ?.filter((candidate) => candidate !== window.__signConnectE2eObserverSocket)
      .at(-1);
    if (!socket?.onmessage) throw new Error("The Meeting realtime socket is unavailable");
    socket.onmessage(new MessageEvent("message", { data: JSON.stringify(payload) }));
  }, event);
}

test.describe("sign-recognition full-stack milestone", () => {
  test.describe.configure({ mode: "serial" });
  test.setTimeout(45_000);

  test("camera preview remains separate from landmark consent", async ({ page }) => {
    const diagnostics = collectSocketDiagnostics(page);
    await openWorkspace(page);
    await enableCameraAndSession(page);

    await expect(page.locator("video.visible")).toBeVisible();
    await expect(page.getByText(/starting recognition consents to transient hand and body landmark transmission/i))
      .toBeVisible();
    await expect(page.getByText(/raw video is not transmitted/i)).toBeVisible();
    const sentTypes = diagnostics.frames
      .filter((frame) => frame.direction === "sent")
      .map((frame) => frame.type);
    expect(sentTypes).toContain("room.join");
    expect(sentTypes.filter((type) => type === "landmark.chunk"
      || type === "recognition.control"
      || type === "signer.request")).toEqual([]);
  });

  test("keyboard consent produces one shared synthetic final and ignores non-final transcript events", async ({ page, request }) => {
    await exposeNativeSockets(page);
    const diagnostics = collectSocketDiagnostics(page);
    await openWorkspace(page);
    await enableCameraAndSession(page);

    const realtimeUrl = diagnostics.urls.find((url) => url.includes("/ws/v1/realtime/"));
    expect(realtimeUrl).toBeTruthy();
    const meetingSocketIndex = diagnostics.urls.findIndex((url) => url === realtimeUrl);
    expect(meetingSocketIndex).toBeGreaterThanOrEqual(0);
    const roomCode = (await page.locator(".room-identity strong").textContent())?.trim();
    expect(roomCode).toMatch(/^[A-Z2-9]{6}$/);
    const joinResponse = await request.post(
      `http://127.0.0.1:8081/api/v1/meetings/${roomCode}/participants`,
      { data: { displayName: "Observer" } }
    );
    expect(joinResponse.ok()).toBe(true);
    const observerSession = await joinResponse.json() as { realtimeTicket: string };
    await page.evaluate(({ url, ticket }) => new Promise<void>((resolve, reject) => {
      window.__signConnectObserverEvents = [];
      const observer = new WebSocket(url);
      window.__signConnectE2eObserverSocket = observer;
      observer.onopen = () => observer.send(JSON.stringify({
        schemaVersion: 1,
        type: "room.join",
        ticket
      }));
      observer.onerror = () => reject(new Error("Same-meeting observer could not connect"));
      observer.onmessage = (message) => {
        const value = String(message.data);
        window.__signConnectObserverEvents!.push(value);
        if (JSON.parse(value).type === "room.joined") resolve();
      };
    }), { url: realtimeUrl!, ticket: observerSession.realtimeTicket });

    const start = page.getByRole("button", { name: "Start recognition" });
    await expect(start).toHaveAccessibleDescription(/transient hand and body landmark transmission/i);
    await startRecognitionWithKeyboard(page);

    const transcript = page.getByRole("region", { name: "Live transcript" });
    await expect(transcript.getByText("Synthetic active gesture")).toBeVisible();
    const captionEntry = transcript.getByRole("article");
    await expect(captionEntry).toHaveCount(1);
    await expect(captionEntry.locator(".caption-source")).toHaveText("You signed");
    await expect(captionEntry.locator("time")).toHaveText(
      /^at \d{1,2}:\d{2}:\d{2}(?:\s?[AP]M)?$/i
    );
    await expect(captionEntry.locator("time")).toHaveAttribute(
      "datetime",
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/
    );
    await expect(captionEntry).toHaveAccessibleName(/^You signed Synthetic active gesture at /i);
    await expect(transcript.getByRole("note")).toContainText(/not validated SGSL recognition/i);
    await expect(transcript.getByText("synthetic-v1")).toBeVisible();
    await expect(transcript.getByText("Mock integration model.", { exact: true })).toBeVisible();

    await page.waitForTimeout(1_800);
    await expect(transcript.getByRole("article")).toHaveCount(1);
    const receivedFinals = diagnostics.frames.filter(
      (frame) => frame.socketIndex === meetingSocketIndex
        && frame.direction === "received"
        && frame.type === "caption.final"
    );
    expect(receivedFinals).toHaveLength(1);
    expect(receivedFinals[0]).toMatchObject({
      text: "Synthetic active gesture",
      modelVersion: "synthetic-v1",
      mockModel: true
    });
    expect(diagnostics.frames.some(
      (frame) => frame.direction === "received" && frame.type === "recognition.status"
    )).toBe(true);
    await expect.poll(() => page.evaluate(() => window.__signConnectObserverEvents
      ?.map((event) => JSON.parse(event) as { type?: string })
      .filter((event) => event.type === "caption.final").length ?? 0)).toBe(1);
    expect(await page.evaluate(() => window.__signConnectObserverEvents
      ?.some((event) => JSON.parse(event).type === "landmark.chunk") ?? false)).toBe(false);

    const final = receivedFinals[0];
    const meetingId = new URL(realtimeUrl!).pathname.split("/").at(-1)!;
    await injectServerEvent(page, {
      schemaVersion: 1,
      type: "recognition.unknown",
      meetingId,
      streamId: final.streamId,
      sequence: (final.sequence ?? 1) + 1,
      payload: {
        reason: "LOW_CONFIDENCE",
        confidence: 0.2,
        modelVersion: "synthetic-v1",
        inferenceLatencyMs: 1,
        mockModel: true
      },
      occurredAt: new Date().toISOString()
    });
    // The frozen v1 result identifies only the stream. Once the dispatched
    // gesture has settled, a later unmatched local result must be ignored
    // rather than being attributed to a gesture that was never sent.
    await expect(page.locator(".recognition-feedback")).toHaveCount(0);
    await expect(transcript.getByRole("article")).toHaveCount(1);
  });

  test("full realtime restart clears the defunct ephemeral room and reports it missing", async ({ page, request }) => {
    const diagnostics = collectSocketDiagnostics(page);
    await openWorkspace(page);
    await enableCameraAndSession(page);
    await startRecognitionWithKeyboard(page);
    const transcript = page.getByRole("region", { name: "Live transcript" });
    await expect(transcript.getByRole("article")).toHaveCount(1, { timeout: 15_000 });
    await expect(transcript.getByRole("note")).toContainText(/mock integration model/i);
    await expect.poll(() => diagnostics.frames.filter(
      (frame) => frame.direction === "received" && frame.type === "caption.final"
    ).length).toBe(1);

    let realtimeStopped = false;
    try {
      await controlService(request, "realtime", "stop");
      realtimeStopped = true;
      await expect(page.getByText(/^Reconnecting in \d+ ms$/i)).toBeVisible();
      await controlService(request, "realtime", "start");
      realtimeStopped = false;
      await expect(page.getByRole("alert")).toContainText(/room no longer exists/i, { timeout: 20_000 });
      await expect(page.getByRole("region", { name: "Open a shared room" })).toBeVisible();
      await page.waitForTimeout(500);
      await expect(transcript.getByRole("article")).toHaveCount(0);
      await expect(transcript.getByText("No captions yet", { exact: true })).toBeVisible();
      await expect(transcript.getByLabel("0 final captions")).toBeVisible();
      await expect(transcript.getByRole("note")).toHaveCount(0);
      await expect.poll(() => diagnostics.frames.filter(
        (frame) => frame.direction === "received" && frame.type === "caption.final"
      ).length).toBe(1);
    } finally {
      if (realtimeStopped) await controlService(request, "realtime", "start");
    }
  });

  test("reports inference unavailability, suppresses outage captions, and recovers", async ({ page, request }) => {
    await openWorkspace(page);
    await enableCameraAndSession(page);
    await startRecognitionWithKeyboard(page);
    const transcript = page.getByRole("region", { name: "Live transcript" });
    await expect(transcript.getByRole("article")).toHaveCount(1, { timeout: 15_000 });

    let inferenceStopped = false;
    try {
      await controlService(request, "inference", "stop");
      inferenceStopped = true;
      await restartRecognition(page);
      await expect(page.getByLabel("Recognition service status")).toContainText(
        /temporarily unavailable/i,
        { timeout: 10_000 }
      );
      await expect(transcript.getByRole("article")).toHaveCount(1);
      await controlService(request, "inference", "start");
      inferenceStopped = false;
      await restartRecognition(page);
      await expect(page.getByLabel("Recognition service status")).toContainText(
        /recognition is ready/i,
        { timeout: 15_000 }
      );
      await expect(transcript.getByRole("article")).toHaveCount(2, { timeout: 15_000 });
    } finally {
      if (inferenceStopped) await controlService(request, "inference", "start");
    }
  });

  test("@simulator simulator follows the explicit client and server development gates", async ({ page }) => {
    const diagnostics = collectSocketDiagnostics(page);
    await openWorkspace(page);
    if (!SIMULATOR_ENABLED) {
      await expect(page.getByText("Recognizer simulator")).toHaveCount(0);
      return;
    }

    await expect(page.getByText("Recognizer simulator")).toBeVisible();
    await expect(page.getByText(/server development profile must also be active/i)).toBeVisible();
    await page.getByRole("button", { name: "Start session" }).click();
    await expect(page.getByRole("button", { name: "Session active" })).toBeVisible();
    await page.getByRole("button", { name: "Hello everyone" }).click();
    await expect.poll(() => diagnostics.frames.some(
      (frame) => frame.direction === "received" && frame.type === "caption.final"
    )).toBe(true);
  });
});
