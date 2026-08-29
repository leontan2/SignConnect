import React, { useRef } from "react";
import { Send } from "lucide-react";

import type { LegacyRecognitionResultEvent } from "../api";

const DEMO_PHRASES = ["Hello everyone", "Please repeat that", "Thank you"] as const;

export interface RecognitionSimulatorProps {
  connected: boolean;
  send(event: LegacyRecognitionResultEvent): boolean;
}

export default function RecognitionSimulator({
  connected,
  send
}: RecognitionSimulatorProps): React.ReactElement {
  const sequence = useRef(0);

  function sendDemoPhrase(text: string): void {
    if (!connected) return;
    sequence.current += 1;
    send({
      type: "recognition.result",
      sequence: sequence.current,
      payload: { text, confidence: 0.93 }
    });
  }

  return (
    <div className="simulator-panel">
      <div>
        <strong>Recognizer simulator</strong>
        <span>Development only; the server development profile must also be active.</span>
      </div>
      <div className="phrase-actions">
        {DEMO_PHRASES.map((phrase) => (
          <button type="button" onClick={() => sendDemoPhrase(phrase)} disabled={!connected} key={phrase}>
            <Send size={14} aria-hidden="true" />
            {phrase}
          </button>
        ))}
      </div>
    </div>
  );
}
