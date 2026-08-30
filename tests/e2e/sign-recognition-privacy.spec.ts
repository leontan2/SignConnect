import { expect, test, type Page } from "@playwright/test";

declare global {
  interface Window {
    __signConnectPrivacyObserverEvents?: string[];
    __signConnectPrivacyObserverSocket?: WebSocket;
  }
}

type PrivacySummary = {
  type: string;
  sequence?: number;
  action?: "start" | "stop";
  streamId?: string;
  frameCount?: number;
  featureCounts?: number[];
  frameSequences?: number[];
  frameTimestamps?: number[];
  handPresenceCounts?: number[];
  violations: string[];
  features: "[REDACTED]" | "not-applicable";
};

const EVENT_KEYS = new Set(["schemaVersion", "type", "streamId", "sequence", "frames"]);
const CONTROL_KEYS = new Set(["schemaVersion", "type", "streamId", "sequence", "timestampMs", "action"]);
const ROOM_JOIN_TICKET_KEYS = new Set(["schemaVersion", "type", "ticket"]);
const ROOM_JOIN_RESUME_KEYS = new Set(["schemaVersion", "type", "resumeToken"]);
const SIGNER_REQUEST_KEYS = new Set([
  "schemaVersion", "type", "requestId", "streamId", "sequence", "timestampMs"
]);
const SIGNER_RELEASE_KEYS = new Set([
  "schemaVersion", "type", "streamId", "sequence", "timestampMs", "reason"
]);
const FRAME_KEYS = new Set(["sequence", "timestampMs", "features"]);
const SENSITIVE_FIELD = /(?:video|image|pixel|blob|base64|mediaStream|dataUrl|frameData)/i;
const UUID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const MAX_DIAGNOSTICS = 32;
const MAX_VIOLATION_DIAGNOSTICS = 16;

type PrivacyDiagnostics = {
  summaries: PrivacySummary[];
  urls: string[];
  typeCounts: Record<string, number>;
  controlActionCounts: Record<"start" | "stop", number>;
  outboundCount: number;
  violationCount: number;
  violations: string[];
};

function exactKeys(value: Record<string, unknown>, allowed: Set<string>): boolean {
  const keys = Object.keys(value);
  return keys.length === allowed.size && keys.every((key) => allowed.has(key));
}

