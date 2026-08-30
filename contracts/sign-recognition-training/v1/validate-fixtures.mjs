import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import Ajv2020 from "ajv/dist/2020.js";

const contractRoot = dirname(fileURLToPath(import.meta.url));
const fixturesRoot = join(contractRoot, "fixtures");

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

function validateDatasetSemantics(manifest) {
  const errors = [];
  const sampleIds = new Set();
  const artifactPaths = new Set();
  const artifactDigests = new Set();
  const attestationIds = new Set();
  const signerSplits = new Map();
  const observedSplits = new Set();
  const testSigners = new Set();

  for (const sample of manifest.samples ?? []) {
    if (sampleIds.has(sample.sampleId)) errors.push(`duplicate sampleId ${sample.sampleId}`);
    sampleIds.add(sample.sampleId);

    const artifactPath = sample.landmarkArtifact?.path;
    const artifactDigest = sample.landmarkArtifact?.sha256;
    if (artifactPaths.has(artifactPath)) errors.push(`duplicate landmark path ${artifactPath}`);
    if (artifactDigests.has(artifactDigest)) errors.push(`duplicate landmark digest ${artifactDigest}`);
    artifactPaths.add(artifactPath);
    artifactDigests.add(artifactDigest);

    const attestationId = sample.consentAttestation?.attestationId;
    if (attestationIds.has(attestationId)) errors.push(`duplicate consent attestation ${attestationId}`);
    attestationIds.add(attestationId);

    if (sample.language !== manifest.targetLanguage) {
      errors.push(`sample ${sample.sampleId} language differs from manifest target`);
    }
    if (sample.featureLayoutVersion !== manifest.featureLayoutVersion) {
      errors.push(`sample ${sample.sampleId} feature layout differs from manifest`);
    }

    const previousSplit = signerSplits.get(sample.signerId);
    if (previousSplit && previousSplit !== sample.splitAssignment) {
      errors.push(`signer ${sample.signerId} appears in ${previousSplit} and ${sample.splitAssignment}`);
    }
    signerSplits.set(sample.signerId, sample.splitAssignment);
    observedSplits.add(sample.splitAssignment);
    if (sample.splitAssignment === "TEST") testSigners.add(sample.signerId);
  }

  for (const requiredSplit of ["TRAIN", "VALIDATION", "TEST"]) {
    if (!observedSplits.has(requiredSplit)) errors.push(`missing ${requiredSplit} split`);
  }
  if (testSigners.size !== manifest.splitPolicy?.testSignerCount) {
    errors.push("testSignerCount does not match unique TEST signers");
  }
  return errors;
}

function validateModelSemantics(metadata) {
  const errors = [];
  const labels = metadata.labels ?? [];
  const labelIds = labels.map((label) => label.id);
  if (new Set(labelIds).size !== labelIds.length) errors.push("label ids must be unique");

  labels.forEach((label, position) => {
    if (label.index !== position) errors.push(`label ${label.id} index does not equal position ${position}`);
  });
  if (metadata.output?.shape?.[1] !== labels.length) {
    errors.push("output label dimension does not equal labels.length");
  }

  const noSignLabels = labels.filter((label) => label.outcome === "NO_SIGN");
  const signLabels = labels.filter((label) => label.outcome === "SIGN");
  if (noSignLabels.length !== 1) errors.push("exactly one NO_SIGN outcome is required");
  if (signLabels.length === 0) errors.push("at least one SIGN outcome is required");

  const reviewableLabels = new Set(signLabels.map((label) => label.id));
  for (const labelId of metadata.sgslReview?.reviewedLabelIds ?? []) {
    if (!reviewableLabels.has(labelId)) errors.push(`review names non-SIGN label ${labelId}`);
  }

  if (metadata.onnx?.parity?.maxAbsoluteDifference > metadata.onnx?.parity?.absoluteTolerance) {
    errors.push("ONNX maxAbsoluteDifference exceeds absoluteTolerance");
  }

  if (metadata.productionPromotion?.status === "APPROVED") {
    const reviewed = new Set(metadata.sgslReview?.reviewedLabelIds ?? []);
    for (const label of signLabels) {
      if (!reviewed.has(label.id)) errors.push(`production label ${label.id} lacks SGSL review`);
    }
    if (metadata.architecture?.family === "SYNTHETIC_FIXTURE") {
      errors.push("synthetic fixture architecture cannot be promoted");
    }
    if (!(metadata.runtime?.warmedP95LatencyMs > 0)) {
      errors.push("production promotion requires measured warmed Java latency");
    }
  }
  return errors;
}

const ajv = new Ajv2020({ allErrors: true, strict: true, validateFormats: false });
const datasetSchema = await readJson(join(contractRoot, "dataset-manifest.schema.json"));
const modelSchema = await readJson(join(contractRoot, "model-metadata.schema.json"));
const validateDataset = ajv.compile(datasetSchema);
const validateModel = ajv.compile(modelSchema);

const provenanceProbe = await readJson(join(fixturesRoot, "dataset-manifest.valid.json"));
provenanceProbe.provenance.kind = "NON_PRODUCTION_SYNTHETIC";
assert.equal(validateDataset(provenanceProbe), false, "provenance kind and evidence must be bound together");

const latencyProbe = await readJson(join(fixturesRoot, "model-metadata-production.valid.json"));
latencyProbe.runtime.warmedP95LatencyMs = 0;
assert.equal(validateModel(latencyProbe), false, "APPROVED promotion requires measured warmed Java latency");

const fixtureNames = (await readdir(fixturesRoot))
  .filter((name) => name.endsWith(".json"))
  .sort();

assert(fixtureNames.some((name) => name.startsWith("dataset-manifest") && name.endsWith(".valid.json")));
assert(fixtureNames.some((name) => name.startsWith("dataset-manifest") && name.endsWith(".invalid.json")));
assert(fixtureNames.some((name) => name.startsWith("model-metadata") && name.endsWith(".valid.json")));
assert(fixtureNames.some((name) => name.startsWith("model-metadata") && name.endsWith(".invalid.json")));

for (const name of fixtureNames) {
  const value = await readJson(join(fixturesRoot, name));
  const isDataset = name.startsWith("dataset-manifest");
  const schemaValidator = isDataset ? validateDataset : validateModel;
  const schemaValid = schemaValidator(value);
  const semanticErrors = schemaValid
    ? (isDataset ? validateDatasetSemantics(value) : validateModelSemantics(value))
    : [];
  const valid = schemaValid && semanticErrors.length === 0;
  const expectedValid = name.endsWith(".valid.json");

  assert.equal(
    valid,
    expectedValid,
    `${name}: expected ${expectedValid ? "valid" : "invalid"}; schema errors=${JSON.stringify(schemaValidator.errors)}; semantic errors=${JSON.stringify(semanticErrors)}`
  );
}

console.log(`Validated ${fixtureNames.length} training contract fixtures.`);
