import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { bootstrapAppearance } from "./appearance";
import "./styles.css";

const root = document.getElementById("root");
if (!root) throw new Error("Renderer root element is missing");

// Apply the cached theme before the first paint so a dark window never flashes light.
bootstrapAppearance();

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