function inspectOutbound(payload: string | Buffer): PrivacySummary {
  const violations: string[] = [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload.toString());
  } catch {
    return { type: "non-json", violations: ["outbound message is not JSON"], features: "not-applicable" };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { type: "non-object", violations: ["outbound message is not an object"], features: "not-applicable" };
  }

  const event = parsed as Record<string, unknown>;
  const type = typeof event.type === "string" ? event.type : "missing-type";
  const summary: PrivacySummary = {
    type,
    sequence: typeof event.sequence === "number" ? event.sequence : undefined,
    streamId: typeof event.streamId === "string" ? event.streamId : undefined,
    violations,
    features: type === "landmark.chunk" ? "[REDACTED]" : "not-applicable"
  };

  const findSensitiveKeys = (value: unknown, path: string): void => {
    if (Array.isArray(value)) {
      value.forEach((item, index) => findSensitiveKeys(item, `${path}[${index}]`));
      return;
    }
    if (typeof value !== "object" || value === null) return;
    Object.entries(value as Record<string, unknown>).forEach(([key, child]) => {
      if (SENSITIVE_FIELD.test(key)) violations.push(`${path}.${key} is a forbidden media field`);
      if (key !== "features") findSensitiveKeys(child, `${path}.${key}`);
    });
  };
  findSensitiveKeys(event, "event");

  if (type === "room.join") {
    if (!exactKeys(event, ROOM_JOIN_TICKET_KEYS) && !exactKeys(event, ROOM_JOIN_RESUME_KEYS)) {
      violations.push("room.join keys do not match the v1 schema");
    }
    if (event.schemaVersion !== 1) violations.push("room.join schemaVersion is not 1");
    const credential = typeof event.ticket === "string" ? event.ticket : event.resumeToken;
    if (typeof credential !== "string" || credential.length < 1 || credential.length > 2048) {
      violations.push("room.join credential is invalid");
    }
    return summary;
  }

  if (type === "signer.request" || type === "signer.release") {
    const expectedKeys = type === "signer.request" ? SIGNER_REQUEST_KEYS : SIGNER_RELEASE_KEYS;
    if (!exactKeys(event, expectedKeys)) violations.push(`${type} keys do not match the v1 schema`);
    if (event.schemaVersion !== 1) violations.push(`${type} schemaVersion is not 1`);
    if (typeof event.streamId !== "string" || !UUID.test(event.streamId)) {
      violations.push(`${type} streamId is invalid`);
    }
    if (type === "signer.request"
      && (typeof event.requestId !== "string" || !UUID.test(event.requestId))) {
      violations.push("signer.request requestId is invalid");
    }
    if (!Number.isInteger(event.sequence) || (event.sequence as number) < 0) {
      violations.push(`${type} sequence is invalid`);
    }
    if (typeof event.timestampMs !== "number" || !Number.isFinite(event.timestampMs) || event.timestampMs < 0) {
      violations.push(`${type} timestamp is invalid`);
    }
    if (type === "signer.release"
      && event.reason !== "recognition_stopped" && event.reason !== "user_request") {
      violations.push("signer.release reason is invalid");
    }
    return summary;
  }

  if (type === "recognition.control") {
    if (!exactKeys(event, CONTROL_KEYS)) violations.push("recognition.control keys do not match the v1 schema");
    if (event.schemaVersion !== 1) violations.push("recognition.control schemaVersion is not 1");
    if (typeof event.streamId !== "string" || !UUID.test(event.streamId)) {
      violations.push("recognition.control streamId is invalid");
    }
    if (!Number.isInteger(event.sequence) || (event.sequence as number) < 0) {
      violations.push("recognition.control sequence is invalid");
    }
    if (typeof event.timestampMs !== "number" || !Number.isFinite(event.timestampMs) || event.timestampMs < 0) {
      violations.push("recognition.control timestamp is invalid");
    }
    if (event.action !== "start" && event.action !== "stop") violations.push("recognition.control action is invalid");
    if (event.action === "start" || event.action === "stop") summary.action = event.action;
    return summary;
  }

  if (type !== "landmark.chunk") {
    violations.push(`unexpected outbound type ${type}`);
    return summary;
  }
  if (!exactKeys(event, EVENT_KEYS)) violations.push("landmark.chunk keys do not match the v1 schema");
  if (event.schemaVersion !== 1) violations.push("landmark.chunk schemaVersion is not 1");
  if (typeof event.streamId !== "string" || !UUID.test(event.streamId)) {
    violations.push("landmark.chunk streamId is invalid");
  }
  if (!Number.isInteger(event.sequence) || (event.sequence as number) < 0) {
    violations.push("landmark.chunk sequence is invalid");
  }
  if (!Array.isArray(event.frames)) {
    violations.push("landmark.chunk frames is not an array");
    return summary;
  }

  summary.frameCount = event.frames.length;
  summary.featureCounts = [];
  summary.frameSequences = [];
  summary.frameTimestamps = [];
  summary.handPresenceCounts = [];
  if (event.frames.length !== 5) violations.push("landmark.chunk does not contain five frames");
  let previousFrameSequence = -1;
  let previousTimestamp = -1;
  event.frames.forEach((frameValue, frameIndex) => {
    if (typeof frameValue !== "object" || frameValue === null || Array.isArray(frameValue)) {
      violations.push(`frame ${frameIndex} is not an object`);
      return;
    }
    const frame = frameValue as Record<string, unknown>;
    if (!exactKeys(frame, FRAME_KEYS)) violations.push(`frame ${frameIndex} keys do not match the v1 schema`);
    if (!Number.isInteger(frame.sequence) || (frame.sequence as number) <= previousFrameSequence) {
      violations.push(`frame ${frameIndex} sequence is invalid`);
    } else {
      previousFrameSequence = frame.sequence as number;
      summary.frameSequences!.push(previousFrameSequence);
    }
    if (typeof frame.timestampMs !== "number" || !Number.isFinite(frame.timestampMs)
      || frame.timestampMs < 0 || frame.timestampMs <= previousTimestamp) {
      violations.push(`frame ${frameIndex} timestamp is invalid`);
    } else {
      previousTimestamp = frame.timestampMs;
      summary.frameTimestamps!.push(previousTimestamp);
    }
    if (!Array.isArray(frame.features)) {
      violations.push(`frame ${frameIndex} features is not an array`);
      return;
    }
    summary.featureCounts!.push(frame.features.length);
    if (frame.features.length !== 224) violations.push(`frame ${frameIndex} feature count is not 224`);
    if (!frame.features.every((value) => typeof value === "number" && Number.isFinite(value))) {
      violations.push(`frame ${frameIndex} contains a non-finite or non-numeric feature`);
    }
    let handPresenceCount = 0;
    for (let index = 3; index < frame.features.length; index += 4) {
      if (frame.features[index] !== 0 && frame.features[index] !== 1) {
        violations.push(`frame ${frameIndex} contains an invalid presence value`);
        break;
      }
      if (index < 168 && frame.features[index] === 1) handPresenceCount += 1;
    }
    summary.handPresenceCounts!.push(handPresenceCount);
  });
  return summary;
}

