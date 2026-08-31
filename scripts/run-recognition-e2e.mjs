import { execFile, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import assert from "node:assert/strict";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const backendRoot = path.join(repositoryRoot, "backend");
const maximumLogCharacters = 24_000;
const startupDeadlineMs = 60_000;
const shutdownDeadlineMs = 5_000;
const controlledServices = new Set(["inference", "realtime"]);
const ownedProcesses = new Map();
const redactionSecrets = new Set();

export class RunnerLifecycle {
  constructor() {
    this.closing = false;
    this.abortController = new AbortController();
  }

  assertOpen() {
    if (this.closing || this.abortController.signal.aborted) {
      throw new Error("The E2E runner is closing; no new process may be started.");
    }
  }

  beginClose(reason = new Error("The E2E runner is closing.")) {
    if (this.closing) return false;
    this.closing = true;
    this.abortController.abort(reason);
    return true;
  }

  get signal() {
    return this.abortController.signal;
  }
}

const lifecycle = new RunnerLifecycle();

function usage() {
  return [
    "Usage: node scripts/run-recognition-e2e.mjs [options]",
    "",
    "  --project=chromium|chrome|edge  Browser for correctness tests (default: chromium)",
    "  --approved-genuine-model       Reserved; fails closed until a reviewed-fixture browser consumer exists",
    "  --performance                  Run only the tagged bundled-Chromium latency spec",
    "  --simulator                    Enable the explicit client/server development simulator",
    "  --skip-build                   Reuse existing executable backend jars",
    "  --self-test                    Run the bounded lifecycle race regression only",
    "  --help                         Show this help",
    "",
    "Approved genuine-model environment (private path values are not logged):",
    "  SIGNCONNECT_E2E_APPROVED_MODEL_PATH       Approved ONNX artifact",
    "  SIGNCONNECT_E2E_APPROVED_METADATA_PATH    Approved model metadata JSON",
    "  SIGNCONNECT_E2E_REVIEWED_FIXTURE_PATH     Private reviewed browser fixture"
  ].join("\n");
}

function parseOptions(argv) {
  const options = {
    approvedGenuineModel: false,
    performance: false,
    project: "chromium",
    selfTest: false,
    simulator: false,
    skipBuild: false
  };
  for (const argument of argv) {
    if (argument === "--approved-genuine-model") options.approvedGenuineModel = true;
    else if (argument === "--performance") options.performance = true;
    else if (argument === "--simulator") options.simulator = true;
    else if (argument === "--skip-build") options.skipBuild = true;
    else if (argument === "--self-test") options.selfTest = true;
    else if (argument === "--help") {
      console.log(usage());
      process.exit(0);
    } else if (argument.startsWith("--project=")) {
      options.project = argument.slice("--project=".length);
    } else {
      throw new Error(`Unknown option '${argument}'.\n${usage()}`);
    }
  }
  if (!["chromium", "chrome", "edge"].includes(options.project)) {
    throw new Error(`Unsupported browser project '${options.project}'.`);
  }
  if (options.performance && options.project !== "chromium") {
    throw new Error("The performance profile intentionally uses bundled Chromium only.");
  }
  if (options.approvedGenuineModel && options.simulator) {
    throw new Error("--approved-genuine-model cannot be combined with --simulator.");
  }
  if (options.approvedGenuineModel && options.performance) {
    throw new Error("--approved-genuine-model cannot be combined with --performance.");
  }
  if (options.selfTest && (options.approvedGenuineModel || options.performance || options.simulator
      || options.skipBuild || options.project !== "chromium")) {
    throw new Error("--self-test cannot be combined with stack-runner options.");
  }
  return options;
}

function rememberSecret(value) {
  if (typeof value === "string" && value.length >= 4) redactionSecrets.add(value.slice(0, 2_048));
}

function isSensitiveEnvironmentName(name) {
  return /(?:TOKEN|SECRET|PASSWORD|PASSWD|API_?KEY|PRIVATE_?KEY|ACCESS_?KEY|CREDENTIAL|AUTH|CONNECTION_?STRING|COOKIE|SESSION)/i.test(name);
}

function redactSecrets(value) {
  let result = String(value);
  for (const secret of redactionSecrets) {
    result = result.split(secret).join("[REDACTED secret]");
  }
  return result
    .replace(/(authorization\s*[:=]\s*(?:bearer\s+)?)[^\s,;]+/gi, "$1[REDACTED]")
    .replace(/((?:token|secret|password|passwd|api[_-]?key|credential)\s*[:=]\s*)[^\s,;]+/gi, "$1[REDACTED]");
}

function sanitizeLogText(value) {
  return redactSecrets(value)
    .split(/\r?\n/)
    .map((line) => {
      if (/(?:"features"\s*:|"frames"\s*:|tensor\s*[=:]|landmark[^\r\n]*\[)/i.test(line)) {
        return "[REDACTED landmark/tensor array log line]";
      }
      return line.length > 2_000 ? `${line.slice(0, 2_000)}...[truncated]` : line;
    })
    .join("\n");
}

class BoundedLog {
  constructor() {
    this.value = "";
    this.pending = "";
    this.redactionDepth = 0;
    this.redactionEscape = false;
    this.redactionString = false;
  }

  append(chunk) {
    this.process(`${this.pending}${String(chunk)}`, false);
  }

  appendSafe(value) {
    this.value += sanitizeLogText(value);
    if (this.value.length > maximumLogCharacters) {
      this.value = `[earlier output omitted]\n${this.value.slice(-maximumLogCharacters)}`;
    }
  }

  consumeSensitiveArray(value, startIndex) {
    for (let index = startIndex; index < value.length; index += 1) {
      const character = value[index];
      if (this.redactionString) {
        if (this.redactionEscape) this.redactionEscape = false;
        else if (character === "\\") this.redactionEscape = true;
        else if (character === '"') this.redactionString = false;
        continue;
      }
      if (character === '"') this.redactionString = true;
      else if (character === "[") this.redactionDepth += 1;
      else if (character === "]") {
        this.redactionDepth -= 1;
        if (this.redactionDepth === 0) return index + 1;
      }
    }
    return value.length;
  }

  process(value, final) {
    this.pending = "";
    let remaining = value;
    const marker = /(?:"(?:features|frames)"\s*:|(?:tensor|landmark)[^=\r\n]{0,80}[=:])\s*\[/i;
    while (remaining.length > 0) {
      if (this.redactionDepth > 0) {
        const consumed = this.consumeSensitiveArray(remaining, 0);
        remaining = remaining.slice(consumed);
        if (this.redactionDepth > 0) return;
        continue;
      }

      const match = marker.exec(remaining);
      if (match?.index !== undefined) {
        this.appendSafe(remaining.slice(0, match.index));
        this.appendSafe("[REDACTED landmark/tensor array]");
        const bracketIndex = match.index + match[0].lastIndexOf("[");
        this.redactionDepth = 0;
        this.redactionEscape = false;
        this.redactionString = false;
        const consumed = this.consumeSensitiveArray(remaining, bracketIndex);
        remaining = remaining.slice(consumed);
        if (this.redactionDepth > 0) return;
        continue;
      }

      const longestSecret = Math.max(0, ...Array.from(redactionSecrets, (secret) => secret.length));
      const carryCharacters = final ? 0 : Math.min(2_176, Math.max(256, longestSecret + 128));
      if (remaining.length <= carryCharacters) {
        this.pending = remaining;
        return;
      }
      const safeLength = remaining.length - carryCharacters;
      this.appendSafe(remaining.slice(0, safeLength));
      this.pending = remaining.slice(safeLength);
      return;
    }
  }

  toString() {
    if (this.pending) this.process(this.pending, true);
    return this.value.trim();
  }
}

class WebpackCompilationInspector {
  constructor() {
    this.buffer = "";
    this.state = "pending";
  }

  append(chunk) {
    const text = String(chunk).replace(/\u001b\[[0-9;]*m/g, "");
    this.buffer = `${this.buffer}${text}`.slice(-12_000);
    const terminalStates = Array.from(this.buffer.matchAll(/(?:webpack\s+[^\r\n]*\s+)?compiled\s+(successfully|with\s+\d+\s+(?:warnings?|errors?))/gi));
    const lastTerminal = terminalStates.at(-1);
    const lastTerminalIndex = lastTerminal?.index ?? -1;
    const lowerBuffer = this.buffer.toLowerCase();
    const lastErrorIndex = Math.max(
      lowerBuffer.lastIndexOf("failed to compile"),
      lowerBuffer.lastIndexOf("error in ")
    );
    if (lastErrorIndex > lastTerminalIndex) this.state = "error";
    else if (lastTerminal) this.state = lastTerminal[1].toLowerCase().includes("error") ? "error" : "success";
  }
}

function redactOutput(value) {
  const log = new BoundedLog();
  log.append(value);
  return log.toString();
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function abortableDelay(milliseconds, signal = lifecycle.signal) {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(done, milliseconds);
    function done() {
      signal.removeEventListener("abort", aborted);
      resolve();
    }
    function aborted() {
      clearTimeout(timeout);
      signal.removeEventListener("abort", aborted);
      reject(signal.reason);
    }
    signal.addEventListener("abort", aborted, { once: true });
  });
}

export function sanitizedEnvironment(overrides = {}, source = process.env) {
  const environment = { ...source };
  const removed = new Set([
    "SERVER_PORT",
    "SIGN_MODEL_RESOURCE",
    "SIGN_MODEL_LABELS_RESOURCE",
    "SIGN_MODEL_INPUT_NAME",
    "SIGN_MODEL_OUTPUT_NAME",
    "SIGN_INFERENCE_URL",
    "SIGN_INFERENCE_TIMEOUT",
    "SIGN_RECOGNITION_WINDOW_FRAMES",
    "SIGN_RECOGNITION_STRIDE_FRAMES",
    "SIGN_RECOGNITION_CONFIDENCE_THRESHOLD",
    "SIGN_RECOGNITION_STABLE_ACTIVE_EVALUATIONS",
    "SIGN_RECOGNITION_IDLE_EVALUATIONS",
    "SIGN_RECOGNITION_DUPLICATE_COOLDOWN",
    "SIGN_RECOGNITION_UNKNOWN_RATE_LIMIT",
    "SIGN_RECOGNITION_TRACKING_TIMEOUT",
    "SIGN_RECOGNITION_MAX_MESSAGE_SIZE",
    "SIGNCONNECT_RECOGNITION_SIMULATOR_ENABLED",
    "RECOGNITION_E2E_FIXTURE_ENABLED",
    "RECOGNITION_SIMULATOR_ENABLED",
    "JAVA_TOOL_OPTIONS",
    "_JAVA_OPTIONS",
    "JDK_JAVA_OPTIONS",
    "MAVEN_OPTS",
    "MAVEN_ARGS",
    "NODE_OPTIONS",
    "NODE_DEBUG",
    "NODE_DEBUG_NATIVE",
    "DEBUG",
    "TRACE",
    "PWDEBUG",
    "SIGNCONNECT_E2E_CONTROL_TOKEN"
  ]);
  for (const key of Object.keys(environment)) {
    const normalized = key.toUpperCase();
    const configOrLogOverride = normalized.startsWith("SPRING_") ||
      normalized.startsWith("LOGGING_") ||
      normalized.startsWith("MANAGEMENT_") ||
      normalized.startsWith("SERVER_");
    const applicationOverride = normalized.startsWith("SIGN_") ||
      normalized.startsWith("SIGNCONNECT_") ||
      normalized.startsWith("RECOGNITION_") ||
      normalized.startsWith("MEETING_") ||
      normalized.startsWith("REALTIME_");
    const likelySecret = isSensitiveEnvironmentName(normalized);
    if (likelySecret) rememberSecret(environment[key]);
    if (removed.has(normalized) || configOrLogOverride || applicationOverride || likelySecret) delete environment[key];
  }
  for (const [key, value] of Object.entries(overrides)) {
    if (isSensitiveEnvironmentName(key)) {
      rememberSecret(value);
    }
  }
  return { ...environment, ...overrides };
}

export function guardedSpawn(runnerLifecycle, start) {
  runnerLifecycle.assertOpen();
  return start();
}

function spawnOwned(name, command, args, options = {}, runnerLifecycle = lifecycle) {
  if (ownedProcesses.has(name)) throw new Error(`Process '${name}' is already running.`);
  const log = new BoundedLog();
  const child = guardedSpawn(runnerLifecycle, () => spawn(command, args, {
    cwd: options.cwd ?? repositoryRoot,
    env: options.env ?? sanitizedEnvironment(),
    detached: process.platform !== "win32",
    shell: false,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true
  }));
  child.stdout?.on("data", (chunk) => {
    log.append(chunk);
    options.outputInspector?.append(chunk);
  });
  child.stderr?.on("data", (chunk) => {
    log.append(chunk);
    options.outputInspector?.append(chunk);
  });

  let resolveExit;
  const exited = new Promise((resolve) => {
    resolveExit = resolve;
  });
  const record = {
    child,
    command,
    args,
    exited,
    exitedState: null,
    log,
    name,
    terminating: null
  };
  child.once("error", (error) => {
    log.append(`Process launch failed: ${error.message}`);
    if (!record.exitedState) {
      record.exitedState = { code: null, signal: null };
      resolveExit(record.exitedState);
    }
  });
  child.once("exit", (code, signal) => {
    if (record.exitedState) return;
    record.exitedState = { code, signal };
    resolveExit(record.exitedState);
  });
  ownedProcesses.set(name, record);
  return record;
}

async function waitForProcess(record) {
  const result = await record.exited;
  if (ownedProcesses.get(record.name) === record && !record.terminating) {
    // A preparation command that completed normally no longer has an owned
    // live root PID. Dropping it avoids ever targeting a later PID reuse.
    ownedProcesses.delete(record.name);
  }
  return result;
}

export function exactTreeTerminationTarget(pid, platform = process.platform, systemRoot = process.env.SystemRoot || "C:\\Windows") {
  if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error("An exact positive owned process ID is required.");
  if (platform === "win32") {
    return {
      command: path.join(systemRoot, "System32", "taskkill.exe"),
      args: ["/PID", String(pid), "/T", "/F"]
    };
  }
  return { processGroupId: -pid };
}

function runExactWindowsTreeKill(target) {
  return new Promise((resolve) => {
    execFile(target.command, target.args, {
      env: sanitizedEnvironment(),
      timeout: shutdownDeadlineMs,
      windowsHide: true
    }, () => resolve());
  });
}

async function signalExactProcessTree(record, signal) {
  const pid = record.child.pid;
  if (!Number.isSafeInteger(pid) || pid <= 0) return;
  const target = exactTreeTerminationTarget(pid);
  if ("command" in target) {
    await runExactWindowsTreeKill(target);
    return;
  }
  try {
    process.kill(target.processGroupId, signal);
  } catch (error) {
    if (error?.code !== "ESRCH") throw error;
  }
}

async function terminateOwned(name) {
  const record = ownedProcesses.get(name);
  if (!record) return true;
  if (record.terminating) {
    const stopped = await record.terminating;
    if (!stopped && record.exitedState && ownedProcesses.get(name) === record) {
      ownedProcesses.delete(name);
      return true;
    }
    return stopped;
  }
  record.terminating = (async () => {
    if (process.platform === "win32") {
      await signalExactProcessTree(record, "SIGKILL");
    } else {
      await signalExactProcessTree(record, "SIGTERM");
      await Promise.race([record.exited, delay(shutdownDeadlineMs)]);
      await signalExactProcessTree(record, "SIGKILL");
    }
    await Promise.race([record.exited, delay(shutdownDeadlineMs)]);
    const stopped = Boolean(record.exitedState);
    if (stopped && ownedProcesses.get(name) === record) ownedProcesses.delete(name);
    return stopped;
  })();
  return record.terminating;
}

async function runPreparation(name, command, args, options = {}) {
  const record = spawnOwned(name, command, args, options);
  const result = await waitForProcess(record);
  if (result.code !== 0) {
    throw new Error(`${name} failed with exit code ${result.code}.\n${record.log.toString()}`);
  }
  return record.log.toString();
}

function isPortOpen(port) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host: "127.0.0.1", port });
    let settled = false;
    const finish = (open) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(open);
    };
    socket.setTimeout(350);
    socket.once("connect", () => finish(true));
    socket.once("timeout", () => finish(false));
    socket.once("error", () => finish(false));
  });
}

