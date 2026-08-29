import React, { useEffect, useRef, useState } from "react";
import {
  Captions,
  Check,
  CircleAlert,
  LoaderCircle,
  LockKeyhole,
  Radio,
  Send,
  Video,
  VideoOff
} from "lucide-react";
import { createMeeting, realtimeEndpoint, type CaptionEvent, type Meeting } from "./api";
import "./meeting.css";

type ConnectionState = "idle" | "connecting" | "connected" | "error";

const demoPhrases = ["Hello everyone", "Please repeat that", "Thank you"];

export default function MeetingApp() {
  const [meeting, setMeeting] = useState<Meeting | null>(null);
  const [connection, setConnection] = useState<ConnectionState>("idle");
  const [cameraEnabled, setCameraEnabled] = useState(false);
  const [captions, setCaptions] = useState<CaptionEvent[]>([]);
  const [error, setError] = useState<string | null>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const socketRef = useRef<WebSocket | null>(null);
  const sequenceRef = useRef(0);

  useEffect(() => {
    return () => {
      streamRef.current?.getTracks().forEach(track => track.stop());
      socketRef.current?.close();
    };
  }, []);

  async function toggleCamera() {
    if (cameraEnabled) {
      streamRef.current?.getTracks().forEach(track => track.stop());
      streamRef.current = null;
      if (videoRef.current) videoRef.current.srcObject = null;
      setCameraEnabled(false);
      return;
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
      streamRef.current = stream;
      if (videoRef.current) videoRef.current.srcObject = stream;
      setCameraEnabled(true);
      setError(null);
    } catch {
      setError("Camera permission was not granted.");
    }
  }

  async function startMeeting() {
    setConnection("connecting");
    setError(null);

    try {
      const createdMeeting = await createMeeting("Accessible team sync");
      const socket = new WebSocket(realtimeEndpoint(createdMeeting.id));

      socket.onopen = () => setConnection("connected");
      socket.onerror = () => {
        setConnection("error");
        setError("The realtime caption service is unavailable.");
      };
      socket.onclose = () => setConnection(current => current === "error" ? current : "idle");
      socket.onmessage = event => {
        const caption = JSON.parse(event.data) as CaptionEvent;
        setCaptions(current => [...current, caption]);
      };

      socketRef.current = socket;
      setMeeting(createdMeeting);
    } catch {
      setConnection("error");
      setError("The meeting service is unavailable.");
    }
  }

  function sendDemoPhrase(text: string) {
    const socket = socketRef.current;
    if (!socket || socket.readyState !== WebSocket.OPEN) return;

    sequenceRef.current += 1;
    socket.send(JSON.stringify({
      type: "recognition.result",
      sequence: sequenceRef.current,
      payload: { text, confidence: 0.93 }
    }));
  }

  const isConnected = connection === "connected";

  return (
    <section className="meeting-workspace" aria-labelledby="meeting-title">
      <header className="meeting-header">
        <div>
          <span className="meeting-eyebrow">Live interpretation</span>
          <h1 id="meeting-title">Accessible team sync</h1>
          <p>Singapore Sign Language pilot workspace</p>
        </div>
        <div className={`connection-state ${connection}`} aria-live="polite">
          {connection === "connecting" && <LoaderCircle size={15} className="spin" aria-hidden="true" />}
          {connection === "connected" && <Radio size={15} aria-hidden="true" />}
          {connection === "error" && <CircleAlert size={15} aria-hidden="true" />}
          {connection === "idle" && <span className="idle-dot" aria-hidden="true" />}
          {connection === "idle" ? "Not connected" : connection}
        </div>
      </header>

      {error && (
        <div className="meeting-alert" role="alert">
          <CircleAlert size={17} aria-hidden="true" />
          {error}
        </div>
      )}

      <div className="meeting-grid">
        <div className="video-column">
          <div className="video-stage">
            <video ref={videoRef} autoPlay muted playsInline className={cameraEnabled ? "visible" : ""} />
            {!cameraEnabled && (
              <div className="camera-empty">
                <VideoOff size={30} strokeWidth={1.5} aria-hidden="true" />
                <span>Camera is off</span>
              </div>
            )}
            <div className="video-label">
              <span>You</span>
              <span className="language-chip">SGSL</span>
            </div>
            <div className="video-controls">
              <button
                className={cameraEnabled ? "icon-control active" : "icon-control"}
                type="button"
                onClick={toggleCamera}
                title={cameraEnabled ? "Turn camera off" : "Turn camera on"}
                aria-label={cameraEnabled ? "Turn camera off" : "Turn camera on"}
              >
                {cameraEnabled ? <Video size={19} /> : <VideoOff size={19} />}
              </button>
            </div>
          </div>

          <div className="simulator-panel">
            <div>
              <strong>Recognizer simulator</strong>
              <span>Temporary input while the sign model is integrated</span>
            </div>
            <div className="phrase-actions">
              {demoPhrases.map(phrase => (
                <button type="button" onClick={() => sendDemoPhrase(phrase)} disabled={!isConnected} key={phrase}>
                  <Send size={14} aria-hidden="true" />
                  {phrase}
                </button>
              ))}
            </div>
          </div>
        </div>

        <aside className="transcript" aria-label="Live transcript">
          <div className="transcript-header">
            <div>
              <Captions size={18} aria-hidden="true" />
              <h2>Live transcript</h2>
            </div>
            <span>{captions.length}</span>
          </div>

          <div className="caption-list" aria-live="polite">
            {captions.length === 0 ? (
              <div className="caption-empty">
                <Captions size={25} strokeWidth={1.5} aria-hidden="true" />
                <strong>No captions yet</strong>
                <span>Recognized signs will appear here.</span>
              </div>
            ) : captions.map(caption => (
              <article className="caption-entry" key={`${caption.meetingId}-${caption.sequence}`}>
                <div className="caption-meta">
                  <span>You</span>
                  <time dateTime={caption.occurredAt}>
                    {new Date(caption.occurredAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                  </time>
                </div>
                <p>{caption.payload.text}</p>
                <span className="confidence"><Check size={12} aria-hidden="true" /> {Math.round(caption.payload.confidence * 100)}% confidence</span>
              </article>
            ))}
          </div>

          <div className="privacy-note">
            <LockKeyhole size={15} aria-hidden="true" />
            <span>Raw video is not uploaded in this prototype.</span>
          </div>
        </aside>
      </div>

      <footer className="meeting-footer">
        <span>{meeting ? `Room ${meeting.id.slice(0, 8)}` : "No active room"}</span>
        <button type="button" onClick={startMeeting} disabled={connection === "connecting" || isConnected}>
          {isConnected ? <Check size={17} aria-hidden="true" /> : <Radio size={17} aria-hidden="true" />}
          {isConnected ? "Session active" : connection === "connecting" ? "Connecting..." : "Start session"}
        </button>
      </footer>
    </section>
  );
}