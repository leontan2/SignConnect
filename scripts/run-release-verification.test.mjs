import assert from "node:assert/strict";
import { access, mkdtemp, rmdir, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  createOwnedTemporaryReleaseReportRoot,
  prepareReleaseReports,
  releaseGateSteps,
  runReleaseGate
} from "./run-release-verification.mjs";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const expectedStepNames = [
  "repository verifier",
  "E2E runner self-test",
  "bundled Chromium E2E",
  "installed Chrome and Edge E2E",
  "development simulator E2E",
  "synthetic performance E2E"
];

test("release gate runs every required verifier in deterministic order", async () => {
  assert.deepEqual(releaseGateSteps.map(({ name }) => name), expectedStepNames);
  assert.equal(releaseGateSteps[0].args.at(-1), path.join(repositoryRoot, "scripts", "verify.ps1"));
  assert.deepEqual(
    releaseGateSteps.slice(1).map(({ args }) => args.slice(-2)),
    [
      ["run", "test:e2e:runner:self-test"],
      ["run", "test:e2e"],
      ["run", "test:e2e:installed"],
      ["run", "test:e2e:simulator"],
      ["run", "test:e2e:performance"]
    ]
  );
  if (process.platform === "win32") {
    assert.equal(releaseGateSteps[1].command, process.env.ComSpec ?? "cmd.exe");
    assert.deepEqual(releaseGateSteps[1].args.slice(0, 4), ["/d", "/s", "/c", "npm.cmd"]);
  }

  const calls = [];
  await runReleaseGate(async (step) => {
    calls.push(step.name);
    return 0;
  });

  assert.deepEqual(calls, expectedStepNames);
});

test("release gate stops at the first failing verifier", async () => {
  const calls = [];

  await assert.rejects(
    runReleaseGate(async (step) => {
      calls.push(step.name);
      return step.name === "bundled Chromium E2E" ? 23 : 0;
    }),
    /bundled Chromium E2E.*exit code 23/
  );

  assert.deepEqual(calls, expectedStepNames.slice(0, 3));
});

test("release report preparation removes stale evidence and recreates the report directory", async () => {
  const reportRoot = await createOwnedTemporaryReleaseReportRoot();
  const staleReport = path.join(reportRoot, "stale.json");
  try {
    await writeFile(staleReport, "{}", "utf8");

    await prepareReleaseReports(reportRoot);

    await assert.rejects(access(staleReport));
    await access(reportRoot);
  } finally {
    await rmdir(reportRoot);
  }
});

test("release report preparation rejects an unrelated absolute directory", async () => {
  const unrelatedRoot = await mkdtemp(path.join(os.tmpdir(), "signconnect-unowned-reports-"));
  const unrelatedEvidence = path.join(unrelatedRoot, "keep.json");
  try {
    await writeFile(unrelatedEvidence, "{}", "utf8");

    await assert.rejects(
      prepareReleaseReports(unrelatedRoot),
      /not an authorized SignConnect release report directory/
    );

    await access(unrelatedEvidence);
  } finally {
    await unlink(unrelatedEvidence).catch((error) => {
      if (error?.code !== "ENOENT") throw error;
    });
    await rmdir(unrelatedRoot);
  }
});

test("release report preparation rejects a filesystem root before cleanup", async () => {
  await assert.rejects(
    prepareReleaseReports(path.parse(repositoryRoot).root),
    /filesystem root can never be used/
  );
});

test("release report preparation refuses unexpected entries without partially deleting evidence", async () => {
  const reportRoot = await createOwnedTemporaryReleaseReportRoot();
  const jsonEvidence = path.join(reportRoot, "keep.json");
  const unexpectedFile = path.join(reportRoot, "notes.txt");
  try {
    await writeFile(jsonEvidence, "{}", "utf8");
    await writeFile(unexpectedFile, "do not delete", "utf8");

    await assert.rejects(
      prepareReleaseReports(reportRoot),
      /Refusing to clear unexpected release report entry 'notes\.txt'/
    );

    await access(jsonEvidence);
    await access(unexpectedFile);
  } finally {
    await unlink(jsonEvidence);
    await unlink(unexpectedFile);
    await rmdir(reportRoot);
  }
});
