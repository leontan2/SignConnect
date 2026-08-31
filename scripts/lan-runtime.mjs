#!/usr/bin/env node

import process from "node:process";
import path from "node:path";
import { isIP } from "node:net";
import { fileURLToPath } from "node:url";

export function describeLanRuntime(host) {
  const octets = host.split(".").map(Number);
  const isPrivate = isIP(host) === 4 && (
    octets[0] === 10
    || (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31)
    || (octets[0] === 192 && octets[1] === 168)
  );
  if (!isPrivate) throw new Error("--host must be a private IPv4 address");

  const origin = `http://${host}:3000`;

  return {
    host,
    url: `${origin}/`,
    browser: {
      meetingApiUrl: origin,
      meetingRemoteUrl: `${origin}/meeting-assets/remoteEntry.js`,
      realtimeWebSocketUrl: `ws://${host}:3000`
    },
    clientBrowser: {
      mode: "isolated-development-profile",
      secureOriginOverrideRequired: true,
      secureOrigin: origin
    },
    exposedServices: [
      { name: "HTTP gateway", address: host, port: 3000 }
    ],
    internalServices: [
      { name: "Meeting frontend", address: "127.0.0.1", port: 3001 },
      { name: "Meeting API", address: "127.0.0.1", port: 8081 },
      { name: "Realtime service", address: "127.0.0.1", port: 8082 },
      { name: "Sign inference", address: "127.0.0.1", port: 8083 }
    ],
    previewToolsEnabled: false
  };
}

function readOption(args, option) {
  const index = args.indexOf(option);
  return index >= 0 ? args[index + 1] : undefined;
}

function main(args) {
  if (args[0] !== "describe") {
    throw new Error("Usage: node scripts/lan-runtime.mjs describe --host <private-ipv4>");
  }

  const host = readOption(args, "--host");
  if (!host) throw new Error("--host is required");
  process.stdout.write(`${JSON.stringify(describeLanRuntime(host), null, 2)}\n`);
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : undefined;
if (invokedPath === fileURLToPath(import.meta.url)) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
