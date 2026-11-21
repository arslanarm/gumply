import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { initLanguage } from "./i18n/preference.js";
import { restoreUiState } from "./lib/ui-state";
import "./styles.css";

const root = document.getElementById("root");
if (!root) throw new Error("Missing #root element");
const container = root;

// The desktop app's saved preferences go into localStorage before the first
// render (#c7fzzxk8); the browser app has no such route and starts at once.
// The interface language loads next, so no English flashes (#7h5utv23).
void restoreUiState()
  .finally(() => initLanguage())
  .finally(() => {
    createRoot(container).render(
      <StrictMode>
        <App />
      </StrictMode>,
    );
  });
