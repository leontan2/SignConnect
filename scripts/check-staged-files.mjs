import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";

const MAX_FILE_SIZE = 5 * 1024 * 1024;
const secretPatterns = [
  ["private key", /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/],
  ["AWS access key", /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/],
  ["GitHub token", /\bgithub_pat_[A-Za-z0-9_]{20,}\b|\bgh[pousr]_[A-Za-z0-9]{20,}\b/],
  ["Google API key", /\bAIza[A-Za-z0-9_-]{35}\b/],
  ["OpenAI API key", /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/],
];
const allowedModelBinaryDigests = new Map([
  [
    "backend/sign-inference-service/src/main/resources/models/deterministic-sign-v1.onnx",
    "fd2cf50b2bdbe8c7c6953e0f809b33df2012de2a476b09fcff0e6987e289c4a8",
  ],
]);
// These contract documents describe production-shaped manifests so that the
// schema can be tested. Their exact reviewed bytes are synthetic test data;
// any content change invalidates the exemption instead of trusting the path.
const reviewedSyntheticFixtureDigests = new Map([
  ["contracts/sign-recognition-training/v1/fixtures/dataset-manifest-inline-video.invalid.json", "c0cfd2b5b88232f8402cf108f11af81836b9216d5d7e73a6489f0ca01a4802d7"],
  ["contracts/sign-recognition-training/v1/fixtures/dataset-manifest-media-type-mismatch.invalid.json", "cb60f9c44fc67a2bc6ed701644349fe2a0e74a2fdff6ab01e06203b5e8eb03ab"],
  ["contracts/sign-recognition-training/v1/fixtures/dataset-manifest-missing-consent.invalid.json", "f57d448c2eb0eb69a516d7af74888ca031b9123d0e43926f9e969182f3ee63f9"],
  ["contracts/sign-recognition-training/v1/fixtures/dataset-manifest-path-traversal.invalid.json", "f29fa460dfcc2645bf2212508e38ca15bd98d8846f334c490154b1a570253c8e"],
  ["contracts/sign-recognition-training/v1/fixtures/dataset-manifest-signer-overlap.invalid.json", "f272d87e2d36e855208525d200cc46c05ee5abfbcb437000e74bf277cdda4ca8"],
  ["contracts/sign-recognition-training/v1/fixtures/dataset-manifest-unsupported-extension.invalid.json", "348015385da46020fc03f13c6aff073cec28cab3fd2d9669b415a66133542731"],
  ["contracts/sign-recognition-training/v1/fixtures/dataset-manifest-wrong-frame-count.invalid.json", "ce84fc9a3a08377289e04ba83cb186ce0b287533cb6f929b4e4aa14f39561b9c"],
  ["contracts/sign-recognition-training/v1/fixtures/dataset-manifest.valid.json", "6e52685480eeb3c17ad966751311ebb8c73539e8b9d095e001fbe95b092fcba4"],
  ["ml/sign-recognition/fixtures/NON_PRODUCTION_SYNTHETIC/manifest.template.json", "bf5b6eb7e075f6c789eacd8404f174b366ef51c1606c65415624f2e73db11568"],
]);
const privateTrainingPathPatterns = [
  /^ml\/sign-recognition\/(?:data|captures|consent|runs|artifacts|checkpoints)\//i,
  /^ml\/sign-recognition\/fixtures\/NON_PRODUCTION_SYNTHETIC\/generated\//i,
];
const generatedModelExtension = /\.(?:ckpt|npy|npz|onnx|pt|pth)$/i;
const privateArtifactSegmentPattern =
  /(?:^|\/)(?:captures?|consents?|consent[-_]receipts?|manifests?|private[-_]manifests?|raw[-_]media|browser[-_]recordings?|recordings?|withdrawal[-_]codes?)(?:\/|$)/i;
const privateArtifactFilenamePattern =
  /(?:^|[-_.])(?:captures?|consents?|consent[-_]?receipts?|manifests?|raw[-_]?media|withdrawal[-_]?codes?)(?:[-_.]|$)/i;
