import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import Ajv2020 from "ajv/dist/2020.js";

const ROBUSTNESS_SLICE_ORDER = {
  lighting: ["LOW", "INDOOR", "DAYLIGHT", "MIXED"],
  cameraDistance: ["NEAR", "NOMINAL", "FAR"],
  signingSpeed: ["SLOW", "NATURAL", "FAST"],
  handedness: ["LEFT", "RIGHT", "TWO_HANDED", "NOT_APPLICABLE", "UNKNOWN"],
  occlusion: ["NONE", "PARTIAL"],
  behaviorScenario: [
    "ISOLATED_SIGN", "INCOMPLETE_GESTURE", "HELD_SIGN", "REPEATED_SIGN",
    "IDLE", "TRANSITION", "UNKNOWN_GESTURE", "NATURAL_MOVEMENT",
  ],
};
const EMPTY_SHA256 = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

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
  const observedSignLabels = new Set();
  const reviewedLabelIds = (manifest.reviewedLabels ?? []).map((label) => label.labelId);
  const reviewedLabels = new Set(reviewedLabelIds);
  if (reviewedLabels.size !== reviewedLabelIds.length) {
    errors.push("reviewed vocabulary label ids must be unique");
  }
  for (const reserved of ["NO_SIGN", "OUT_OF_VOCABULARY"]) {
    if (reviewedLabels.has(reserved)) errors.push(`${reserved} must not be an SGSL review entry`);
  }

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
    if (!["NO_SIGN", "OUT_OF_VOCABULARY"].includes(sample.labelId)
        && !reviewedLabels.has(sample.labelId)) {
      errors.push(`sample ${sample.sampleId} label is absent from the reviewed vocabulary`);
    }
    if (!["NO_SIGN", "OUT_OF_VOCABULARY"].includes(sample.labelId)) {
      observedSignLabels.add(sample.labelId);
    }
    if (sample.consentAttestation?.withdrawalStatus !== "ACTIVE") {
      errors.push(`sample ${sample.sampleId} does not have active consent`);
    }
    const consentedAt = timestampMicroseconds(sample.consentAttestation?.consentedAt);
    const capturedAt = timestampMicroseconds(sample.captureTimestamp);
    if (consentedAt === null || capturedAt === null || consentedAt > capturedAt) {
      errors.push(`sample ${sample.sampleId} consent must precede or equal capture`);
    }
    const retentionExpiresAt = timestampMicroseconds(manifest.retentionExpiresAt);
    const ninetyDays = 90n * 24n * 60n * 60n * 1000000n;
    if (retentionExpiresAt === null
        || capturedAt === null
        || retentionExpiresAt <= capturedAt
        || retentionExpiresAt > capturedAt + ninetyDays) {
      errors.push(`sample ${sample.sampleId} retention expiry is outside the permitted window`);
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
  if (observedSignLabels.size !== reviewedLabels.size
      || [...observedSignLabels].some((label) => !reviewedLabels.has(label))) {
    errors.push("reviewed vocabulary does not exactly match observed SIGN evidence");
  }
  if (testSigners.size !== manifest.splitPolicy?.testSignerCount) {
    errors.push("testSignerCount does not match unique TEST signers");
  }
  const assignments = (manifest.samples ?? [])
    .map(({ sampleId, signerId, splitAssignment }) => ({
      sampleId,
      signerId,
      splitAssignment,
    }))
    .sort((left, right) => left.sampleId < right.sampleId ? -1 : left.sampleId > right.sampleId ? 1 : 0);
  const assignmentSha256 = createHash("sha256")
    .update(JSON.stringify(assignments))
    .digest("hex");
  if (assignmentSha256 !== manifest.splitPolicy?.assignmentSha256) {
    errors.push("split assignment digest does not match canonical assignments");
  }
  return errors;
}

