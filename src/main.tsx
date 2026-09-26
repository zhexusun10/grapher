import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "@xyflow/react/dist/style.css";
import "./tokens.css";
// Preserve legacy cascade order while keeping feature styles in separate files.
import "./styles.css";
import "./styles-workbench.css";
import "./styles-planning.css";

ReactDOM.createRoot(document.getElementById("root")!).render(<App />);
