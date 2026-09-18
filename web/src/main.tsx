import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { loadAuthConfig } from "./auth";
import "./styles.css";

const root = document.getElementById("root");
if (!root) throw new Error("#root missing");

loadAuthConfig().then(
  () =>
    createRoot(root).render(
      <StrictMode>
        <App />
      </StrictMode>,
    ),
  (e: unknown) => {
    console.error(e);
    root.textContent = "POP HQ could not load its settings. Please reload the page.";
  },
);
