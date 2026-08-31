import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const apiPort = 18081;
const realtimePort = 18082;
const meetingFrontendPort = 13001;
const shellFrontendPort = 13000;
const children = [];
const roomsByCode = new Map();
const roomsById = new Map();
const sessionsByTicket = new Map();
const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

function corsHeaders() {
  return {
    "access-control-allow-headers": "content-type",
    "access-control-allow-methods": "POST, OPTIONS",
    "access-control-allow-origin": "*"
  };
}

function sendJson(response, status, value) {
  response.writeHead(status, { ...corsHeaders(), "content-type": "application/json" });
  response.end(JSON.stringify(value));
}

async function readJson(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function nextRoomCode() {
  let code;
  do {
    code = Array.from({ length: 6 }, () => alphabet[Math.floor(Math.random() * alphabet.length)]).join("");
  } while (roomsByCode.has(code));
  return code;
}

function createParticipant(room, displayName, role) {
  const participant = { id: randomUUID(), displayName, role };
  const ticket = randomUUID();
  const session = { room, participant, ticket };
  sessionsByTicket.set(ticket, session);
  return {
    meeting: room.meeting,
    participant,
    realtimeTicket: ticket,
    realtimeTicketExpiresAt: new Date(Date.now() + 300_000).toISOString()
  };
}

const apiServer = createServer(async (request, response) => {
  try {
    if (request.method === "OPTIONS") {
      response.writeHead(204, corsHeaders());
      response.end();
      return;
    }
    if (request.method === "POST" && request.url === "/api/v1/meetings") {
      const body = await readJson(request);
      const room = {
        clients: new Map(),
        meeting: {
          id: randomUUID(),
          title: String(body.title || "Accessible conversation"),
          joinCode: nextRoomCode(),
          status: "READY",
          createdAt: new Date().toISOString()
        },
        activeSignerId: null,
        messageIds: new Set(),
        sequence: 0,
        signalIds: new Set()
      };
      roomsByCode.set(room.meeting.joinCode, room);
      roomsById.set(room.meeting.id, room);
      sendJson(response, 200, createParticipant(room, String(body.displayName || "Host"), "HOST"));
      return;
    }
    const joinMatch = /^\/api\/v1\/meetings\/([A-Z2-9]{6})\/participants$/.exec(request.url || "");
    if (request.method === "POST" && joinMatch) {
      const room = roomsByCode.get(joinMatch[1]);
      if (!room) {
        sendJson(response, 404, { message: "Room not found" });
        return;
      }
      const body = await readJson(request);
      sendJson(response, 200, createParticipant(room, String(body.displayName || "Guest"), "GUEST"));
      return;
    }
    sendJson(response, 404, { message: "Not found" });
  } catch (error) {
    sendJson(response, 400, { message: error instanceof Error ? error.message : "Invalid request" });
  }
});

function serverEvent(room, value) {
  return JSON.stringify({
    schemaVersion: 1,
    meetingId: room.meeting.id,
    sequence: ++room.sequence,
    occurredAt: new Date().toISOString(),
    ...value
  });
}

function broadcast(room, value) {
  const encoded = serverEvent(room, value);
  for (const client of room.clients.values()) client.socket.send(encoded);
}

const realtimeServer = new WebSocketServer({ port: realtimePort, host: "127.0.0.1" });
realtimeServer.on("connection", (socket, request) => {
  const meetingId = /^\/ws\/v1\/realtime\/([0-9a-f-]+)$/i.exec(request.url || "")?.[1];
  const room = roomsById.get(meetingId);
  let connectedSession = null;

  socket.on("message", (data) => {
    const event = JSON.parse(data.toString("utf8"));
    if (!connectedSession) {
      if (event.type !== "room.join") return;
      const session = sessionsByTicket.get(event.ticket);
      if (!room || !session || session.room !== room) return;
      connectedSession = session;
      room.clients.set(session.participant.id, { participant: session.participant, socket });
      socket.send(serverEvent(room, {
        type: "room.joined",
        participantId: session.participant.id,
        payload: {
          displayName: session.participant.displayName,
          role: session.participant.role,
          activeSigner: room.activeSignerId === session.participant.id
        }
      }));
      socket.send(serverEvent(room, {
        type: "room.snapshot",
        payload: {
          participants: [...room.clients.values()].map(({ participant }) => ({
            participantId: participant.id,
            displayName: participant.displayName,
            role: participant.role,
            activeSigner: room.activeSignerId === participant.id
          }))
        }
      }));
      broadcast(room, {
        type: "participant.joined",
        participantId: session.participant.id,
        payload: {
          displayName: session.participant.displayName,
          role: session.participant.role,
          activeSigner: room.activeSignerId === session.participant.id
        }
      });
      return;
    }

    if (event.type === "chat.message") {
      const dedupeKey = `${connectedSession.participant.id}:${event.messageId}`;
      if (room.messageIds.has(dedupeKey)) return;
      room.messageIds.add(dedupeKey);
      broadcast(room, {
        type: "chat.message",
        participantId: connectedSession.participant.id,
        messageId: event.messageId,
        payload: {
          text: event.text,
          sourceDisplayName: connectedSession.participant.displayName
        }
      });
      return;
    }

    if (event.type === "signer.request") {
      if (room.activeSignerId && room.activeSignerId !== connectedSession.participant.id) return;
      room.activeSignerId = connectedSession.participant.id;
      socket.send(serverEvent(room, {
        type: "signer.granted",
        participantId: connectedSession.participant.id,
        payload: { requestId: event.requestId, streamId: event.streamId }
      }));
      broadcast(room, {
        type: "participant.updated",
        participantId: connectedSession.participant.id,
        payload: {
          displayName: connectedSession.participant.displayName,
          role: connectedSession.participant.role,
          activeSigner: true
        }
      });
      return;
    }

    if (event.type === "recognition.control" && event.action === "start") {
      if (room.activeSignerId !== connectedSession.participant.id) return;
      socket.send(serverEvent(room, {
        type: "recognition.status",
        streamId: event.streamId,
        payload: {
          state: "READY",
          reason: "STARTED",
          message: "Automated conversation fixture is ready.",
          modelVersion: "conversation-fixture-v1",
          mockModel: true
        }
      }));
      for (const [index, text] of ["I", "Need", "Help."].entries()) {
        broadcast(room, {
          type: "caption.final",
          participantId: connectedSession.participant.id,
          captionId: randomUUID(),
          streamId: event.streamId,
          payload: {
            labelId: `SENTENCE_PART_${index + 1}`,
            text,
            confidence: 0.94 - index * 0.01,
            modelVersion: "conversation-fixture-v1",
            inferenceLatencyMs: 20 + index,
            mockModel: true,
            sourceDisplayName: connectedSession.participant.displayName
          }
        });
      }
      return;
    }

    if (event.type === "recognition.control" && event.action === "stop") {
      room.activeSignerId = null;
      broadcast(room, {
        type: "participant.updated",
        participantId: connectedSession.participant.id,
        payload: {
          displayName: connectedSession.participant.displayName,
          role: connectedSession.participant.role,
          activeSigner: false
        }
      });
      return;
    }

    if (["call.offer", "call.answer", "call.ice-candidate", "call.decline", "call.leave", "media.state"].includes(event.type)) {
      const dedupeKey = `${connectedSession.participant.id}:${event.signalId}`;
      if (room.signalIds.has(dedupeKey)) return;
      room.signalIds.add(dedupeKey);
      const target = room.clients.get(event.targetParticipantId);
      if (!target) return;
      target.socket.send(serverEvent(room, {
        type: event.type,
        participantId: connectedSession.participant.id,
        targetParticipantId: event.targetParticipantId,
        signalId: event.signalId,
        callId: event.callId,
        payload: event.payload
      }));
    }
  });

  socket.on("close", () => {
    if (!connectedSession || !room.clients.delete(connectedSession.participant.id)) return;
    if (room.activeSignerId === connectedSession.participant.id) room.activeSignerId = null;
    broadcast(room, {
      type: "participant.left",
      participantId: connectedSession.participant.id,
      payload: {
        displayName: connectedSession.participant.displayName,
        role: connectedSession.participant.role,
        activeSigner: false
      }
    });
  });
});

function spawnFrontend(name, cwd, port, environment) {
  const webpackCli = path.join(repositoryRoot, "node_modules", "webpack", "bin", "webpack.js");
  const child = spawn(process.execPath, [
    webpackCli,
    "serve",
    "--config",
    "webpack.config.cjs",
    "--mode",
    "development",
    "--host",
    "127.0.0.1",
    "--port",
    String(port)
  ], {
    cwd,
    env: { ...process.env, ...environment },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true
  });
  let log = "";
  child.stdout.on("data", (chunk) => { log = `${log}${chunk}`.slice(-12_000); });
  child.stderr.on("data", (chunk) => { log = `${log}${chunk}`.slice(-12_000); });
  child.once("exit", (code) => {
    if (code && !closing) console.error(`${name} exited with ${code}.\n${log}`);
  });
  children.push(child);
}

async function waitFor(url, label) {
  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      // The development server is still compiling.
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`${label} did not become ready at ${url}`);
}

