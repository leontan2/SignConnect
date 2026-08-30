import { spawn } from "node:child_process";
import { lstat, mkdir, mkdtemp, readdir, realpath, unlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const releaseReportRoot = path.join(repositoryRoot, "test-results", "playwright");
const ownedTemporaryReleaseReportRoots = new Map();
const releaseReportRootKey = comparablePath(releaseReportRoot);
const npmCommand = process.platform === "win32"
  ? process.env.ComSpec ?? "cmd.exe"
  : "npm";
const powershellCommand = process.platform === "win32" ? "powershell.exe" : "pwsh";

function npmArgs(...args) {
  return process.platform === "win32"
    ? ["/d", "/s", "/c", "npm.cmd", ...args]
    : args;
}

export const releaseGateSteps = Object.freeze([
  Object.freeze({
    name: "repository verifier",
    command: powershellCommand,
    args: [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      ...(process.platform === "win32" ? ["-ExecutionPolicy", "Bypass"] : []),
      "-File",
      path.join(repositoryRoot, "scripts", "verify.ps1")
    ]
  }),
  Object.freeze({
    name: "E2E runner self-test",
    command: npmCommand,
    args: npmArgs("run", "test:e2e:runner:self-test")
  }),
  Object.freeze({
    name: "bundled Chromium E2E",
    command: npmCommand,
    args: npmArgs("run", "test:e2e")
  }),
  Object.freeze({
    name: "installed Chrome and Edge E2E",
    command: npmCommand,
    args: npmArgs("run", "test:e2e:installed")
  }),
  Object.freeze({
    name: "development simulator E2E",
    command: npmCommand,
    args: npmArgs("run", "test:e2e:simulator")
  }),
  Object.freeze({
    name: "synthetic performance E2E",
    command: npmCommand,
    args: npmArgs("run", "test:e2e:performance")
  })
]);

function executeReleaseStep(step) {
  return new Promise((resolve, reject) => {
    const child = spawn(step.command, step.args, {
      cwd: repositoryRoot,
      env: process.env,
      shell: false,
      stdio: "inherit",
      windowsHide: true
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (signal) {
        reject(new Error(`${step.name} terminated by signal ${signal}.`));
        return;
      }
      resolve(code ?? 1);
    });
  });
}

export async function runReleaseGate(execute = executeReleaseStep) {
  for (const step of releaseGateSteps) {
    console.log(`\n=== Release gate: ${step.name} ===`);
    const exitCode = await execute(step);
    if (exitCode !== 0) {
      throw new Error(`${step.name} failed with exit code ${exitCode}.`);
    }
  }
  console.log("\nAll release verification gates passed.");
}

function comparablePath(candidate) {
  const resolved = path.resolve(candidate);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

export async function prepareReleaseReports(reportRoot) {
  if (!path.isAbsolute(reportRoot)) {
    throw new Error("Release report cleanup requires an explicit absolute directory.");
  }
  const resolvedReportRoot = path.resolve(reportRoot);
  const reportRootKey = comparablePath(resolvedReportRoot);
  const ownedTemporaryRealPath = ownedTemporaryReleaseReportRoots.get(reportRootKey);
  const isProductionReportRoot = reportRootKey === releaseReportRootKey;
  if (comparablePath(path.parse(resolvedReportRoot).root) === reportRootKey) {
    throw new Error("A filesystem root can never be used as a release report directory.");
  }
  if (!isProductionReportRoot && !ownedTemporaryRealPath) {
    throw new Error(`${resolvedReportRoot} is not an authorized SignConnect release report directory.`);
  }

  await mkdir(resolvedReportRoot, { recursive: true });
  const rootMetadata = await lstat(resolvedReportRoot);
  if (!rootMetadata.isDirectory() || rootMetadata.isSymbolicLink()) {
    throw new Error("The authorized release report path must be a real directory, not a link.");
  }
  const physicalReportRoot = comparablePath(await realpath(resolvedReportRoot));
  if (ownedTemporaryRealPath && physicalReportRoot !== ownedTemporaryRealPath) {
    throw new Error("The owned temporary release report directory changed after it was created.");
  }
  if (isProductionReportRoot) {
    const physicalRepositoryRoot = await realpath(repositoryRoot);
    const expectedPhysicalRoot = comparablePath(path.join(physicalRepositoryRoot, "test-results", "playwright"));
    if (physicalReportRoot !== expectedPhysicalRoot) {
      throw new Error("The production release report directory resolves outside the SignConnect repository.");
    }
  }

  const entries = await readdir(resolvedReportRoot, { withFileTypes: true });
  const unexpectedEntry = entries.find((entry) => !entry.isFile() || path.extname(entry.name).toLowerCase() !== ".json");
  if (unexpectedEntry) {
    throw new Error(`Refusing to clear unexpected release report entry '${unexpectedEntry.name}'.`);
  }
  for (const entry of entries) {
    await unlink(path.join(resolvedReportRoot, entry.name));
  }
}

export async function createOwnedTemporaryReleaseReportRoot() {
  const reportRoot = await mkdtemp(path.join(os.tmpdir(), "signconnect-release-reports-"));
  ownedTemporaryReleaseReportRoots.set(comparablePath(reportRoot), comparablePath(await realpath(reportRoot)));
  return reportRoot;
}

const invokedDirectly = process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (invokedDirectly) {
  prepareReleaseReports(releaseReportRoot).then(() => runReleaseGate()).catch((error) => {
    process.exitCode = 1;
    console.error(error instanceof Error ? error.message : String(error));
  });
}
