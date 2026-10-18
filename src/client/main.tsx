import React from "react";
import { createRoot } from "react-dom/client";
import { LayoutProvider, ThemeProvider } from "@once-ui-system/core";
import "@once-ui-system/core/css/tokens.css";
import "@once-ui-system/core/css/styles.css";
import "./style.css";
import App from "./App.tsx";

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <ThemeProvider theme="system" neutral="slate" brand="blue" accent="cyan">
      <LayoutProvider><App /></LayoutProvider>
    </ThemeProvider>
  </React.StrictMode>,
);
