import React, { Component, lazy, Suspense, useState, type ErrorInfo, type MouseEvent, type ReactNode } from "react";
import { Captions, CircleHelp, LockKeyhole, Settings2, Users } from "lucide-react";

const MeetingApp = lazy(() => import("meeting/MeetingApp"));

function WaveMark() {
  return (
    <svg viewBox="0 0 46 32" aria-hidden="true">
      <path
        d="M2 17.5c5.1 0 5.1-10.5 10.2-10.5s5.1 18 10.2 18S27.5 3 32.6 3s5.1 14.5 10.2 14.5"
        fill="none"
        stroke="currentColor"
        strokeLinecap="round"
        strokeWidth="4.5"
      />
    </svg>
  );
}

type RemoteBoundaryProps = {
  children: ReactNode;
};

type RemoteBoundaryState = {
  failed: boolean;
};

class RemoteBoundary extends Component<RemoteBoundaryProps, RemoteBoundaryState> {
  state: RemoteBoundaryState = { failed: false };

  static getDerivedStateFromError(): RemoteBoundaryState {
    return { failed: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("Meeting micro-frontend failed to load", error, info);
  }

  render() {
    if (this.state.failed) {
      return (
        <div className="remote-state" role="alert">
          <strong>Meeting workspace unavailable</strong>
          <span>Confirm the meeting remote is running on port 3001, then refresh this page.</span>
        </div>
      );
    }

    return this.props.children;
  }
}

export function App() {
  const [activeSection, setActiveSection] = useState("meeting-room");
  const sectionTitles: Record<string, string> = {
    "meeting-room": "Meeting room",
    "live-transcript": "Live Transcript",
    "room-participants": "Room Participants",
    "recognition-status": "Recognition Status",
    "workspace-help": "Recognition Help"
  };

  function navigateToSection(event: MouseEvent<HTMLAnchorElement>, sectionId: string, activeId = sectionId) {
    event.preventDefault();
    setActiveSection(activeId);
    window.history.replaceState(null, "", `#${sectionId}`);
    window.requestAnimationFrame(() => {
      const section = document.getElementById(sectionId);
      section?.scrollIntoView({ behavior: "smooth", block: "start" });
      section?.focus({ preventScroll: true });
    });
  }

  return (
    <div className="app-shell">
      <a className="skip-link" href="#meeting-workspace">Skip to meeting workspace</a>
      <aside className="workspace-rail" aria-label="Application navigation">
        <a
          className="brand-symbol"
          href="#meeting-workspace"
          aria-label="SignConnect home"
          onClick={(event) => navigateToSection(event, "meeting-workspace", "meeting-room")}
        >
          <WaveMark />
        </a>
        <nav className="rail-navigation" aria-label="Workspace navigation">
          <a
            className={`sc-icon-button rail-action${activeSection === "live-transcript" ? " active" : ""}`}
            href="#live-transcript"
            aria-current={activeSection === "live-transcript" ? "location" : undefined}
            aria-label="Live transcript"
            title="Live transcript"
            onClick={(event) => navigateToSection(event, "live-transcript")}
          >
            <Captions size={19} strokeWidth={1.7} aria-hidden="true" />
          </a>
          <a
            className={`sc-icon-button rail-action${activeSection === "room-participants" ? " active" : ""}`}
            href="#room-participants"
            aria-current={activeSection === "room-participants" ? "location" : undefined}
            aria-label="Room participants"
            title="Room participants"
            onClick={(event) => navigateToSection(event, "room-participants")}
          >
            <Users size={19} strokeWidth={1.7} aria-hidden="true" />
          </a>
          <a
            className={`sc-icon-button rail-action${activeSection === "recognition-status" ? " active" : ""}`}
            href="#recognition-status"
            aria-current={activeSection === "recognition-status" ? "location" : undefined}
            aria-label="Recognition status"
            title="Recognition status"
            onClick={(event) => navigateToSection(event, "recognition-status")}
          >
            <Settings2 size={19} strokeWidth={1.7} aria-hidden="true" />
          </a>
        </nav>
        <div className="rail-footer">
          <a
            className={`sc-icon-button rail-action${activeSection === "workspace-help" ? " active" : ""}`}
            href="#workspace-help"
            aria-current={activeSection === "workspace-help" ? "location" : undefined}
            aria-label="Recognition help"
            title="Recognition help"
            onClick={(event) => navigateToSection(event, "workspace-help")}
          >
            <CircleHelp size={19} strokeWidth={1.7} aria-hidden="true" />
          </a>
          <span className="region-mark" aria-label="Singapore region">SG</span>
        </div>
      </aside>

      <div className="workspace-frame">
        <header className="command-header">
          <div className="product-context">
            <span className="brand-name">SignConnect</span>
            <span aria-hidden="true">/</span>
            <strong>{sectionTitles[activeSection]}</strong>
          </div>
          <div className="privacy-status" role="note">
            <LockKeyhole size={14} strokeWidth={1.8} aria-hidden="true" />
            Camera processing stays private
          </div>
        </header>

        <main className="main-content" id="meeting-workspace">
          <RemoteBoundary>
            <Suspense fallback={<div className="remote-state">Loading meeting room…</div>}>
              <MeetingApp />
            </Suspense>
          </RemoteBoundary>
        </main>
      </div>
    </div>
  );
}