function collectPrivacyDiagnostics(page: Page): PrivacyDiagnostics {
  const diagnostics: PrivacyDiagnostics = {
    summaries: [],
    urls: [],
    typeCounts: {},
    controlActionCounts: { start: 0, stop: 0 },
    outboundCount: 0,
    violationCount: 0,
    violations: []
  };
  page.on("websocket", (socket) => {
    diagnostics.urls.push(socket.url());
    socket.on("framesent", ({ payload }) => {
      const summary = inspectOutbound(payload);
      diagnostics.outboundCount += 1;
      diagnostics.typeCounts[summary.type] = (diagnostics.typeCounts[summary.type] ?? 0) + 1;
      if (summary.action) diagnostics.controlActionCounts[summary.action] += 1;
      diagnostics.violationCount += summary.violations.length;
      for (const violation of summary.violations) {
        if (diagnostics.violations.length >= MAX_VIOLATION_DIAGNOSTICS) break;
        diagnostics.violations.push(violation);
      }
      if (diagnostics.summaries.length < MAX_DIAGNOSTICS) diagnostics.summaries.push(summary);
    });
  });
  return diagnostics;
}

async function inspectBrowserStorage(page: Page): Promise<Record<string, unknown>> {
  return page.evaluate(async () => {
    const storageEntries = (storage: Storage) => Array.from(
      { length: storage.length },
      (_unused, index) => {
        const key = storage.key(index) ?? "";
        return [key, storage.getItem(key)] as const;
      }
    );
    const databaseEntries: Array<{ database: string; store: string; values: string }> = [];
    if (typeof indexedDB.databases === "function") {
      for (const databaseInfo of await indexedDB.databases()) {
        if (!databaseInfo.name) continue;
        const database = await new Promise<IDBDatabase>((resolve, reject) => {
          const request = indexedDB.open(databaseInfo.name!);
          request.onsuccess = () => resolve(request.result);
          request.onerror = () => reject(request.error);
        });
        const storeNames = Array.from(database.objectStoreNames);
        if (storeNames.length > 0) {
          const transaction = database.transaction(storeNames, "readonly");
          await Promise.all(storeNames.map((storeName) => new Promise<void>((resolve, reject) => {
            const request = transaction.objectStore(storeName).getAll();
            request.onsuccess = () => {
              databaseEntries.push({
                database: database.name,
                store: storeName,
                values: JSON.stringify(request.result)
              });
              resolve();
            };
            request.onerror = () => reject(request.error);
          })));
        }
        database.close();
      }
    }

    const cacheEntries: Array<{ cache: string; url: string; body?: string }> = [];
    if ("caches" in window) {
      for (const cacheName of await caches.keys()) {
        const cache = await caches.open(cacheName);
        for (const request of await cache.keys()) {
          const response = await cache.match(request);
          const contentType = response?.headers.get("content-type") ?? "";
          cacheEntries.push({
            cache: cacheName,
            url: request.url,
            ...(response && /(?:json|text|javascript)/i.test(contentType)
              ? { body: (await response.clone().text()).slice(0, 16_384) }
              : {})
          });
        }
      }
    }

    return {
      localStorage: storageEntries(localStorage),
      sessionStorage: storageEntries(sessionStorage),
      indexedDB: databaseEntries,
      cacheStorage: cacheEntries
    };
  });
}

