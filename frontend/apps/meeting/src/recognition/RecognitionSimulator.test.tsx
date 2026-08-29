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

    expect(send).toHaveBeenCalledWith({
      type: "recognition.result",
      sequence: 1,
      payload: { text: "Hello everyone", confidence: 0.93 }
    });
  });
});
