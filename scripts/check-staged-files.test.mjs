import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  classifyStagedContent,
  classifyStagedPath,
} from "./check-staged-files.mjs";

test("private capture paths are rejected wherever they appear", () => {
  assert.deepEqual(classifyStagedPath("exports/captures/signer-01.json"), [
    "private training/capture artifacts must remain outside Git",
  ]);
});

test("private consent, manifest, raw-media, recording, and withdrawal paths are rejected", () => {
  const privatePaths = [
    "backup/consent-receipts/signer.json",
    "staging/manifests/dataset.json",
    "transfer/raw-media/take.webm",
    "ops/withdrawal-codes/active.txt",
    "incoming/take-01.mp4",
    "team/browser-recordings/session.webm",
  ];

  for (const path of privatePaths) {
    assert.deepEqual(classifyStagedPath(path), [
      "private training/capture artifacts must remain outside Git",
    ]);
  }
});

test("private artifact filename patterns are rejected outside reviewable source and fixtures", () => {
  const privateFiles = [
    "backup/participant-consent-receipt.json",
    "staging/signer-manifest.json",
    "ops/active-withdrawal-codes.csv",
    "misc/camera-capture.dat",
    "misc/raw-media-export.bin",
    "misc/cameraCapture.dat",
    "misc/rawMediaExport.bin",
    "misc/withdrawalCode.txt",
    "misc/signerManifest.json",
  ];

  for (const path of privateFiles) {
    assert.deepEqual(classifyStagedPath(path), [
      "private training/capture artifacts must remain outside Git",
    ]);
  }
});

test("source, documentation, contract fixtures, and labeled synthetic templates stay reviewable", () => {
  const reviewablePaths = [
    "docs/privacy/consent/notice.md",
    "scripts/manifests/check-consent.mjs",
    "frontend/apps/meeting/src/captures/CaptureController.ts",
    "frontend/apps/meeting/src/captures/capture.css",
    "backend/meeting-service/src/main/resources/manifests/example.yaml",
    "contracts/sign-recognition-training/v1/fixtures/dataset-manifest.valid.json",
    "ml/sign-recognition/fixtures/NON_PRODUCTION_SYNTHETIC/manifest.template.json",
  ];

  for (const path of reviewablePaths) {
    assert.deepEqual(classifyStagedPath(path), []);
  }
});

test("participant-shaped landmark JSON is rejected outside approved fixtures", () => {
  const participantExport = JSON.stringify({
    sampleId: "sample_private_01",
    signerId: "sgn_private_01",
    landmarks: [Array.from({ length: 224 }, (_, index) => index / 1000)],
  });

  assert.deepEqual(
    classifyStagedContent("exports/session.json", participantExport),
    ["participant-shaped landmark content must remain outside Git"],
  );
});

test("participant training manifests are rejected even under an innocuous path", () => {
  const privateManifest = JSON.stringify({
    export: {
      datasetId: "local-study",
      samples: [
        {
          signerId: "sgn_private_02",
          landmarkArtifact: { path: "landmarks/take-02.npz" },
          consentAttestation: { status: "VERIFIED" },
        },
      ],
    },
  });

  assert.deepEqual(classifyStagedContent("misc/data.json", privateManifest), [
    "participant training manifest content must remain outside Git",
  ]);
});

test("withdrawal codes are rejected without echoing the code in the finding", () => {
  const receipt = JSON.stringify({
    signerId: "sgn_private_03",
    [["withdrawal", "Code"].join("")]: "do-not-print-this-code",
  });

  assert.deepEqual(classifyStagedContent("misc/receipt.json", receipt), [
    "withdrawal code content must remain outside Git",
  ]);
});

test("a 224-feature participant row is rejected in delimited text", () => {
  const landmarkRow = Array.from(
    { length: 224 },
    (_, index) => (index / 1000).toFixed(3),
  ).join(",");

  assert.deepEqual(classifyStagedContent("misc/session.csv", landmarkRow), [
    "participant-shaped landmark content must remain outside Git",
  ]);
});

test("participant-shaped landmark JSON Lines cannot bypass JSON inspection", () => {
  const frame = JSON.stringify({
    sampleId: "sample_private_04",
    features: Array.from({ length: 224 }, (_, index) => index / 1000),
  });
  const jsonLines = `${frame}\n${frame}\n`;

  assert.deepEqual(classifyStagedContent("misc/session.jsonl", jsonLines), [
    "participant-shaped landmark content must remain outside Git",
  ]);
});

test("raw MediaPipe landmark coordinates are recognized as participant-shaped", () => {
  const rawFrame = JSON.stringify({
    poseLandmarks: Array.from({ length: 33 }, (_, index) => ({
      x: index / 100,
      y: index / 200,
      z: index / 300,
      visibility: 0.99,
    })),
  });

  assert.deepEqual(classifyStagedContent("misc/debug-frame.json", rawFrame), [
    "participant-shaped landmark content must remain outside Git",
  ]);
});

