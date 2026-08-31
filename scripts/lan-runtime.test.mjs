import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { networkInterfaces } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const runtimeScript = path.join(repositoryRoot, "scripts", "lan-runtime.mjs");
const launcherScript = path.join(repositoryRoot, "scripts", "start-lan-asl-research.ps1");
const clientLauncherScript = path.join(repositoryRoot, "scripts", "open-signconnect-lan-client.ps1");

function describeRuntime(host) {
  const result = spawnSync(process.execPath, [runtimeScript, "describe", "--host", host], {
    cwd: repositoryRoot,
    encoding: "utf8"
  });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  return JSON.parse(result.stdout);
}

function findActivePrivateIpv4() {
  const addresses = Object.values(networkInterfaces())
    .flatMap((entries) => entries ?? [])
    .filter((entry) => entry.family === "IPv4" && !entry.internal)
    .map((entry) => entry.address);
  const isPreferredPrivateAddress = (address) => {
    const octets = address.split(".").map(Number);
    return octets[0] === 10
      || (octets[0] === 192 && octets[1] === 168);
  };
  const privateAddress = addresses.find(isPreferredPrivateAddress)
    ?? addresses.find((address) => {
      const octets = address.split(".").map(Number);
      return octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31;
    });

  assert.ok(privateAddress, "An active private IPv4 address is required for the LAN launcher test.");
  return privateAddress;
}

test("LAN runtime exposes one HTTP origin and keeps application services behind its gateway", () => {
  assert.deepEqual(describeRuntime("192.168.1.6"), {
    host: "192.168.1.6",
    url: "http://192.168.1.6:3000/",
    browser: {
      meetingApiUrl: "http://192.168.1.6:3000",
      meetingRemoteUrl: "http://192.168.1.6:3000/meeting-assets/remoteEntry.js",
      realtimeWebSocketUrl: "ws://192.168.1.6:3000"
    },
    clientBrowser: {
      mode: "isolated-development-profile",
      secureOriginOverrideRequired: true,
      secureOrigin: "http://192.168.1.6:3000"
    },
    exposedServices: [
      { name: "HTTP gateway", address: "192.168.1.6", port: 3000 }
    ],
    internalServices: [
      { name: "Meeting frontend", address: "127.0.0.1", port: 3001 },
      { name: "Meeting API", address: "127.0.0.1", port: 8081 },
      { name: "Realtime service", address: "127.0.0.1", port: 8082 },
      { name: "Sign inference", address: "127.0.0.1", port: 8083 }
    ],
    previewToolsEnabled: false
  });
});

test("LAN runtime rejects loopback, wildcard, public, and malformed hosts", () => {
  for (const host of ["127.0.0.1", "0.0.0.0", "8.8.8.8", "192.168.1.6/path"]) {
    const result = spawnSync(process.execPath, [runtimeScript, "describe", "--host", host], {
      cwd: repositoryRoot,
      encoding: "utf8"
    });

    assert.notEqual(result.status, 0, host);
    assert.match(result.stderr, /private IPv4 address/);
  }
});

