import { createRoot } from "react-dom/client";
import App from "./App";
import { bootstrapAppearance } from "./appearance";
import "./styles.css";

const root = document.getElementById("root");
if (!root) throw new Error("Renderer root element is missing");

// Apply the cached theme before the first paint so a dark window never flashes light.
bootstrapAppearance();

// This shell is normally run from source during long editing sessions. React's
// development StrictMode double-renders the heavy canvas editors, which made tab
// switches visibly stall; production had no second render anyway.
createRoot(root).render(<App />);
