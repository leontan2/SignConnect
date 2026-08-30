import { expect, test, type Page } from "@playwright/test";

type PrivacySummary = {
  type: string;
  sequence?: number;
  action?: "start" | "stop";
  frameCount?: number;
  featureCounts?: number[];
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
    }
    if (typeof frame.timestampMs !== "number" || !Number.isFinite(frame.timestampMs)
      || frame.timestampMs < 0 || frame.timestampMs <= previousTimestamp) {
      violations.push(`frame ${frameIndex} timestamp is invalid`);
    } else {
      previousTimestamp = frame.timestampMs;
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
    for (let index = 3; index < frame.features.length; index += 4) {
      if (frame.features[index] !== 0 && frame.features[index] !== 1) {
        violations.push(`frame ${frameIndex} contains an invalid presence value`);
        break;
      }
    }
  });
  return summary;
}

function collectPrivacyDiagnostics(page: Page): PrivacyDiagnostics {
  const diagnostics: PrivacyDiagnostics = {
    summaries: [],
    typeCounts: {},
    controlActionCounts: { start: 0, stop: 0 },
    outboundCount: 0,
    violationCount: 0,
    violations: []
  };
  page.on("websocket", (socket) => {
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

test("outbound recognition traffic contains normalized numeric landmarks and no raw media", async ({ page }) => {
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

  await page.getByRole("button", { name: "Start recognition" }).click();
  await expect(page.getByText("Synthetic active gesture")).toBeVisible({ timeout: 15_000 });
  await page.getByRole("button", { name: "Stop recognition" }).click();
  await expect.poll(() => diagnostics.typeCounts["landmark.chunk"] ?? 0).toBeGreaterThanOrEqual(10);
  await expect.poll(() => diagnostics.typeCounts["recognition.control"] ?? 0).toBeGreaterThanOrEqual(2);
  await expect.poll(() => diagnostics.typeCounts["signer.request"] ?? 0).toBeGreaterThanOrEqual(1);

  const chunks = diagnostics.summaries.filter((summary) => summary.type === "landmark.chunk");
  expect(diagnostics.violationCount, JSON.stringify(diagnostics)).toBe(0);
  expect(diagnostics.controlActionCounts.start).toBeGreaterThanOrEqual(1);
  expect(diagnostics.controlActionCounts.stop).toBeGreaterThanOrEqual(1);
  expect(diagnostics.typeCounts["signer.release"] ?? 0).toBe(0);
  expect(chunks.every((summary) => summary.frameCount === 5)).toBe(true);
  expect(chunks.every((summary) => summary.featureCounts?.every((count) => count === 224))).toBe(true);
  expect(JSON.stringify(diagnostics)).not.toContain("-0.45");
  expect(JSON.stringify(diagnostics)).not.toMatch(/RAW_PIXEL|data:image|data:video/i);
});
