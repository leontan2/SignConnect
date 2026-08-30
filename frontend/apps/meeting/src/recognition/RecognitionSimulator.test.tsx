import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import RecognitionSimulator from "./RecognitionSimulator";

describe("RecognitionSimulator development module", () => {
  it("emits the legacy demo event only from the explicitly included development module", async () => {
    const send = vi.fn(() => true);
    render(<RecognitionSimulator connected send={send} />);

    expect(screen.getByText("Recognizer simulator")).toBeVisible();
    expect(screen.getByText(/server development profile must also be active/i)).toBeVisible();
    await userEvent.setup().click(screen.getByRole("button", { name: "Hello everyone" }));

    expect(send).toHaveBeenNthCalledWith(1, {
      schemaVersion: 1,
      type: "signer.request",
      requestId: "11111111-1111-4111-8111-111111111111",
      streamId: "00000000-0000-4000-8000-000000000000",
      sequence: 0,
      timestampMs: expect.any(Number)
    });
    expect(send).toHaveBeenNthCalledWith(2, {
      type: "recognition.result",
      sequence: 1,
      payload: { text: "Hello everyone", confidence: 0.93 }
    });
  });
});