const rawMediaExtension =
  /\.(?:aac|avi|bmp|flac|gif|heic|heif|jpe?g|m4a|m4v|mkv|mov|mp3|mp4|mpeg|mpg|ogg|png|tiff?|wav|webm|webp|wmv)$/i;

const PRIVATE_ARTIFACT_FINDING =
  "private training/capture artifacts must remain outside Git";
const PARTICIPANT_CONTENT_FINDING =
  "participant-shaped landmark content must remain outside Git";
const sourceExtension =
  /\.(?:c|cc|cjs|cpp|cs|css|go|h|hpp|html|java|js|jsx|less|mjs|properties|py|rs|sass|scss|sh|ts|tsx|xml|ya?ml)$/i;

function isReviewableSourceOrFixturePath(file) {
  if (/^docs\/.*\.(?:adoc|md|rst|txt)$/i.test(file)) {
    return true;
  }
  if (
    /^(?:backend|frontend|scripts)\//i.test(file) &&
    sourceExtension.test(file)
  ) {
    return true;
  }
  if (
    /^ml\/sign-recognition\/(?:src|tests)\//i.test(file) &&
    sourceExtension.test(file)
  ) {
    return true;
  }
  if (/^contracts\/.*\/(?:fixtures\/.*\.json|[^/]*\.schema\.json)$/i.test(file)) {
    return true;
  }
  return /^ml\/sign-recognition\/fixtures\/NON_PRODUCTION_SYNTHETIC\/(?:README\.md|[^/]*\.template\.json)$/i.test(
    file,
  );
}

function containsFeatureVector(value) {
  const pending = [value];
  while (pending.length > 0) {
    const current = pending.pop();
    if (Array.isArray(current)) {
      if (
        current.length === 224 &&
        current.every((entry) => typeof entry === "number" && Number.isFinite(entry))
      ) {
        return true;
      }
      pending.push(...current);
    } else if (current !== null && typeof current === "object") {
      pending.push(...Object.values(current));
    }
  }
  return false;
}

function containsCoordinateLandmarks(value) {
  const pending = [value];
  let landmarkContainerSeen = false;
  let coordinatePointCount = 0;

  while (pending.length > 0) {
    const current = pending.pop();
    if (Array.isArray(current)) {
      pending.push(...current);
      continue;
    }
    if (current === null || typeof current !== "object") {
      continue;
    }

    if (
      typeof current.x === "number" &&
      Number.isFinite(current.x) &&
      typeof current.y === "number" &&
      Number.isFinite(current.y)
    ) {
      coordinatePointCount += 1;
    }
    for (const [key, nested] of Object.entries(current)) {
      if (/landmarks?/i.test(key) && Array.isArray(nested)) {
        landmarkContainerSeen = true;
      }
      pending.push(nested);
    }
  }

  return landmarkContainerSeen && coordinatePointCount >= 10;
}

function hasParticipantManifestShape(value) {
  const pending = [value];
  while (pending.length > 0) {
    const current = pending.pop();
    if (Array.isArray(current)) {
      pending.push(...current);
      continue;
    }
    if (current === null || typeof current !== "object") {
      continue;
    }

    if (
      Array.isArray(current.samples) &&
      current.samples.some((sample) => {
        if (
          sample === null ||
          typeof sample !== "object" ||
          Array.isArray(sample)
        ) {
          return false;
        }
        const normalizedKeys = new Set(
          Object.keys(sample).map((key) =>
            key.replaceAll(/[-_]/g, "").toLowerCase(),
          ),
        );
        return (
          normalizedKeys.has("signerid") &&
          (normalizedKeys.has("landmarkartifact") ||
            normalizedKeys.has("consentattestation"))
        );
      })
    ) {
      return true;
    }
    pending.push(...Object.values(current));
  }
  return false;
}