async function requireFreePorts(ports) {
  const occupied = [];
  for (const port of ports) {
    if (await isPortOpen(port)) occupied.push(port);
  }
  if (occupied.length > 0) {
    throw new Error(`Required ports are already in use: ${occupied.join(", ")}. The runner will not stop unowned processes.`);
  }
}

async function waitForPortClosed(port, deadlineMs = shutdownDeadlineMs) {
  const deadline = Date.now() + deadlineMs;
  while (Date.now() < deadline) {
    if (!(await isPortOpen(port))) return;
    await abortableDelay(100);
  }
  throw new Error(`Owned service on port ${port} did not release its port before the deadline.`);
}

async function waitForHttp(name, url, deadlineMs = startupDeadlineMs) {
  const deadline = Date.now() + deadlineMs;
  while (Date.now() < deadline) {
    const record = ownedProcesses.get(name);
    if (!record || record.exitedState) {
      throw new Error(`${name} exited before readiness.\n${record?.log.toString() ?? "No process output."}`);
    }
    try {
      const response = await fetch(url, {
        signal: AbortSignal.any([lifecycle.signal, AbortSignal.timeout(1_500)])
      });
      if (response.ok) return;
    } catch (error) {
      if (lifecycle.signal.aborted) throw lifecycle.signal.reason;
      // Startup races are expected until the bounded deadline expires.
    }
    await abortableDelay(200);
  }
  const record = ownedProcesses.get(name);
  throw new Error(`${name} did not become ready at ${url}.\n${record?.log.toString() ?? "No process output."}`);
}

