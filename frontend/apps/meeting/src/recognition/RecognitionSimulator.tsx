import React, { useRef } from "react";
import { Send } from "lucide-react";

import type { ClientRealtimeEvent } from "../api";

const DEMO_PHRASES = ["Hello everyone", "Please repeat that", "Thank you"] as const;
const SIMULATOR_BUNDLE_MARKER = "signconnect-recognition-simulator-v1";
const SIMULATOR_REQUEST_ID = "11111111-1111-4111-8111-111111111111";
const SIMULATOR_STREAM_ID = "00000000-0000-4000-8000-000000000000";

export interface RecognitionSimulatorProps {
  connected: boolean;
  send(event: ClientRealtimeEvent): boolean;
}

export default function RecognitionSimulator({
  connected,
  send
}: RecognitionSimulatorProps): React.ReactElement {
  const resultSequence = useRef(0);
  const requestSequence = useRef(0);

  function sendDemoPhrase(text: string): void {
    if (!connected) return;
    const ownershipRequested = send({
      schemaVersion: 1,
      type: "signer.request",
      requestId: SIMULATOR_REQUEST_ID,
      streamId: SIMULATOR_STREAM_ID,
      sequence: requestSequence.current,
      timestampMs: Date.now()
    });
    if (!ownershipRequested) return;
    requestSequence.current += 1;
    resultSequence.current += 1;
    send({
      type: "recognition.result",
      sequence: resultSequence.current,
      payload: { text, confidence: 0.93 }
    });
  }

  return (
    <div className="simulator-panel" data-simulator-bundle-marker={SIMULATOR_BUNDLE_MARKER}>
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