function containsNormalizedKey(value, expectedKey) {
  const pending = [value];
  while (pending.length > 0) {
    const current = pending.pop();
    if (Array.isArray(current)) {
      pending.push(...current);
      continue;
    }
    if (current === null || typeof current !== "object") {
      continue;
    }
    for (const [key, nested] of Object.entries(current)) {
      if (key.replaceAll(/[-_]/g, "").toLowerCase() === expectedKey) {
        return true;
      }
      pending.push(nested);
    }
  }
  return false;
}

function containsDelimitedFeatureVector(text) {
  const numberPattern =
    /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/;
  return text.split(/\r?\n/).some((line) => {
    const cells = line.split(/[,\t]/).map((cell) => cell.trim());
    const numericCellCount = cells.filter((cell) => numberPattern.test(cell)).length;
    return numericCellCount >= 224;
  });
}

function hasRawMediaMagic(bytes) {
  const startsWith = (...values) =>
    bytes.length >= values.length &&
    values.every((value, index) => bytes[index] === value);
  const hasAsciiAt = (offset, value) =>
    bytes.length >= offset + value.length &&
    bytes.subarray(offset, offset + value.length).toString("ascii") === value;

  return (
    startsWith(0xff, 0xd8, 0xff) ||
    startsWith(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a) ||
    hasAsciiAt(0, "GIF87a") ||
    hasAsciiAt(0, "GIF89a") ||
    hasAsciiAt(0, "BM") ||
    startsWith(0x49, 0x49, 0x2a, 0x00) ||
    startsWith(0x4d, 0x4d, 0x00, 0x2a) ||
    startsWith(0x1a, 0x45, 0xdf, 0xa3) ||
    hasAsciiAt(4, "ftyp") ||
    hasAsciiAt(0, "OggS") ||
    hasAsciiAt(0, "fLaC") ||
    hasAsciiAt(0, "ID3") ||
    (hasAsciiAt(0, "RIFF") &&
      ["AVI ", "WAVE", "WEBP"].some((kind) => hasAsciiAt(8, kind)))
  );
}

function parseJsonDocuments(text) {
  try {
    return [JSON.parse(text)];
  } catch {
    const documents = [];
    for (const line of text.split(/\r?\n/)) {
      if (line.trim().length === 0) {
        continue;
      }
      try {
        documents.push(JSON.parse(line));
      } catch {
        // Mixed or non-JSON text continues through format-agnostic checks.
      }
    }
    return documents;
  }
}

function decodeReviewableText(bytes) {
  if (bytes.includes(0)) return null;
  let text;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
  return /[\u0001-\u0008\u000b\u000c\u000e-\u001f]/.test(text) ? null : text;
}

function git(args, options = {}) {
  return execFileSync("git", args, { encoding: "utf8", ...options });
}