let closing = false;
async function closeAll() {
  if (closing) return;
  closing = true;
  for (const child of children) child.kill();
  await Promise.all([
    new Promise((resolve) => apiServer.close(resolve)),
    new Promise((resolve) => realtimeServer.close(resolve))
  ]);
}

process.once("SIGINT", async () => {
  await closeAll();
  process.exit(130);
});

let exitCode = 1;
try {
  await new Promise((resolve, reject) => apiServer.listen(apiPort, "127.0.0.1", resolve).once("error", reject));
  spawnFrontend(
    "meeting frontend",
    path.join(repositoryRoot, "frontend", "apps", "meeting"),
    meetingFrontendPort,
    {
      MEETING_API_URL: `http://127.0.0.1:${apiPort}`,
      REALTIME_WS_URL: `ws://127.0.0.1:${realtimePort}`,
      RECOGNITION_E2E_FIXTURE_ENABLED: "true"
    }
  );
  spawnFrontend(
    "shell frontend",
    path.join(repositoryRoot, "frontend", "apps", "shell"),
    shellFrontendPort,
    { MEETING_REMOTE_URL: `http://127.0.0.1:${meetingFrontendPort}/remoteEntry.js` }
  );
  await Promise.all([
    waitFor(`http://127.0.0.1:${meetingFrontendPort}/remoteEntry.js`, "meeting frontend"),
    waitFor(`http://127.0.0.1:${shellFrontendPort}`, "shell frontend")
  ]);

  const playwrightCli = path.join(repositoryRoot, "node_modules", "@playwright", "test", "cli.js");
  const playwright = spawn(process.execPath, [
    playwrightCli,
    "test",
    "tests/e2e/accessible-conversation.spec.ts",
    "--project=chromium",
    "--workers=1"
  ], {
    cwd: repositoryRoot,
    env: {
      ...process.env,
      PLAYWRIGHT_JSON_OUTPUT_FILE: "test-results/playwright/conversation-chromium.json",
      SIGNCONNECT_E2E_BASE_URL: `http://127.0.0.1:${shellFrontendPort}`
    },
    stdio: "inherit",
    windowsHide: true
  });
  exitCode = await new Promise((resolve) => playwright.once("exit", (code) => resolve(code ?? 1)));
} finally {
  await closeAll();
}

process.exitCode = exitCode;
