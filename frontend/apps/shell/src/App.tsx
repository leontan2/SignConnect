import React, { Component, lazy, Suspense, type ErrorInfo, type ReactNode } from "react";
import { Captions, Languages, LayoutDashboard, Radio, Settings } from "lucide-react";

const MeetingApp = lazy(() => import("meeting/MeetingApp"));

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

const navigation = [
  { label: "Live meeting", icon: Radio, active: true },
  { label: "Transcripts", icon: Captions, active: false },
  { label: "Vocabulary", icon: Languages, active: false },
  { label: "Settings", icon: Settings, active: false }
];

export function App() {
  return (
    <div className="app-shell">
      <header className="topbar">
        <a className="brand" href="/" aria-label="SignConnect home">
          <span className="brand-mark" aria-hidden="true">SC</span>
          <span>SignConnect</span>
        </a>
        <div className="topbar-context">
          <span className="environment-dot" aria-hidden="true" />
          Prototype environment
        </div>
        <button className="avatar" type="button" title="Open account menu" aria-label="Open account menu">
          LT
        </button>
      </header>

      <aside className="sidebar" aria-label="Primary navigation">
        <div className="workspace-label">
          <LayoutDashboard size={15} aria-hidden="true" />
          Workspace
        </div>
        <nav>
          {navigation.map(({ label, icon: Icon, active }) => (
            <button
              className={active ? "nav-item active" : "nav-item"}
              type="button"
              aria-current={active ? "page" : undefined}
              disabled={!active}
              key={label}
            >
              <Icon size={18} strokeWidth={1.8} aria-hidden="true" />
              <span>{label}</span>
            </button>
          ))}
        </nav>
        <div className="sidebar-foot">
          <span>SGSL pilot</span>
          <strong>Education pack</strong>
        </div>
      </aside>

      <main className="main-content">
        <RemoteBoundary>
          <Suspense fallback={<div className="remote-state">Loading meeting workspace...</div>}>
            <MeetingApp />
          </Suspense>
        </RemoteBoundary>
      </main>
    </div>
  );
}