export function classifyStagedPath(file) {
  const normalized = file.replaceAll("\\", "/").replace(/^\.\//, "");
  const findings = [];
  const reviewableSourceOrFixture = isReviewableSourceOrFixturePath(normalized);
  const filename = normalized.split("/").at(-1) ?? normalized;
  const tokenizedFilename = filename.replace(/([a-z0-9])([A-Z])/g, "$1-$2");

  if (
    !reviewableSourceOrFixture &&
    (privateTrainingPathPatterns.some((pattern) => pattern.test(normalized)) ||
      privateArtifactSegmentPattern.test(normalized) ||
      privateArtifactFilenamePattern.test(tokenizedFilename) ||
      rawMediaExtension.test(normalized))
  ) {
    findings.push(PRIVATE_ARTIFACT_FINDING);
  }
  if (
    generatedModelExtension.test(normalized) &&
    !allowedModelBinaryDigests.has(normalized)
  ) {
    findings.push(
      "generated model or tensor artifacts require an explicit reviewed allowlist entry",
    );
  }

  return findings;
}

export function classifyStagedContent(file, content) {
  const bytes = Buffer.isBuffer(content) ? content : Buffer.from(content);
  const findings = [];
  const normalized = file.replaceAll("\\", "/").replace(/^\.\//, "");

  if (bytes.length > MAX_FILE_SIZE) {
    return ["staged file exceeds 5 MiB"];
  }
  if (hasRawMediaMagic(bytes)) {
    return ["raw media binary content must remain outside Git"];
  }
  const text = decodeReviewableText(bytes);
  if (text === null) {
    const expectedDigest = allowedModelBinaryDigests.get(normalized);
    if (expectedDigest === undefined) {
      return ["opaque binary content requires an explicit reviewed allowlist entry"];
    }
    return createHash("sha256").update(bytes).digest("hex") === expectedDigest
      ? findings
      : ["allowlisted binary content does not match its reviewed SHA-256"];
  }

  if (/^(?:<<<<<<<|>>>>>>>)(?: .*)?$/m.test(text)) {
    findings.push("unresolved merge-conflict marker detected");
  }
  for (const [name, pattern] of secretPatterns) {
    if (pattern.test(text)) {
      findings.push(`possible ${name} detected`);
    }
  }

  const parsedDocuments = parseJsonDocuments(text);
  const reviewedFixtureDigest = reviewedSyntheticFixtureDigests.get(normalized);
  const explicitlySyntheticFixture =
    reviewedFixtureDigest !== undefined &&
    createHash("sha256").update(bytes).digest("hex") === reviewedFixtureDigest;

  if (!explicitlySyntheticFixture) {
    if (containsDelimitedFeatureVector(text)) {
      findings.push(PARTICIPANT_CONTENT_FINDING);
    }
    if (
      parsedDocuments.some(
        (parsed) =>
          containsFeatureVector(parsed) || containsCoordinateLandmarks(parsed),
      ) &&
      !findings.includes(PARTICIPANT_CONTENT_FINDING)
    ) {
      findings.push(PARTICIPANT_CONTENT_FINDING);
    }
  }

  if (/\bdata:(?:audio|image|video)\/[a-z0-9.+-]+;base64,/i.test(text)) {
    findings.push("inline raw media content must remain outside Git");
  }
  if (
    /\bwithdrawal[-_ ]?code\b\s*(?:=|:)\s*["']?[a-z0-9][a-z0-9_-]{7,}/i.test(
      text,
    )
  ) {
    findings.push("withdrawal code content must remain outside Git");
  }
  if (
    !explicitlySyntheticFixture &&
    parsedDocuments.some((parsed) => hasParticipantManifestShape(parsed))
  ) {
    findings.push("participant training manifest content must remain outside Git");
  }
  if (
    parsedDocuments.some((parsed) =>
      containsNormalizedKey(parsed, "withdrawalcode"),
    ) &&
    !findings.includes("withdrawal code content must remain outside Git")
  ) {
    findings.push("withdrawal code content must remain outside Git");
  }

  return findings;
}

function run() {
  const errors = [];
  let stagedFiles;
  try {
    stagedFiles = git([
      "diff",
      "--cached",
      "--name-only",
      "--diff-filter=ACMR",
      "-z",
    ])
      .split("\0")
      .filter(Boolean);
  } catch {
    console.error("Staged-file checks failed: unable to inspect staged Git state.");
    process.exitCode = 1;
    return;
  }

  try {
    git(["diff", "--cached", "--check"]);
  } catch {
    errors.push("staged diff contains whitespace errors");
  }

  for (const file of stagedFiles) {
    const pathFindings = classifyStagedPath(file);
    errors.push(...pathFindings.map((finding) => `${file}: ${finding}`));
    if (pathFindings.length > 0) {
      continue;
    }

    let content;
    try {
      content = execFileSync("git", ["show", `:${file}`]);
    } catch {
      errors.push(`${file}: unable to inspect staged content`);
      continue;
    }
    errors.push(
      ...classifyStagedContent(file, content).map(
        (finding) => `${file}: ${finding}`,
      ),
    );
  }

  if (errors.length > 0) {
    console.error("Staged-file checks failed:\n");
    console.error(errors.map((error) => `- ${error}`).join("\n"));
    process.exitCode = 1;
    return;
  }

  console.log(`Staged-file checks passed (${stagedFiles.length} file(s)).`);
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  run();
}