function timestampMicroseconds(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,6}))?Z$/.exec(value ?? "");
  if (!match) return null;
  const [, year, month, day, hour, minute, second, fraction = ""] = match;
  const date = new Date(0);
  date.setUTCFullYear(Number(year), Number(month) - 1, Number(day));
  date.setUTCHours(Number(hour), Number(minute), Number(second), 0);
  if (date.getUTCFullYear() !== Number(year)
      || date.getUTCMonth() !== Number(month) - 1
      || date.getUTCDate() !== Number(day)
      || date.getUTCHours() !== Number(hour)
      || date.getUTCMinutes() !== Number(minute)
      || date.getUTCSeconds() !== Number(second)) return null;
  return BigInt(date.getTime()) * 1000n + BigInt(fraction.padEnd(6, "0") || "0");
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
  const canonicalVocabulary = canonicalJson({
    targetLanguage: metadata.targetLanguage,
    vocabularyVersion: metadata.vocabularyVersion,
    labels,
  });
  const vocabularySha256 = createHash("sha256")
    .update(canonicalVocabulary, "utf8")
    .digest("hex");
  if (metadata.vocabularySha256 !== vocabularySha256) {
    errors.push("vocabularySha256 does not bind the complete ordered runtime vocabulary");
  }
  const source = metadata.sourceProvenance;
  let validSource;
  let cleanSource = false;
  if (source.commit === null) {
    validSource = [
      source.dirty,
      source.trackedChangesSha256,
      source.untrackedFileCount,
      source.untrackedStateSha256,
      source.untrackedContentSha256,
    ].every((value) => value === null);
  } else {
    const hasTracked = source.trackedChangesSha256 !== EMPTY_SHA256;
    const hasUntracked = source.untrackedFileCount > 0;
    validSource = source.dirty === (hasTracked || hasUntracked)
      && (hasUntracked || (
        source.untrackedStateSha256 === EMPTY_SHA256
        && source.untrackedContentSha256 === EMPTY_SHA256
      ));
    cleanSource = validSource
      && source.dirty === false
      && source.trackedChangesSha256 === EMPTY_SHA256
      && source.untrackedFileCount === 0
      && source.untrackedStateSha256 === EMPTY_SHA256
      && source.untrackedContentSha256 === EMPTY_SHA256;
  }
  if (!validSource) errors.push("sourceProvenance is internally inconsistent");
  if (metadata.productionPromotion?.status === "APPROVED" && !cleanSource) {
    errors.push("production promotion requires complete clean source provenance");
  }

  const metrics = metadata.evaluation?.metrics;
  if (metrics?.perClass) {
    if (metrics.perClass.length !== labels.length) {
      errors.push("perClass length does not equal labels.length");
    }
    metrics.perClass.forEach((item, position) => {
      if (item.index !== position || item.labelId !== labelIds[position]) {
        errors.push(`perClass entry ${position} does not match the indexed label map`);
      }
    });
  }
  if (metrics?.confusionMatrix) {
    const matrix = metrics.confusionMatrix;
    if (JSON.stringify(matrix.labelOrder) !== JSON.stringify(labelIds)) {
      errors.push("confusion matrix label order does not match labels");
    }
    if (matrix.rows.length !== labels.length
        || matrix.rows.some((row) => row.length !== labels.length)) {
      errors.push("confusion matrix must be labels.length by labels.length");
    } else {
      validateMatrixDerivedMetrics(metrics, labels, matrix.rows, errors);
    }
  }
  if (metrics?.noSignBehavior) {
    const behavior = metrics.noSignBehavior;
    const expectedRate = behavior.sampleCount === 0
      ? 0
      : behavior.falseFinalCount / behavior.sampleCount;
    if (behavior.falseFinalCount > behavior.sampleCount) {
      errors.push("NO_SIGN false-final count exceeds its sample count");
    }
    if (!sameRate(behavior.falseFinalRate, expectedRate)) {
      errors.push("NO_SIGN false-final rate does not match its counts");
    }
    if (!sameRate(metrics.falseFinalRate, behavior.falseFinalRate)) {
      errors.push("summary falseFinalRate does not match noSignBehavior");
    }
  }
  if (metrics?.rejectionBehavior) {
    const behavior = metrics.rejectionBehavior;
    const outcomeTotal = behavior.acceptedSignCount
      + behavior.lowConfidenceRejectionCount
      + behavior.noSignDecisionCount;
    if (outcomeTotal !== metrics.sampleCount) {
      errors.push("rejection outcome counts do not equal sampleCount");
    }
    if (!sameRate(behavior.minimumConfidence, metadata.decision?.minimumConfidence)) {
      errors.push("rejection minimum confidence does not match runtime decision threshold");
    }
    const expectedRejectionRate = metrics.sampleCount === 0
      ? 0
      : behavior.lowConfidenceRejectionCount / metrics.sampleCount;
    if (!sameRate(behavior.rejectionRate, expectedRejectionRate)) {
      errors.push("rejection rate does not match its count");
    }
    if (behavior.unknownRejectedCount + behavior.unknownFalseFinalCount
        !== behavior.unknownSampleCount) {
      errors.push("unknown outcomes do not equal unknownSampleCount");
    }
    if (behavior.unknownSampleCount > metrics.sampleCount) {
      errors.push("unknownSampleCount exceeds evaluation sampleCount");
    }
    const expectedUnknownRejection = behavior.unknownSampleCount === 0
      ? null
      : behavior.unknownRejectedCount / behavior.unknownSampleCount;
    const expectedUnknownFalseFinal = behavior.unknownSampleCount === 0
      ? null
      : behavior.unknownFalseFinalCount / behavior.unknownSampleCount;
    if (!sameNullableRate(behavior.unknownRejectionRate, expectedUnknownRejection)) {
      errors.push("unknown rejection rate does not match its count");
    }
    if (!sameNullableRate(behavior.unknownFalseFinalRate, expectedUnknownFalseFinal)) {
      errors.push("unknown false-final rate does not match its count");
    }
    if ((behavior.acceptedSignCount === 0) !== (behavior.acceptedSignAccuracy === null)) {
      errors.push("acceptedSignAccuracy must be null exactly when no signs were accepted");
    }
  }
  if (metrics?.robustnessSlices) {
    for (const [dimension, canonicalOrder] of Object.entries(ROBUSTNESS_SLICE_ORDER)) {
      const items = metrics.robustnessSlices[dimension];
      const values = items.map((item) => item.value);
      const expectedOrder = [...values].sort(
        (left, right) => canonicalOrder.indexOf(left) - canonicalOrder.indexOf(right)
      );
      if (new Set(values).size !== values.length
          || JSON.stringify(values) !== JSON.stringify(expectedOrder)) {
        errors.push(`${dimension} robustness values are not unique and canonically ordered`);
      }
      if (items.reduce((sum, item) => sum + item.support, 0) !== metrics.sampleCount) {
        errors.push(`${dimension} robustness support does not cover the evaluation set`);
      }
    }
    if (metadata.genuineSignLanguageData
        && metrics.robustnessSlices.handedness.some((item) => item.value === "UNKNOWN")) {
      errors.push("genuine evaluation cannot use UNKNOWN handedness robustness evidence");
    }
  }

  const noSignLabels = labels.filter((label) => label.outcome === "NO_SIGN");
  const signLabels = labels.filter((label) => label.outcome === "SIGN");
  if (noSignLabels.length !== 1) errors.push("exactly one NO_SIGN outcome is required");
  if (signLabels.length === 0) errors.push("at least one SIGN outcome is required");

  const orderedReviewableLabels = signLabels.map((label) => label.id);
  const reviewableLabels = new Set(orderedReviewableLabels);
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
  if (metadata.sgslReview?.status === "APPROVED"
      && JSON.stringify(metadata.sgslReview.reviewedLabelIds) !== JSON.stringify(orderedReviewableLabels)) {
    errors.push("approved SGSL review does not match the ordered SIGN vocabulary");
  }
  return errors;
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => (
      `${JSON.stringify(key)}:${canonicalJson(value[key])}`
    )).join(",")}}`;
  }
  return JSON.stringify(value);
}

function validateMatrixDerivedMetrics(metrics, labels, rows, errors) {
  // The confusion matrix records argmax classes. Thresholded rejection counts
  // are checked independently below because confidence values are not encoded
  // in this matrix and cannot be reconstructed from its columns.
  const total = rows.flat().reduce((sum, value) => sum + value, 0);
  if (total !== metrics.sampleCount) {
    errors.push("confusion matrix total does not equal sampleCount");
  }

  const diagonal = rows.reduce((sum, row, index) => sum + row[index], 0);
  const expectedAccuracy = total === 0 ? 0 : diagonal / total;
  if (!sameRate(metrics.accuracy, expectedAccuracy)) {
    errors.push("accuracy is not derived from the confusion matrix");
  }

  const derivedF1 = [];
  let rejectSupport = 0;
  rows.forEach((row, index) => {
    const truePositive = row[index];
    const support = row.reduce((sum, value) => sum + value, 0);
    const predicted = rows.reduce((sum, candidate) => sum + candidate[index], 0);
    const precision = predicted === 0 ? 0 : truePositive / predicted;
    const recall = support === 0 ? 0 : truePositive / support;
    const f1Denominator = 2 * truePositive
      + (predicted - truePositive)
      + (support - truePositive);
    const f1 = f1Denominator === 0 ? 0 : 2 * truePositive / f1Denominator;
    derivedF1.push(f1);
    if (labels[index].outcome === "REJECT") rejectSupport += support;

    const reported = metrics.perClass?.[index];
    if (reported) {
      if (reported.support !== support) {
        errors.push(`perClass support ${index} is not derived from the confusion matrix`);
      }
      for (const [name, expected] of [["precision", precision], ["recall", recall], ["f1", f1]]) {
        if (!sameRate(reported[name], expected)) {
          errors.push(`perClass ${name} ${index} is not derived from the confusion matrix`);
        }
      }
    }

    if (labels[index].outcome === "NO_SIGN"
        && metrics.noSignBehavior
        && metrics.noSignBehavior.sampleCount !== support) {
      errors.push("NO_SIGN sample count does not equal its confusion-matrix row support");
    }
  });

  const expectedMacroF1 = derivedF1.length === 0
    ? 0
    : derivedF1.reduce((sum, value) => sum + value, 0) / derivedF1.length;
  if (!sameRate(metrics.macroF1, expectedMacroF1)) {
    errors.push("macroF1 is not derived from the confusion matrix");
  }
  if (metrics.rejectionBehavior
      && metrics.rejectionBehavior.unknownSampleCount !== rejectSupport) {
    errors.push("unknownSampleCount does not equal REJECT label matrix support");
  }
}

function sameRate(actual, expected) {
  return typeof actual === "number" && typeof expected === "number"
    && Math.abs(actual - expected) <= 1e-12;
}

function sameNullableRate(actual, expected) {
  return actual === null && expected === null
    || sameRate(actual, expected);
}

const ajv = new Ajv2020({ allErrors: true, strict: true, validateFormats: false });
const datasetSchema = await readJson(join(contractRoot, "dataset-manifest.schema.json"));
const modelSchema = await readJson(join(contractRoot, "model-metadata.schema.json"));
const validateDataset = ajv.compile(datasetSchema);
const validateModel = ajv.compile(modelSchema);

const provenanceProbe = await readJson(join(fixturesRoot, "dataset-manifest.valid.json"));
provenanceProbe.provenance.kind = "NON_PRODUCTION_SYNTHETIC";
assert.equal(validateDataset(provenanceProbe), false, "provenance kind and evidence must be bound together");

const datasetGovernanceSource = await readJson(
  join(fixturesRoot, "dataset-manifest.valid.json")
);
const splitDigestProbe = structuredClone(datasetGovernanceSource);
splitDigestProbe.splitPolicy.assignmentSha256 = "0".repeat(64);
assert.equal(validateDataset(splitDigestProbe), true, "split digest probe must remain schema-valid");
assert(
  validateDatasetSemantics(splitDigestProbe).length > 0,
  "split assignment digest must be recomputed from canonical assignments"
);

const consentChronologyProbe = structuredClone(datasetGovernanceSource);
consentChronologyProbe.samples[0].consentAttestation.consentedAt = "2026-08-28T10:00:01Z";
assert.equal(validateDataset(consentChronologyProbe), true, "consent chronology probe must remain schema-valid");
assert(
  validateDatasetSemantics(consentChronologyProbe).length > 0,
  "consent must precede or equal capture"
);

for (const retentionExpiresAt of [
  "2026-11-26T10:00:01Z",
  "2026-08-28T09:59:59Z",
]) {
  const retentionProbe = structuredClone(datasetGovernanceSource);
  retentionProbe.retentionExpiresAt = retentionExpiresAt;
  assert.equal(validateDataset(retentionProbe), true, "retention probe must remain schema-valid");
  assert(
    validateDatasetSemantics(retentionProbe).length > 0,
    "retention must be after capture and no more than 90 days"
  );
}

const reviewedLabelProbe = structuredClone(datasetGovernanceSource);
reviewedLabelProbe.samples[0].labelId = "UNREVIEWED_SIGN";
assert.equal(validateDataset(reviewedLabelProbe), true, "reviewed-label probe must remain schema-valid");
assert(
  validateDatasetSemantics(reviewedLabelProbe).length > 0,
  "every SIGN sample must bind to the reviewed vocabulary"
);

for (const [name, mutate] of [
  ["duplicate", (labels) => labels.push(structuredClone(labels[0]))],
  ["reserved", (labels) => labels.push({
    labelId: "NO_SIGN",
    gloss: "NO-SIGN",
    captionText: "No sign",
  })],
  ["unobserved", (labels) => labels.push({
    labelId: "UNOBSERVED_SIGN",
    gloss: "UNOBSERVED-SIGN",
    captionText: "Reviewer-approved caption",
  })],
]) {
  const vocabularyProbe = structuredClone(datasetGovernanceSource);
  mutate(vocabularyProbe.reviewedLabels);
  assert.equal(validateDataset(vocabularyProbe), true, `${name} vocabulary probe must remain schema-valid`);
  assert(
    validateDatasetSemantics(vocabularyProbe).length > 0,
    `${name} reviewed vocabulary entry must be rejected`
  );
}

const withdrawalProbe = structuredClone(datasetGovernanceSource);
withdrawalProbe.samples[0].consentAttestation.withdrawalStatus = "WITHDRAWN";
assert.equal(validateDataset(withdrawalProbe), true, "withdrawal probe must remain schema-valid");
assert(
  validateDatasetSemantics(withdrawalProbe).length > 0,
  "training manifests require active, unwithdrawn consent"
);

const latencyProbe = await readJson(join(fixturesRoot, "model-metadata-production.valid.json"));
latencyProbe.runtime.warmedP95LatencyMs = 0;
assert.equal(validateModel(latencyProbe), false, "APPROVED promotion requires measured warmed Java latency");

const legacyLanguageProbe = await readJson(
  join(fixturesRoot, "model-metadata-production.valid.json")
);
legacyLanguageProbe.targetLanguage = "sg-SG";
assert.equal(
  validateModel(legacyLanguageProbe),
  false,
  "sg-SG identifies Sango plus a region and must not be accepted as Singapore Sign Language"
);

const legacyDatasetLanguageProbe = await readJson(
  join(fixturesRoot, "dataset-manifest.valid.json")
);
legacyDatasetLanguageProbe.targetLanguage = "sg-SG";
for (const sample of legacyDatasetLanguageProbe.samples) {
  sample.language = "sg-SG";
}
assert.equal(
  validateDataset(legacyDatasetLanguageProbe),
  false,
  "dataset manifests must use the IANA Singapore Sign Language tag sls"
);

const vocabularyBindingSource = await readJson(
  join(fixturesRoot, "model-metadata-production.valid.json")
);
const missingSourceProbe = structuredClone(vocabularyBindingSource);
delete missingSourceProbe.sourceProvenance;
assert.equal(validateModel(missingSourceProbe), false, "source provenance is required");
for (const [name, mutate] of [
  ["dirty", (value) => {
    value.dirty = true;
    value.trackedChangesSha256 = "a".repeat(64);
  }],
  ["inconsistent", (value) => { value.dirty = true; }],
]) {
  const probe = structuredClone(vocabularyBindingSource);
  mutate(probe.sourceProvenance);
  assert.equal(validateModel(probe), true, `${name} source probe must remain schema-valid`);
  assert(
    validateModelSemantics(probe).length > 0,
    `${name} source provenance must fail closed for production`
  );
}
assert.equal(
  vocabularyBindingSource.vocabularySha256,
  "bee237eb48aeb5d54320f75d821b9ed93de2d143a3a12c91776df4f3560a5b26",
  "the fixture digest is a cross-runtime known-answer value"
);
for (const [name, mutate] of [
  ["version", (value) => { value.vocabularyVersion = "1.0.1"; }],
  ["digest", (value) => { value.vocabularySha256 = "0".repeat(64); }],
  ["caption", (value) => { value.labels[1].captionText = "hello"; }],
  ["label order", (value) => {
    [value.labels[1].id, value.labels[2].id] = [value.labels[2].id, value.labels[1].id];
    [value.labels[1].captionText, value.labels[2].captionText] = [
      value.labels[2].captionText,
      value.labels[1].captionText,
    ];
  }],
  ["review order", (value) => {
    [value.sgslReview.reviewedLabelIds[0], value.sgslReview.reviewedLabelIds[1]] = [
      value.sgslReview.reviewedLabelIds[1],
      value.sgslReview.reviewedLabelIds[0],
    ];
  }],
]) {
  const probe = structuredClone(vocabularyBindingSource);
  mutate(probe);
  assert.equal(validateModel(probe), true, `${name} probe must remain schema-valid`);
  assert(
    validateModelSemantics(probe).length > 0,
    `${name} mismatch must fail closed`
  );
}

for (const [name, mutate] of [
  ["incomplete support", (value) => { value.lighting[0].support -= 1; }],
  ["unknown genuine handedness", (value) => { value.handedness[0].value = "UNKNOWN"; }],
]) {
  const probe = structuredClone(vocabularyBindingSource);
  mutate(probe.evaluation.metrics.robustnessSlices);
  assert.equal(validateModel(probe), true, `${name} probe must remain schema-valid`);
  assert(
    validateModelSemantics(probe).length > 0,
    `${name} robustness evidence must fail closed`
  );
}

const metricIntegritySource = await readJson(
  join(fixturesRoot, "model-metadata-production.valid.json")
);
const metricIntegrityProbes = [
  ["accuracy", (metrics) => { metrics.accuracy = 0.81; }],
  ["macroF1", (metrics) => { metrics.macroF1 = 0.81; }],
  ["per-class precision", (metrics) => { metrics.perClass[1].precision = 0.81; }],
  ["per-class recall", (metrics) => { metrics.perClass[1].recall = 0.81; }],
  ["per-class F1", (metrics) => { metrics.perClass[1].f1 = 0.81; }],
  ["per-class support", (metrics) => { metrics.perClass[1].support = 24; }],
  ["unknown REJECT support", (metrics) => {
    const behavior = metrics.rejectionBehavior;
    behavior.unknownSampleCount = 50;
    behavior.unknownRejectedCount = 49;
    behavior.unknownRejectionRate = 0.98;
    behavior.unknownFalseFinalCount = 1;
    behavior.unknownFalseFinalRate = 0.02;
  }],
];
for (const [name, mutate] of metricIntegrityProbes) {
  const probe = structuredClone(metricIntegritySource);
  mutate(probe.evaluation.metrics);
  assert.equal(validateModel(probe), true, `${name} probe must remain schema-valid`);
  assert(
    validateModelSemantics(probe).length > 0,
    `${name} must be bound to the confusion matrix`
  );
}

const thresholdEvidenceProbe = structuredClone(metricIntegritySource);
const thresholdEvidence = thresholdEvidenceProbe.evaluation.metrics.rejectionBehavior;
thresholdEvidence.acceptedSignCount = 138;
thresholdEvidence.lowConfidenceRejectionCount = 7;
thresholdEvidence.rejectionRate = 7 / 180;
assert.deepEqual(
  validateModelSemantics(thresholdEvidenceProbe),
  [],
  "internally consistent threshold evidence must not be inferred from argmax columns"
);

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
