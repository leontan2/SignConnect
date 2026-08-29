import React from "react";
import { createRoot } from "react-dom/client";
import MeetingApp from "./MeetingApp";

const rootElement = document.getElementById("root");

if (!rootElement) {
  throw new Error("Root element was not found");
}

createRoot(rootElement).render(
  <React.StrictMode>
    <MeetingApp />
  </React.StrictMode>
);