test("inline raw media is rejected when hidden in a generic text file", () => {
  const disguisedMedia = JSON.stringify({
    attachment: ["data", "video/webm;base64,Y2FtZXJhLWZyYW1lcw=="].join(":"),
  });

  assert.deepEqual(
    classifyStagedContent("misc/attachment.txt", disguisedMedia),
    ["inline raw media content must remain outside Git"],
  );
});

test("renaming raw media to a generic binary extension does not bypass the guard", () => {
  const disguisedMp4 = Buffer.from([
    0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d,
  ]);

  assert.deepEqual(classifyStagedContent("misc/attachment.bin", disguisedMp4), [
    "raw media binary content must remain outside Git",
  ]);
});

test("opaque binary content requires an exact reviewed digest", () => {
  const opaqueBinary = Buffer.from([0x00, 0x01, 0x02, 0x03]);
  const modelPath =
    "backend/sign-inference-service/src/main/resources/models/deterministic-sign-v1.onnx";

  assert.deepEqual(classifyStagedContent("misc/private-export.bin", opaqueBinary), [
    "opaque binary content requires an explicit reviewed allowlist entry",
  ]);
  assert.deepEqual(
    classifyStagedContent(modelPath, opaqueBinary),
    ["allowlisted binary content does not match its reviewed SHA-256"],
  );
  assert.deepEqual(
    classifyStagedContent(modelPath, readFileSync(modelPath)),
    [],
  );
});

test("withdrawal codes are rejected in non-JSON receipts", () => {
  const receipt = ["withdrawal", "code = do-not-print-this-code"].join("-");

  assert.deepEqual(classifyStagedContent("misc/receipt.txt", receipt), [
    "withdrawal code content must remain outside Git",
  ]);
});

test("privacy vocabulary remains allowed in source, docs, and documented fixtures", () => {
  const documentedExample =
    "This review describes withdrawal codes and the 224-feature contract without embedding either value.";
  const reviewablePaths = [
    "docs/privacy/capture-boundary.md",
    "scripts/check-capture-example.mjs",
    "contracts/sign-recognition/v1/fixtures/landmark-chunk.valid.json",
    "ml/sign-recognition/fixtures/NON_PRODUCTION_SYNTHETIC/manifest.template.json",
  ];

  for (const path of reviewablePaths) {
    assert.deepEqual(classifyStagedContent(path, documentedExample), []);
  }
});

test("reviewable source and fixture paths do not exempt inline media or withdrawal values", () => {
  assert.deepEqual(
    classifyStagedContent(
      "frontend/apps/meeting/src/privacy-example.ts",
      ['const capturedFrame = "data', 'image/png;base64,Y2FtZXJhLWZyYW1l";'].join(":"),
    ),
    ["inline raw media content must remain outside Git"],
  );
  assert.deepEqual(
    classifyStagedContent(
      "contracts/sign-recognition/v1/fixtures/private-receipt.json",
      JSON.stringify({
        [["withdrawal", "Code"].join("")]: "do-not-commit-this-code",
      }),
    ),
    ["withdrawal code content must remain outside Git"],
  );
});

test("marker-only synthetic provenance does not exempt participant content", () => {
  const syntheticVector = JSON.stringify({
    provenance: "NON_PRODUCTION_SYNTHETIC",
    features: Array.from({ length: 224 }, () => 0),
  });
  assert.deepEqual(
    classifyStagedContent(
      "contracts/sign-recognition/v1/fixtures/marker-only-vector.json",
      syntheticVector,
    ),
    ["participant-shaped landmark content must remain outside Git"],
  );

  const syntheticManifest = JSON.stringify({
    synthetic: true,
    samples: [
      {
        signerId: "sgn_marker_only",
        landmarkArtifact: { path: "landmarks/take.npz" },
      },
    ],
  });
  assert.deepEqual(
    classifyStagedContent(
      "contracts/sign-recognition/v1/fixtures/marker-only-manifest.json",
      syntheticManifest,
    ),
    ["participant training manifest content must remain outside Git"],
  );
});

test("contract fixture paths do not exempt unreviewed feature vectors", () => {
  const participantVector = JSON.stringify({
    sampleId: "sample_private_fixture_01",
    signerId: "sgn_private_fixture_01",
    features: Array.from({ length: 224 }, (_, index) => index / 1000),
  });

  assert.deepEqual(
    classifyStagedContent(
      "contracts/sign-recognition/v1/fixtures/unreviewed-human.json",
      participantVector,
    ),
    ["participant-shaped landmark content must remain outside Git"],
  );
});

test("participant-shaped content cannot be disguised as source or documentation", () => {
  const participantExport = JSON.stringify({
    features: Array.from({ length: 224 }, (_, index) => index / 1000),
  });

  for (const path of ["docs/example.md", "scripts/example.mjs"]) {
    assert.deepEqual(classifyStagedContent(path, participantExport), [
      "participant-shaped landmark content must remain outside Git",
    ]);
  }
});

test("secret findings identify only the category, never the matched value", () => {
  const secret = `sk-${"x".repeat(24)}`;
  const findings = classifyStagedContent("misc/config.txt", `apiKey=${secret}`);

  assert.deepEqual(findings, ["possible OpenAI API key detected"]);
  assert.equal(findings.join("\n").includes(secret), false);
});
