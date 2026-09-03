import Ajv2020, { type AnySchema } from "ajv/dist/2020";
import { describe, expect, it } from "vitest";

import cancelled from "../../../../../contracts/continuous-transcript/v1/fixtures/server-transcript-cancelled.valid.json";
import final from "../../../../../contracts/continuous-transcript/v1/fixtures/server-transcript-final.valid.json";
import partial from "../../../../../contracts/continuous-transcript/v1/fixtures/server-transcript-partial.valid.json";
import revised from "../../../../../contracts/continuous-transcript/v1/fixtures/server-transcript-revised.valid.json";
import uncertain from "../../../../../contracts/continuous-transcript/v1/fixtures/server-transcript-uncertain.valid.json";
import uncertainWithText from "../../../../../contracts/continuous-transcript/v1/fixtures/server-transcript-uncertain-with-text.invalid.json";
import withLandmarks from "../../../../../contracts/continuous-transcript/v1/fixtures/server-transcript-with-landmarks.invalid.json";
import schema from "../../../../../contracts/continuous-transcript/v1/server-event.schema.json";

const UUID_PATTERN = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

describe("continuous transcript v1 contract", () => {
  it("accepts lifecycle events and rejects speculative text or landmarks", () => {
    const ajv = new Ajv2020({ allErrors: true, strict: true });
    ajv.addFormat("uuid", (value: string) => UUID_PATTERN.test(value));
    ajv.addFormat("date-time", (value: string) => Number.isFinite(Date.parse(value)));
    const validate = ajv.compile(schema as AnySchema);

    for (const fixture of [partial, revised, final, cancelled, uncertain]) {
      expect(validate(fixture), JSON.stringify(validate.errors)).toBe(true);
    }
    for (const fixture of [uncertainWithText, withLandmarks]) {
      expect(validate(fixture), JSON.stringify(validate.errors)).toBe(false);
    }
  });
});
