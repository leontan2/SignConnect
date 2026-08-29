import React, { Component, lazy, Suspense, type ErrorInfo, type ReactNode } from "react";
import { Captions, CircleHelp, LockKeyhole, Radio, Settings2 } from "lucide-react";

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
  return (
    <div className="app-shell">
      <a className="skip-link" href="#meeting-workspace">Skip to meeting workspace</a>
      <aside className="workspace-rail" aria-label="Application navigation">
        <a className="brand-symbol" href="/" aria-label="SignConnect home">
          <WaveMark />
        </a>
        <nav className="rail-navigation" aria-label="Workspace navigation">
          <a className="sc-icon-button rail-action active" href="/" aria-current="page" aria-label="Recognition studio">
            <Radio size={19} strokeWidth={1.7} aria-hidden="true" />
          </a>
          <button className="sc-icon-button rail-action" type="button" aria-label="Transcript library" disabled>
            <Captions size={19} strokeWidth={1.7} aria-hidden="true" />
          </button>
          <button className="sc-icon-button rail-action" type="button" aria-label="Workspace settings" disabled>
            <Settings2 size={19} strokeWidth={1.7} aria-hidden="true" />
          </button>
        </nav>
        <div className="rail-footer">
          <button className="sc-icon-button rail-action" type="button" aria-label="Help" disabled>
            <CircleHelp size={19} strokeWidth={1.7} aria-hidden="true" />
          </button>
          <span className="region-mark" aria-label="Singapore region">SG</span>
        </div>
      </aside>

      <div className="workspace-frame">
        <header className="command-header">
          <div className="product-context">
            <span className="brand-name">SignConnect</span>
            <span aria-hidden="true">/</span>
            <strong>Recognition Studio</strong>
          </div>
          <div className="privacy-status" role="note">
            <LockKeyhole size={14} strokeWidth={1.8} aria-hidden="true" />
            Camera processing stays private
          </div>
        </header>

        <main className="main-content" id="meeting-workspace">
          <RemoteBoundary>
            <Suspense fallback={<div className="remote-state">Loading recognition studio…</div>}>
              <MeetingApp />
            </Suspense>
          </RemoteBoundary>
        </main>
      </div>
    </div>
  );
}