test("Webpack LAN mode serves one HTTP gateway and compiles same-origin browser routes", () => {
  const inspection = String.raw`
    const shell = require("./frontend/apps/shell/webpack.config.cjs");
    const meeting = require("./frontend/apps/meeting/webpack.config.cjs");
    const federation = shell.plugins.find((plugin) => plugin.options?.remotes);
    const definitions = meeting.plugins.find((plugin) => plugin.definitions)?.definitions;
    process.stdout.write(JSON.stringify({
      shell: {
        host: shell.devServer.host,
        allowedHosts: shell.devServer.allowedHosts,
        remote: federation?.options.remotes.meeting,
        proxies: shell.devServer.proxy?.map((proxy) => ({
          context: proxy.context,
          target: proxy.target,
          ws: proxy.ws === true,
          pathRewrite: proxy.pathRewrite
        }))
      },
      meeting: {
        host: meeting.devServer.host,
        hot: meeting.devServer.hot,
        client: meeting.devServer.client,
        apiUrl: JSON.parse(definitions["process.env.MEETING_API_URL"]),
        realtimeUrl: JSON.parse(definitions["process.env.REALTIME_WS_URL"]),
        previewTools: JSON.parse(definitions["process.env.ROOM_PREVIEW_TOOLS_ENABLED"])
      }
    }));
  `;

  const result = spawnSync(process.execPath, ["-e", inspection], {
    cwd: repositoryRoot,
    encoding: "utf8",
    env: {
      ...process.env,
      SIGNCONNECT_LAN_MODE: "true",
      SIGNCONNECT_LAN_HOST: "192.168.1.6",
      MEETING_API_URL: "http://192.168.1.6:3000",
      REALTIME_WS_URL: "ws://192.168.1.6:3000",
      MEETING_REMOTE_URL: "http://192.168.1.6:3000/meeting-assets/remoteEntry.js",
      ROOM_PREVIEW_TOOLS_ENABLED: "false"
    }
  });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.deepEqual(JSON.parse(result.stdout), {
      shell: {
        host: "192.168.1.6",
        allowedHosts: ["192.168.1.6", "localhost", "127.0.0.1"],
        remote: "meeting@http://192.168.1.6:3000/meeting-assets/remoteEntry.js",
        proxies: [
          {
            context: ["/meeting-assets"],
            target: "http://127.0.0.1:3001",
            ws: false,
            pathRewrite: { "^/meeting-assets": "" }
          },
          {
            context: ["/api"],
            target: "http://127.0.0.1:8081",
            ws: false
          },
          {
            context: ["/ws/v1"],
            target: "ws://127.0.0.1:8082",
            ws: true
          }
        ]
      },
      meeting: {
        host: "127.0.0.1",
        hot: false,
        client: false,
        apiUrl: "http://192.168.1.6:3000",
        realtimeUrl: "ws://192.168.1.6:3000",
        previewTools: "false"
      }
  });
});

test("LAN launcher dry run reports the private URL without starting services", {
  skip: process.platform !== "win32"
}, () => {
  const lanHost = findActivePrivateIpv4();
  const result = spawnSync("powershell.exe", [
    "-NoProfile",
    "-ExecutionPolicy", "Bypass",
    "-File", launcherScript,
    "-LanHost", lanHost,
    "-DryRun"
  ], {
    cwd: repositoryRoot,
    encoding: "utf8"
  });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  const runtime = JSON.parse(result.stdout);
  assert.equal(runtime.url, `http://${lanHost}:3000/`);
  assert.deepEqual(runtime.exposedServices, [
    { name: "HTTP gateway", address: lanHost, port: 3000 }
  ]);
  assert.equal(runtime.clientBrowser.secureOriginOverrideRequired, true);
  assert.equal(runtime.previewToolsEnabled, false);
});

test("client launcher limits the secure-origin override to SignConnect in an isolated profile", {
  skip: process.platform !== "win32"
}, () => {
  const result = spawnSync("powershell.exe", [
    "-NoProfile",
    "-ExecutionPolicy", "Bypass",
    "-File", clientLauncherScript,
    "-ServerAddress", "192.168.1.6",
    "-DryRun"
  ], {
    cwd: repositoryRoot,
    encoding: "utf8"
  });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  const launch = JSON.parse(result.stdout);
  assert.equal(launch.origin, "http://192.168.1.6:3000");
  assert.equal(
    launch.secureOriginSwitch,
    "--unsafely-treat-insecure-origin-as-secure=http://192.168.1.6:3000"
  );
  assert.match(launch.profilePath, /SignConnect[\\/]LanBrowserProfile$/);
});

test("client launcher rejects public, loopback, and malformed server addresses", {
  skip: process.platform !== "win32"
}, () => {
  for (const address of ["8.8.8.8", "127.0.0.1", "192.168.1.6/path"]) {
    const result = spawnSync("powershell.exe", [
      "-NoProfile",
      "-ExecutionPolicy", "Bypass",
      "-File", clientLauncherScript,
      "-ServerAddress", address,
      "-DryRun"
    ], {
      cwd: repositoryRoot,
      encoding: "utf8"
    });

    assert.notEqual(result.status, 0, address);
    assert.match(result.stderr, /private IPv4 address/);
  }
});