async function waitForFrontend(name, url, inspector, deadlineMs = startupDeadlineMs) {
  const deadline = Date.now() + deadlineMs;
  while (Date.now() < deadline) {
    const record = ownedProcesses.get(name);
    if (!record || record.exitedState) {
      throw new Error(`${name} exited before readiness.\n${record?.log.toString() ?? "No process output."}`);
    }
    if (inspector.state === "error") {
      throw new Error(`${name} reported a webpack compilation error.\n${record.log.toString()}`);
    }
    if (inspector.state === "success") {
      try {
        const response = await fetch(url, {
          signal: AbortSignal.any([lifecycle.signal, AbortSignal.timeout(1_500)])
        });
        if (response.ok) return;
      } catch (error) {
        if (lifecycle.signal.aborted) throw lifecycle.signal.reason;
      }
    }
    await abortableDelay(200);
  }
  const record = ownedProcesses.get(name);
  throw new Error(`${name} did not reach a successful webpack compile plus HTTP readiness at ${url}.\n${record?.log.toString() ?? "No process output."}`);
}

function javaExecutable() {
  const javaHome = process.env.JAVA_HOME;
  if (!javaHome) return "java";
  const executable = path.join(javaHome, "bin", process.platform === "win32" ? "java.exe" : "java");
  if (!existsSync(executable)) {
    throw new Error(`JAVA_HOME does not contain a Java executable: ${javaHome}`);
  }
  return executable;
}

