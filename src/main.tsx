import ReactDOM from "react-dom/client";
import App from "./App";
import { locale } from "./i18n";
import { installDesktopExternalLinkHandler } from "./services/externalLink";
import "@xyflow/react/dist/style.css";
import "katex/dist/katex.min.css";
import "./tailwind.css";
import "./tokens.css";
// Preserve cascade order while keeping feature styles in separate files.
import "./styles.css";
import "./styles-workbench.css";
import "./styles-planning.css";

document.documentElement.lang = locale;
installDesktopExternalLinkHandler();
ReactDOM.createRoot(document.getElementById("root")!).render(<App />);
