import Ajv2020, { type AnySchema, type ValidateFunction } from "ajv/dist/2020";
import { describe, expect, it } from "vitest";

import activeToIdleSequence from "../../../../../contracts/sign-recognition/v1/fixtures/active-to-idle.sequence.json";
import inferenceRequestActive from "../../../../../contracts/sign-recognition/v1/fixtures/inference-request-active.valid.json";
import inferenceRequestExtraRawFrame from "../../../../../contracts/sign-recognition/v1/fixtures/inference-request-extra-raw-frame.invalid.json";
import inferenceRequestIdle from "../../../../../contracts/sign-recognition/v1/fixtures/inference-request-idle.valid.json";
import inferenceRequestMissingStream from "../../../../../contracts/sign-recognition/v1/fixtures/inference-request-missing-stream-id.invalid.json";
import inferenceRequestNonNumber from "../../../../../contracts/sign-recognition/v1/fixtures/inference-request-non-number.invalid.json";
import inferenceRequestWrongFeatureCount from "../../../../../contracts/sign-recognition/v1/fixtures/inference-request-wrong-feature-count.invalid.json";
import inferenceRequestWrongFrameCount from "../../../../../contracts/sign-recognition/v1/fixtures/inference-request-wrong-frame-count.invalid.json";
import inferenceRequestWrongVersion from "../../../../../contracts/sign-recognition/v1/fixtures/inference-request-wrong-version.invalid.json";
import inferenceResponseActive from "../../../../../contracts/sign-recognition/v1/fixtures/inference-response-active.valid.json";
import inferenceResponseIdle from "../../../../../contracts/sign-recognition/v1/fixtures/inference-response-idle.valid.json";
import inferenceResponseMissingMockMarker from "../../../../../contracts/sign-recognition/v1/fixtures/inference-response-missing-mock-marker.invalid.json";
import landmarkChunkExtraRawFrame from "../../../../../contracts/sign-recognition/v1/fixtures/landmark-chunk-extra-raw-frame.invalid.json";
import landmarkChunkIdle from "../../../../../contracts/sign-recognition/v1/fixtures/landmark-chunk-idle.valid.json";
import landmarkChunkMissingStream from "../../../../../contracts/sign-recognition/v1/fixtures/landmark-chunk-missing-stream-id.invalid.json";
import landmarkChunkNonNumber from "../../../../../contracts/sign-recognition/v1/fixtures/landmark-chunk-non-number.invalid.json";
import landmarkChunkValid from "../../../../../contracts/sign-recognition/v1/fixtures/landmark-chunk.valid.json";
import landmarkChunkWrongFeatureCount from "../../../../../contracts/sign-recognition/v1/fixtures/landmark-chunk-wrong-feature-count.invalid.json";
import landmarkChunkWrongVersion from "../../../../../contracts/sign-recognition/v1/fixtures/landmark-chunk-wrong-version.invalid.json";
import recognitionControlExtraVideo from "../../../../../contracts/sign-recognition/v1/fixtures/recognition-control-extra-video.invalid.json";
import recognitionControlStart from "../../../../../contracts/sign-recognition/v1/fixtures/recognition-control-start.valid.json";
import recognitionControlStop from "../../../../../contracts/sign-recognition/v1/fixtures/recognition-control-stop.valid.json";
import serverCaptionFinalMalformedMetadata from "../../../../../contracts/sign-recognition/v1/fixtures/server-caption-final-malformed-metadata.invalid.json";
import serverCaptionFinal from "../../../../../contracts/sign-recognition/v1/fixtures/server-caption-final.valid.json";
import serverRecognitionStatusReady from "../../../../../contracts/sign-recognition/v1/fixtures/server-recognition-status-ready.valid.json";
import serverRecognitionStatusUnavailable from "../../../../../contracts/sign-recognition/v1/fixtures/server-recognition-status-unavailable.valid.json";
import serverRecognitionUnknown from "../../../../../contracts/sign-recognition/v1/fixtures/server-recognition-unknown.valid.json";
import inferenceRequestSchema from "../../../../../contracts/sign-recognition/v1/inference-request.schema.json";
import inferenceResponseSchema from "../../../../../contracts/sign-recognition/v1/inference-response.schema.json";
import landmarkChunkSchema from "../../../../../contracts/sign-recognition/v1/landmark-chunk.schema.json";
import recognitionControlSchema from "../../../../../contracts/sign-recognition/v1/recognition-control.schema.json";
import serverEventSchema from "../../../../../contracts/sign-recognition/v1/server-event.schema.json";

type FixtureCase = {
  name: string;
  value: unknown;
  valid: boolean;
};

const UUID_PATTERN = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const RFC_3339_PATTERN = /^\d{4}-\d{2}-\d{2}[Tt]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:[Zz]|[+-]\d{2}:\d{2})$/;

function contractValidator(schema: AnySchema): ValidateFunction {
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  ajv.addFormat("uuid", {
    type: "string",
    validate: (value: string) => UUID_PATTERN.test(value)
  });
  ajv.addFormat("date-time", {
    type: "string",
    validate: (value: string) => RFC_3339_PATTERN.test(value) && Number.isFinite(Date.parse(value))
  });
  return ajv.compile(schema);
}

function expectFixture(
  validate: ValidateFunction,
  fixture: FixtureCase
): void {
  const actual = validate(fixture.value);
  const safeErrors = validate.errors?.map((error) => ({
    instancePath: error.instancePath,
    schemaPath: error.schemaPath,
    keyword: error.keyword,
    message: error.message
  }));
  expect(actual, `${fixture.name}: ${JSON.stringify(safeErrors ?? [])}`).toBe(fixture.valid);
}