function backendJar(moduleName) {
  return path.join(backendRoot, moduleName, "target", `${moduleName}-0.1.0-SNAPSHOT.jar`);
}

function javaRuntimeArguments() {
  if (process.platform !== "win32") return ["-Djava.awt.headless=true"];
  return [
    "-Djdk.net.unixdomain.tmpdir=C:\\jtmp",
    "-Djava.awt.headless=true"
  ];
}

function backendDefinition(name, simulatorEnabled, approvedConfiguration = null) {
  const executable = javaExecutable();
  if (name === "meeting") {
    return {
      command: executable,
      args: [...javaRuntimeArguments(), "-jar", backendJar("meeting-service"), "--server.address=127.0.0.1", "--server.port=8081"],
      env: sanitizedEnvironment(),
      health: "http://127.0.0.1:8081/actuator/health",
      port: 8081
    };
  }
  if (name === "inference") {
    const args = [
      ...javaRuntimeArguments(),
      "-jar",
      backendJar("sign-inference-service"),
      "--server.address=127.0.0.1",
      "--server.port=8083"
    ];
    if (!approvedConfiguration) args.push("--spring.profiles.active=local");
    return {
      command: executable,
      args,
      env: sanitizedEnvironment(approvedConfiguration ? {
        SIGN_MODEL_RESOURCE: approvedConfiguration.modelResource,
        SIGN_MODEL_LABELS_RESOURCE: approvedConfiguration.labelsResource,
        SIGN_MODEL_EXPECTED_VERSION: approvedConfiguration.expectedModelVersion,
        SIGN_MODEL_ALLOW_MOCK_MODEL: "false"
      } : {}),
      health: "http://127.0.0.1:8083/actuator/health/readiness",
      port: 8083
    };
  }
  if (name === "realtime") {
    const args = [
      ...javaRuntimeArguments(),
      "-jar",
      backendJar("realtime-service"),
      "--server.address=127.0.0.1",
      "--server.port=8082",
      "--signconnect.recognition.inference-url=http://127.0.0.1:8083",
      "--signconnect.recognition.inference-timeout=500ms",
      `--signconnect.recognition.simulator-enabled=${simulatorEnabled ? "true" : "false"}`
    ];
    if (simulatorEnabled) args.push("--spring.profiles.active=development");
    return {
      command: executable,
      args,
      env: sanitizedEnvironment(),
      health: "http://127.0.0.1:8082/actuator/health",
      port: 8082
    };
  }
  throw new Error(`Unknown backend service '${name}'.`);
}

async function startBackend(name, simulatorEnabled, approvedConfiguration = null) {
  lifecycle.assertOpen();
  const definition = backendDefinition(name, simulatorEnabled, approvedConfiguration);
  if (!existsSync(definition.args[definition.args.indexOf("-jar") + 1])) {
    throw new Error(`Executable jar is missing for ${name}. Run without --skip-build first.`);
  }
  console.log(`Starting ${name} service...`);
  spawnOwned(name, definition.command, definition.args, {
    cwd: repositoryRoot,
    env: definition.env
  });
  await waitForHttp(name, definition.health);
  console.log(`${name} service is ready.`);
}

