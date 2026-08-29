import { useState } from "react";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import validLandmarkChunk from "../../../../../contracts/sign-recognition/v1/fixtures/landmark-chunk.valid.json";

type LandmarkChunkFixture = {
  schemaVersion: number;
  type: string;
  frames: Array<{
    features: number[];
  }>;
};

const landmarkChunk = validLandmarkChunk as LandmarkChunkFixture;

function FoundationProbe() {
  const [clickCount, setClickCount] = useState(0);

  return (
    <button type="button" onClick={() => setClickCount((count) => count + 1)}>
      Clicks: {clickCount}
    </button>
  );
}

describe.sequential("frontend test foundation", () => {
  it("supports DOM matchers, user interaction, fake timers, and JSON fixtures", async () => {
    const user = userEvent.setup();
    render(<FoundationProbe />);

    const button = screen.getByRole("button", { name: "Clicks: 0" });
    expect(button).toBeInTheDocument();

    await user.click(button);

    expect(button).toHaveAccessibleName("Clicks: 1");
    expect(landmarkChunk).toMatchObject({
      schemaVersion: 1,
      type: "landmark.chunk"
    });
    expect(landmarkChunk.frames).toHaveLength(5);
    expect(landmarkChunk.frames.every((frame) => frame.features.length === 224)).toBe(true);

    vi.useFakeTimers();
    expect(Date.now()).toBe(0);
  });

  it("cleans rendered components between tests", () => {
    expect(document.body).toBeEmptyDOMElement();
  });
});