describe("shared sign-recognition v1 contracts", () => {
  it("validates every recognition.control fixture", () => {
    const validate = contractValidator(recognitionControlSchema as AnySchema);
    const fixtures: FixtureCase[] = [
      { name: "recognition-control-start.valid.json", value: recognitionControlStart, valid: true },
      { name: "recognition-control-stop.valid.json", value: recognitionControlStop, valid: true },
      { name: "recognition-control-extra-video.invalid.json", value: recognitionControlExtraVideo, valid: false }
    ];
    fixtures.forEach((fixture) => expectFixture(validate, fixture));
  });

  it("validates every landmark.chunk fixture", () => {
    const validate = contractValidator(landmarkChunkSchema as AnySchema);
    const fixtures: FixtureCase[] = [
      { name: "landmark-chunk.valid.json", value: landmarkChunkValid, valid: true },
      { name: "landmark-chunk-idle.valid.json", value: landmarkChunkIdle, valid: true },
      { name: "landmark-chunk-extra-raw-frame.invalid.json", value: landmarkChunkExtraRawFrame, valid: false },
      { name: "landmark-chunk-missing-stream-id.invalid.json", value: landmarkChunkMissingStream, valid: false },
      { name: "landmark-chunk-non-number.invalid.json", value: landmarkChunkNonNumber, valid: false },
      { name: "landmark-chunk-wrong-feature-count.invalid.json", value: landmarkChunkWrongFeatureCount, valid: false },
      { name: "landmark-chunk-wrong-version.invalid.json", value: landmarkChunkWrongVersion, valid: false }
    ];
    fixtures.forEach((fixture) => expectFixture(validate, fixture));
  });

  it("validates every inference request fixture", () => {
    const validate = contractValidator(inferenceRequestSchema as AnySchema);
    const fixtures: FixtureCase[] = [
      { name: "inference-request-active.valid.json", value: inferenceRequestActive, valid: true },
      { name: "inference-request-idle.valid.json", value: inferenceRequestIdle, valid: true },
      { name: "inference-request-extra-raw-frame.invalid.json", value: inferenceRequestExtraRawFrame, valid: false },
      { name: "inference-request-missing-stream-id.invalid.json", value: inferenceRequestMissingStream, valid: false },
      { name: "inference-request-non-number.invalid.json", value: inferenceRequestNonNumber, valid: false },
      { name: "inference-request-wrong-feature-count.invalid.json", value: inferenceRequestWrongFeatureCount, valid: false },
      { name: "inference-request-wrong-frame-count.invalid.json", value: inferenceRequestWrongFrameCount, valid: false },
      { name: "inference-request-wrong-version.invalid.json", value: inferenceRequestWrongVersion, valid: false }
    ];
    fixtures.forEach((fixture) => expectFixture(validate, fixture));
  });

  it("validates every inference response fixture", () => {
    const validate = contractValidator(inferenceResponseSchema as AnySchema);
    const fixtures: FixtureCase[] = [
      { name: "inference-response-active.valid.json", value: inferenceResponseActive, valid: true },
      { name: "inference-response-idle.valid.json", value: inferenceResponseIdle, valid: true },
      {
        name: "inference-response-missing-mock-marker.invalid.json",
        value: inferenceResponseMissingMockMarker,
        valid: false
      }
    ];
    fixtures.forEach((fixture) => expectFixture(validate, fixture));
  });

  it("validates every server-event fixture", () => {
    const validate = contractValidator(serverEventSchema as AnySchema);
    const fixtures: FixtureCase[] = [
      { name: "server-caption-final.valid.json", value: serverCaptionFinal, valid: true },
      { name: "server-recognition-status-ready.valid.json", value: serverRecognitionStatusReady, valid: true },
      {
        name: "server-recognition-status-unavailable.valid.json",
        value: serverRecognitionStatusUnavailable,
        valid: true
      },
      { name: "server-recognition-unknown.valid.json", value: serverRecognitionUnknown, valid: true },
      {
        name: "server-caption-final-malformed-metadata.invalid.json",
        value: serverCaptionFinalMalformedMetadata,
        valid: false
      }
    ];
    fixtures.forEach((fixture) => expectFixture(validate, fixture));
  });

  it("validates every schema-bound artifact nested in the active-to-idle replay", () => {
    const validateControl = contractValidator(recognitionControlSchema as AnySchema);
    const validateChunk = contractValidator(landmarkChunkSchema as AnySchema);
    const validateResponse = contractValidator(inferenceResponseSchema as AnySchema);
    const validateServerEvent = contractValidator(serverEventSchema as AnySchema);

    expectFixture(validateControl, {
      name: "active-to-idle.sequence.json startControl",
      value: activeToIdleSequence.startControl,
      valid: true
    });
    activeToIdleSequence.chunks.forEach((chunk, index) => expectFixture(validateChunk, {
      name: `active-to-idle.sequence.json chunk ${index}`,
      value: chunk,
      valid: true
    }));
    activeToIdleSequence.expectedInference.forEach((entry, index) => expectFixture(validateResponse, {
      name: `active-to-idle.sequence.json response ${index}`,
      value: entry.response,
      valid: true
    }));
    expectFixture(validateServerEvent, {
      name: "active-to-idle.sequence.json expectedFinalCaption",
      value: activeToIdleSequence.expectedFinalCaption,
      valid: true
    });
    expectFixture(validateControl, {
      name: "active-to-idle.sequence.json stopControl",
      value: activeToIdleSequence.stopControl,
      valid: true
    });
  });
});