function frontendDefinition(name, simulatorEnabled, approvedConfiguration = null) {
  const webpackCli = path.join(repositoryRoot, "node_modules", "webpack", "bin", "webpack.js");
  if (!existsSync(webpackCli)) throw new Error("Webpack is not installed. Run npm install first.");
  if (name === "meeting-frontend") {
    return {
      command: process.execPath,
      args: [webpackCli, "serve", "--config", "webpack.config.cjs", "--mode", "development", "--host", "127.0.0.1"],
      cwd: path.join(repositoryRoot, "frontend", "apps", "meeting"),
      env: sanitizedEnvironment({
        MEETING_API_URL: "http://127.0.0.1:8081",
        REALTIME_WS_URL: "ws://127.0.0.1:8082",
        RECOGNITION_E2E_FIXTURE_ENABLED: approvedConfiguration ? "false" : "true",
        RECOGNITION_SIMULATOR_ENABLED: simulatorEnabled ? "true" : "false"
      }),
      health: "http://127.0.0.1:3001/remoteEntry.js"
    };
  }
  if (name === "shell-frontend") {
    return {
      command: process.execPath,
      args: [webpackCli, "serve", "--config", "webpack.config.cjs", "--mode", "development", "--host", "127.0.0.1"],
      cwd: path.join(repositoryRoot, "frontend", "apps", "shell"),
      env: sanitizedEnvironment({
        MEETING_REMOTE_URL: "http://127.0.0.1:3001/remoteEntry.js"
      }),
      health: "http://127.0.0.1:3000/"
    };
  }
  throw new Error(`Unknown frontend '${name}'.`);
}

async function startFrontend(name, simulatorEnabled, approvedConfiguration = null) {
  lifecycle.assertOpen();
  const definition = frontendDefinition(name, simulatorEnabled, approvedConfiguration);
  const compilation = new WebpackCompilationInspector();
  console.log(`Starting ${name}...`);
  spawnOwned(name, definition.command, definition.args, {
    cwd: definition.cwd,
    env: definition.env,
    outputInspector: compilation
  });
  const record = ownedProcesses.get(name);
  record.compilation = compilation;
  await waitForFrontend(name, definition.health, compilation);
  console.log(`${name} is ready.`);
}

async function buildBackend() {
  const wrapper = path.join(backendRoot, process.platform === "win32" ? "mvnw.cmd" : "mvnw");
  if (!existsSync(wrapper)) throw new Error("The Maven wrapper is missing.");
  console.log("Packaging executable backend jars (tests are covered by scripts/verify.ps1)...");
  if (process.platform === "win32") {
    const commandProcessor = process.env.ComSpec || "C:\\Windows\\System32\\cmd.exe";
    await runPreparation(
      "backend-package",
      commandProcessor,
      ["/d", "/s", "/c", "mvnw.cmd --no-transfer-progress -q -DskipTests package"],
      { cwd: backendRoot, env: sanitizedEnvironment() }
    );
  } else {
    await runPreparation(
      "backend-package",
      "sh",
      [wrapper, "--no-transfer-progress", "-q", "-DskipTests", "package"],
      { cwd: backendRoot, env: sanitizedEnvironment() }
    );
  }
  console.log("Backend jars are packaged.");
}

function playwrightSelection(options) {
  if (options.performance) {
    return {
      project: "performance",
      target: "tests/performance/sign-recognition-latency.spec.ts",
      grep: null
    };
  }
  if (options.simulator) {
    return {
      project: options.project,
      target: "tests/e2e",
      grep: "@simulator"
    };
  }
  return {
    project: options.project,
    target: "tests/e2e",
    grep: null
  };
}

export function approvedGenuineModelConfiguration(options, _environment = process.env) {
  if (!options.approvedGenuineModel) return null;
  throw new Error(
    "Approved genuine-model E2E is unavailable: no dedicated reviewed-fixture consumer exists, so no evidence report can be created."
  );
}

export function playwrightJsonReportPath(options, root = repositoryRoot) {
  const reportName = options.performance
    ? "performance"
    : options.approvedGenuineModel
      ? `approved-genuine-${options.project}`
      : options.simulator
        ? `simulator-${options.project}`
        : options.project;
  return path.join(root, "test-results", "playwright", `${reportName}.json`);
}

function playwrightEnvironment(options, control, approvedConfiguration = null) {
  return sanitizedEnvironment({
    PLAYWRIGHT_HTML_OPEN: "never",
    PLAYWRIGHT_JSON_OUTPUT_FILE: playwrightJsonReportPath(options),
    SIGNCONNECT_E2E_BASE_URL: "http://127.0.0.1:3000",
    SIGNCONNECT_E2E_CONTROL_URL: control.url,
    SIGNCONNECT_E2E_CONTROL_TOKEN: control.token,
    SIGNCONNECT_E2E_SIMULATOR: options.simulator ? "true" : "false",
    SIGNCONNECT_E2E_APPROVED_GENUINE_MODEL: approvedConfiguration ? "true" : "false",
    ...(approvedConfiguration ? {
      SIGNCONNECT_E2E_REVIEWED_FIXTURE_PATH: approvedConfiguration.reviewedFixturePath
    } : {})
  });
}