test("one segmented gesture sends a private normalized window without raw media or retained state", async ({ page, request }) => {
  test.setTimeout(30_000);
  const diagnostics = collectPrivacyDiagnostics(page);
  await page.goto("/");
  await expect(page.getByTestId("e2e-fixture-capture-notice")).toBeVisible();

  await page.getByRole("button", { name: "Turn camera on" }).click();
  await expect(page.getByRole("button", { name: "Turn camera off" })).toBeEnabled();
  await page.getByRole("button", { name: "Start session" }).click();
  await expect(page.getByRole("button", { name: "Session active" })).toBeVisible();
  expect(diagnostics.typeCounts["landmark.chunk"] ?? 0).toBe(0);
  expect(diagnostics.typeCounts["recognition.control"] ?? 0).toBe(0);
  expect(diagnostics.typeCounts["signer.request"] ?? 0).toBe(0);

  const realtimeUrl = diagnostics.urls.find((url) => url.includes("/ws/v1/realtime/"));
  const roomCode = (await page.locator(".room-identity strong").textContent())?.trim();
  expect(realtimeUrl).toBeTruthy();
  expect(roomCode).toMatch(/^[A-Z2-9]{6}$/);
  const observerResponse = await request.post(
    `http://127.0.0.1:8081/api/v1/meetings/${roomCode}/participants`,
    { data: { displayName: "Privacy observer" } }
  );
  expect(observerResponse.ok()).toBe(true);
  const observerSession = await observerResponse.json() as { realtimeTicket: string };
  await page.evaluate(({ url, ticket }) => new Promise<void>((resolve, reject) => {
    window.__signConnectPrivacyObserverEvents = [];
    const observer = new WebSocket(url);
    window.__signConnectPrivacyObserverSocket = observer;
    observer.onopen = () => observer.send(JSON.stringify({ schemaVersion: 1, type: "room.join", ticket }));
    observer.onerror = () => reject(new Error("Privacy observer could not connect"));
    observer.onmessage = (message) => {
      const value = String(message.data);
      window.__signConnectPrivacyObserverEvents!.push(value);
      if (JSON.parse(value).type === "room.joined") resolve();
    };
  }), { url: realtimeUrl!, ticket: observerSession.realtimeTicket });

  await page.getByRole("button", { name: "Start recognition" }).click();
  await expect(
    page
      .getByRole("region", { name: "Live transcript" })
      .locator("article.caption-entry")
      .getByText("Synthetic active gesture", { exact: true })
  ).toBeVisible({ timeout: 15_000 });
  await expect.poll(() => diagnostics.typeCounts["landmark.chunk"] ?? 0).toBe(6);
  await page.waitForTimeout(750);
  expect(diagnostics.typeCounts["landmark.chunk"] ?? 0).toBe(6);
  await page.getByRole("button", { name: "Stop recognition" }).click();
  await expect(page.getByRole("button", { name: "Start recognition" })).toBeVisible();
  await expect.poll(() => diagnostics.typeCounts["recognition.control"] ?? 0).toBe(2);
  await expect.poll(() => diagnostics.typeCounts["signer.request"] ?? 0).toBeGreaterThanOrEqual(1);

  const chunks = diagnostics.summaries.filter((summary) => summary.type === "landmark.chunk");
  const chunkSequences = chunks.map((chunk) => chunk.sequence);
  const frameSequences = chunks.flatMap((chunk) => chunk.frameSequences ?? []);
  const frameTimestamps = chunks.flatMap((chunk) => chunk.frameTimestamps ?? []);
  expect(diagnostics.violationCount, JSON.stringify(diagnostics)).toBe(0);
  expect(diagnostics.controlActionCounts).toEqual({ start: 1, stop: 1 });
  expect(diagnostics.typeCounts["signer.release"] ?? 0).toBe(0);
  expect(chunks).toHaveLength(6);
  expect(new Set(chunks.map((chunk) => chunk.streamId)).size).toBe(1);
  expect(chunkSequences.every((sequence) => sequence !== undefined)).toBe(true);
  expect(chunkSequences.slice(1).every((sequence, index) => sequence === chunkSequences[index]! + 1)).toBe(true);
  expect(frameSequences).toHaveLength(30);
  expect(frameSequences.slice(1).every((sequence, index) => sequence > frameSequences[index]!)).toBe(true);
  expect(frameTimestamps).toHaveLength(30);
  expect(frameTimestamps.slice(1).every((timestamp, index) => timestamp > frameTimestamps[index]!)).toBe(true);
  expect(chunks.every((summary) => summary.frameCount === 5)).toBe(true);
  expect(chunks.every((summary) => summary.featureCounts?.every((count) => count === 224))).toBe(true);
  expect(chunks.every((summary) => summary.handPresenceCounts?.every((count) => count > 0))).toBe(true);
  expect(JSON.stringify(diagnostics)).not.toContain("-0.45");
  expect(JSON.stringify(diagnostics)).not.toMatch(/RAW_PIXEL|data:image|data:video/i);

  const browserStorage = await inspectBrowserStorage(page);
  const serializedStorage = JSON.stringify(browserStorage);
  expect(serializedStorage).not.toContain("-0.45");
  expect(serializedStorage).not.toMatch(
    /RAW_PIXEL|data:image|data:video|landmark|calibrat|shoulderScale|trackingQuality|gestureWindow|featureVector|tensor/i
  );

  const observerEvents = await page.evaluate(() =>
    (window.__signConnectPrivacyObserverEvents ?? []).map((value) => JSON.parse(value) as Record<string, unknown>)
  );
  const allowedRoomTypes = new Set([
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
  expect(observerEvents.map((event) => event.type).filter((type) => !allowedRoomTypes.has(String(type)))).toEqual([]);
  expect(observerEvents.filter((event) => event.type === "caption.final")).toHaveLength(1);
  expect(JSON.stringify(observerEvents)).not.toContain("-0.45");
  expect(JSON.stringify(observerEvents)).not.toMatch(/RAW_PIXEL|data:image|data:video|landmark\.chunk/i);
  await page.evaluate(() => window.__signConnectPrivacyObserverSocket?.close());
});
