import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";

import { App } from "./app.js";
import "./styles.css";
import "./console-redesign.css";

const root = document.getElementById("root");
if (root === null) {
  throw new Error("Application root is missing");
}

createRoot(root).render(
  <StrictMode>
    <BrowserRouter>
      <App initialMode={window.location.search.includes("demo=1") ? "demo" : "live"} />
    </BrowserRouter>
  </StrictMode>,
);