async function runPlaywright(options, control, approvedConfiguration = null) {
  lifecycle.assertOpen();
  for (const name of ["meeting-frontend", "shell-frontend"]) {
    const record = ownedProcesses.get(name);
    if (!record || record.exitedState || record.compilation?.state !== "success") {
      throw new Error(`${name} is not in a successful compiled state before Playwright.\n${record?.log.toString() ?? "No process output."}`);
    }
  }
  const playwrightCli = path.join(repositoryRoot, "node_modules", "@playwright", "test", "cli.js");
  if (!existsSync(playwrightCli)) throw new Error("Playwright is not installed. Run npm install first.");
  const selection = playwrightSelection(options);
  const args = [playwrightCli, "test", selection.target, `--project=${selection.project}`, "--workers=1"];
  if (selection.grep) args.push("--grep", selection.grep);
  console.log(`Running Playwright project '${selection.project}'...`);
  const output = await runPreparation("playwright", process.execPath, args, {
    cwd: repositoryRoot,
    env: playwrightEnvironment(options, control, approvedConfiguration)
  });
  if (output) console.log(output);
}

async function startControlServer(simulatorEnabled, approvedConfiguration = null) {
  lifecycle.assertOpen();
  const token = randomBytes(24).toString("hex");
  rememberSecret(token);
  let operation = Promise.resolve();
  const state = { closing: false };
  const server = createServer((request, response) => {
    const respond = (status, payload) => {
      response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
      response.end(JSON.stringify(payload));
    };
    if (state.closing || lifecycle.closing) {
      respond(503, { ok: false });
      return;
    }
    if (request.method !== "POST" || request.headers["x-signconnect-e2e-token"] !== token) {
      respond(404, { ok: false });
      return;
    }
    const match = /^\/control\/(inference|realtime)\/(start|stop)$/.exec(request.url ?? "");
    if (!match || !controlledServices.has(match[1])) {
      respond(404, { ok: false });
      return;
    }

    operation = operation.catch(() => undefined).then(async () => {
      lifecycle.assertOpen();
      const [, service, action] = match;
      const definition = backendDefinition(service, simulatorEnabled, approvedConfiguration);
      if (action === "stop") {
        await terminateOwned(service);
        await waitForPortClosed(definition.port);
      } else {
        lifecycle.assertOpen();
        if (ownedProcesses.has(service)) throw new Error(`${service} is already running.`);
        await startBackend(service, simulatorEnabled, approvedConfiguration);
      }
    });
    operation.then(
      () => respond(200, { ok: true }),
      (error) => respond(500, { ok: false, message: redactSecrets(String(error.message)).slice(0, 240) })
    );
  });
  const listenPromise = new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const control = {
    server,
    state,
    token,
    url: null,
    whenIdle: () => operation.catch(() => undefined)
  };
  controlServer = control;
  await listenPromise;
  lifecycle.assertOpen();
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Could not allocate the E2E control server.");
  control.url = `http://127.0.0.1:${address.port}`;
  return control;
}

function beginControlServerClose(control) {
  if (!control) return Promise.resolve();
  control.state.closing = true;
  control.server.closeIdleConnections?.();
  return new Promise((resolve) => {
    try {
      control.server.close(() => resolve());
    } catch {
      resolve();
    }
  });
}

async function finishControlServerClose(control, closePromise) {
  if (!control) return;
  const idle = await Promise.race([
    control.whenIdle().then(() => true),
    delay(shutdownDeadlineMs).then(() => false)
  ]);
  if (!idle) control.server.closeAllConnections?.();
  await Promise.race([closePromise, delay(1_000)]);
}

let controlServer = null;
let cleanupPromise = null;

export async function sweepUntilStable(snapshotNames, terminate, settle = () => delay(0)) {
  let consecutiveEmptySnapshots = 0;
  for (let pass = 0; pass < 6; pass += 1) {
    const snapshot = snapshotNames();
    if (snapshot.length === 0) {
      consecutiveEmptySnapshots += 1;
      if (consecutiveEmptySnapshots >= 2) return [];
    } else {
      consecutiveEmptySnapshots = 0;
      await Promise.all(snapshot.map((name) => terminate(name)));
    }
    await settle();
  }
  return snapshotNames();
}

async function terminateOwnedUntilStable() {
  return sweepUntilStable(
    () => Array.from(ownedProcesses.keys()),
    (name) => terminateOwned(name)
  );
}

async function cleanup() {
  if (cleanupPromise) return cleanupPromise;
  lifecycle.beginClose();
  cleanupPromise = (async () => {
    const controlClose = beginControlServerClose(controlServer);
    await finishControlServerClose(controlServer, controlClose);
    await terminateOwnedUntilStable();
    // Recheck after the first stable sweep. The global gate makes a late start
    // fail, while this catches a start that passed its synchronous guard at the
    // instant closure began or an exact tree that exited near the deadline.
    const cleanupFailures = await terminateOwnedUntilStable();
    if (cleanupFailures.length > 0) {
      process.exitCode = 1;
      console.error(`Exact process trees did not exit before the cleanup deadline: ${cleanupFailures.join(", ")}`);
    }
  })();
  return cleanupPromise;
}

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => {
    lifecycle.beginClose(new Error(`The E2E runner received ${signal}.`));
    void cleanup().finally(() => {
      process.exitCode = signal === "SIGINT" ? 130 : 143;
    });
  });
}

async function runLifecycleSelfTest() {
  const test = async () => {
    const testLifecycle = new RunnerLifecycle();
    let enterOperation;
    let releaseOperation;
    const entered = new Promise((resolve) => { enterOperation = resolve; });
    const release = new Promise((resolve) => { releaseOperation = resolve; });
    let spawnCalls = 0;
    const fakeOwned = new Set(["already-running"]);

    const racingStart = Promise.resolve().then(async () => {
      // This mirrors an accepted control request: the operation has passed its
      // intake guard and is in flight, but has not reached its spawn yet.
      testLifecycle.assertOpen();
      enterOperation();
      await release;
      return guardedSpawn(testLifecycle, () => {
        spawnCalls += 1;
        fakeOwned.add("late-start");
      });
    });

    await entered;
    testLifecycle.beginClose();
    releaseOperation();
    await assert.rejects(racingStart, /closing/);
    const remaining = await sweepUntilStable(
      () => Array.from(fakeOwned),
      async (name) => { fakeOwned.delete(name); }
    );
    assert.equal(spawnCalls, 0, "a start racing cleanup must not reach the spawn implementation");
    assert.deepEqual(remaining, [], "the stable cleanup sweep must report no remaining process");
    assert.deepEqual(Array.from(fakeOwned), [], "cleanup must leave no simulated owned process");

    const secret = "control-token-across-chunks-4f9296";
    rememberSecret(secret);
    const bounded = new BoundedLog();
    bounded.append(`token=${secret.slice(0, 11)}`);
    bounded.append(`${secret.slice(11)}\nfinished`);
    const redacted = bounded.toString();
    assert.equal(redacted.includes(secret), false, "a control token split across log chunks must be redacted");
    assert.match(redacted, /\[REDACTED/);

    assert.deepEqual(
      exactTreeTerminationTarget(4_321, "win32", "C:\\Windows"),
      {
        command: path.join("C:\\Windows", "System32", "taskkill.exe"),
        args: ["/PID", "4321", "/T", "/F"]
      },
      "Windows cleanup must target the exact owned PID tree"
    );
    assert.deepEqual(
      exactTreeTerminationTarget(4_321, "linux"),
      { processGroupId: -4_321 },
      "POSIX cleanup must target the exact detached owned process group"
    );

    const cleanEnvironment = sanitizedEnvironment({}, {
      Path: "safe-path",
      SafeSetting: "retained",
      SpRiNg_ApPlIcAtIoN_JsOn: "hostile",
      SPRING_CONFIG_LOCATION: "hostile",
      logging_level_root: "TRACE",
      SignConnect_Recognition_Simulator_Enabled: "true",
      SERVER_ADDRESS: "0.0.0.0",
      Java_Tool_Options: "-agentlib:jdwp",
      MAVEN_OPTS: "-Xdebug",
      node_options: "--inspect",
      DeBuG: "*",
      TRACE: "true",
      NPM_CONFIG_REGISTRY_AUTHTOKEN: "hostile-token"
    });
    assert.deepEqual(cleanEnvironment, { Path: "safe-path", SafeSetting: "retained" });

    const compilation = new WebpackCompilationInspector();
    compilation.append("webpack 5.110.1 compiled with 2 warnings");
    assert.equal(compilation.state, "success", "webpack warnings are a successful readiness state");
    compilation.append("\nERROR in ./src/index.ts");
    assert.equal(compilation.state, "error", "an error after a prior success invalidates readiness");
    compilation.append("\nwebpack 5.110.1 compiled successfully");
    assert.equal(compilation.state, "success", "a later successful rebuild restores readiness");

    assert.deepEqual(
      playwrightSelection({ performance: false, project: "chromium", simulator: true }),
      {
        project: "chromium",
        target: "tests/e2e",
        grep: "@simulator"
      },
      "the simulator stack must select only the explicit simulator development-gate test"
    );
    assert.deepEqual(
      playwrightSelection({ performance: false, project: "chromium", simulator: false }),
      {
        project: "chromium",
        target: "tests/e2e",
        grep: null
      },
      "the production stack must retain the complete correctness suite, including simulator absence coverage"
    );
    assert.equal(
      playwrightJsonReportPath({ performance: false, project: "chrome", simulator: false }),
      path.join(repositoryRoot, "test-results", "playwright", "chrome.json"),
      "each installed-browser correctness run must retain its own JSON result"
    );
    assert.equal(
      playwrightJsonReportPath({ performance: false, project: "chromium", simulator: true }),
      path.join(repositoryRoot, "test-results", "playwright", "simulator-chromium.json"),
      "the simulator result must not overwrite bundled-Chromium correctness evidence"
    );
    assert.equal(
      playwrightJsonReportPath({ performance: true, project: "chromium", simulator: false }),
      path.join(repositoryRoot, "test-results", "playwright", "performance.json"),
      "the performance result must have a dedicated machine-readable artifact"
    );

    assert.equal(
      parseOptions(["--approved-genuine-model"]).approvedGenuineModel,
      true,
      "the genuine-model browser runner must require an explicit opt-in flag"
    );
    assert.equal(
      parseOptions([]).approvedGenuineModel,
      false,
      "the default browser runner must retain its synthetic integration behavior"
    );
    assert.throws(
      () => parseOptions(["--approved-genuine-model", "--simulator"]),
      /approved-genuine-model.*cannot be combined.*simulator/i,
      "the approved-model runner must not enter the development simulator profile"
    );
    assert.throws(
      () => parseOptions(["--approved-genuine-model", "--performance"]),
      /approved-genuine-model.*cannot be combined.*performance/i,
      "genuine browser evidence and the existing synthetic latency profile must stay distinct"
    );
    assert.throws(
      () => parseOptions(["--approved-genuine-model", "--self-test"]),
      /self-test cannot be combined/i,
      "self-test mode must not silently ignore the approved-model opt-in"
    );
    for (const environmentName of [
      "SIGNCONNECT_E2E_APPROVED_MODEL_PATH",
      "SIGNCONNECT_E2E_APPROVED_METADATA_PATH",
      "SIGNCONNECT_E2E_REVIEWED_FIXTURE_PATH"
    ]) {
      assert.match(usage(), new RegExp(environmentName), "approved-mode inputs must be discoverable in CLI help");
    }

    const privateRoot = mkdtempSync(path.join(os.tmpdir(), "signconnect-approved-runner-"));
    const privateModelPath = path.join(privateRoot, "approved-private.onnx");
    const privateMetadataPath = path.join(privateRoot, "approved-private.json");
    const privateFixturePath = path.join(privateRoot, "reviewed-private.json");
    const privateTensorSentinel = "PRIVATE_TENSOR_SENTINEL_4b112e";
    try {
      writeFileSync(privateModelPath, "private-model-placeholder");
      writeFileSync(privateMetadataPath, JSON.stringify({
        modelVersion: "approved-1.2.3",
        mockModel: false,
        genuineSignLanguageData: true,
        productionPromotion: { status: "APPROVED" }
      }));
      writeFileSync(privateFixturePath, JSON.stringify({ features: [privateTensorSentinel] }));

      let unsupportedMessage = "";
      try {
        approvedGenuineModelConfiguration(
          parseOptions(["--approved-genuine-model"]),
          {
            SIGNCONNECT_E2E_APPROVED_MODEL_PATH: privateModelPath,
            SIGNCONNECT_E2E_APPROVED_METADATA_PATH: privateMetadataPath,
            SIGNCONNECT_E2E_REVIEWED_FIXTURE_PATH: privateFixturePath
          }
        );
      } catch (error) {
        unsupportedMessage = String(error instanceof Error ? error.message : error);
      }
      assert.match(
        unsupportedMessage,
        /unavailable.*dedicated reviewed-fixture consumer.*no evidence report/i,
        "private paths alone must not enable genuine-browser evidence"
      );
      assert.equal(unsupportedMessage.includes(privateRoot), false, "private paths must not enter runner errors");
      assert.equal(
        unsupportedMessage.includes(privateTensorSentinel),
        false,
        "private fixture content must not enter runner errors"
      );
      const blockedReportPath = playwrightJsonReportPath(
        parseOptions(["--approved-genuine-model", "--project=chrome"]),
        privateRoot
      );
      assert.equal(existsSync(blockedReportPath), false, "blocked approved mode must not create an evidence report");

      const defaultInference = backendDefinition("inference", false, null);
      assert.equal(
        defaultInference.args.includes("--spring.profiles.active=local"),
        true,
        "the default E2E stack must retain its synthetic local profile"
      );
      assert.equal(defaultInference.env.SIGN_MODEL_RESOURCE, undefined);

      if (process.platform === "win32") {
        const defaultMeeting = backendDefinition("meeting", false, null);
        assert.equal(
          defaultMeeting.args.includes("-Djdk.net.unixdomain.tmpdir=C:\\jtmp"),
          true,
          "Windows executable jars must use the short loopback-socket directory"
        );
        assert.equal(
          defaultMeeting.args.some((argument) => argument.startsWith("-Djava.io.tmpdir=")),
          false,
          "Tomcat temporary files must retain the process default writable directory"
        );
      }

      const defaultFrontend = frontendDefinition("meeting-frontend", false, null);
      assert.equal(defaultFrontend.env.RECOGNITION_E2E_FIXTURE_ENABLED, "true");

      const defaultPlaywrightEnvironment = playwrightEnvironment(
        parseOptions([]),
        { token: "self-test-control-token", url: "http://127.0.0.1:40000" },
        null
      );
      assert.equal(defaultPlaywrightEnvironment.SIGNCONNECT_E2E_REVIEWED_FIXTURE_PATH, undefined);
      assert.equal(defaultPlaywrightEnvironment.SIGNCONNECT_E2E_APPROVED_GENUINE_MODEL, "false");
    } finally {
      rmSync(privateRoot, { force: true, recursive: true });
    }
  };

  let timeout;
  try {
    await Promise.race([
      test(),
      new Promise((_, reject) => {
        timeout = setTimeout(() => reject(new Error("Lifecycle self-test exceeded its 1 second bound.")), 1_000);
      })
    ]);
  } finally {
    clearTimeout(timeout);
  }
  console.log("Recognition E2E runner lifecycle self-test passed.");
}

function frontendFailureDiagnostics() {
  const sections = [];
  for (const name of ["meeting-frontend", "shell-frontend"]) {
    const record = ownedProcesses.get(name);
    if (!record) continue;
    const output = record.log.toString();
    sections.push(`${name} bounded log:\n${output.slice(-8_000) || "No process output."}`);
  }
  return sections.length > 0 ? `\n\nFrontend diagnostics:\n${sections.join("\n\n")}` : "";
}

async function main() {
  const options = parseOptions(process.argv.slice(2));
  if (options.selfTest) {
    await runLifecycleSelfTest();
    return;
  }
  const approvedConfiguration = approvedGenuineModelConfiguration(options);
  await requireFreePorts([3000, 3001, 8081, 8082, 8083]);
  if (!options.skipBuild) await buildBackend();

  await Promise.all([
    startBackend("meeting", options.simulator, approvedConfiguration),
    startBackend("inference", options.simulator, approvedConfiguration)
  ]);
  await startBackend("realtime", options.simulator, approvedConfiguration);
  await startFrontend("meeting-frontend", options.simulator, approvedConfiguration);
  await startFrontend("shell-frontend", options.simulator, approvedConfiguration);
  controlServer = await startControlServer(options.simulator, approvedConfiguration);
  await runPlaywright(options, controlServer, approvedConfiguration);
}

try {
  await main();
} catch (error) {
  process.exitCode = 1;
  const message = error instanceof Error ? error.message : String(error);
  console.error(redactOutput(`${message}${frontendFailureDiagnostics()}`));
} finally {
  await cleanup();
}
