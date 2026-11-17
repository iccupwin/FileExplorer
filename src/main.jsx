import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App.jsx";
// Wichtig: Hier Tauri API importieren, wenn es irgendwo in der App verwendet wird
import { invoke } from "@tauri-apps/api/core";

// Import CSS in the correct order
// 1. Variables first (design tokens)
import "./styles/variables.css";
// 2. Base/reset styles
import "./styles/global.css";
// 3. Theme styles for light/dark mode
import "./styles/theme.css";
// 4. Component styles
import "./styles/components.css";
// 5. Modern enhancements and effects
import "./styles/modern.css";

// 6. Finder look (loaded last so it wins over component styles)
import "./styles/finder.css";

// Stelle sicher, dass window.invoke verfügbar ist, falls du es global verwendest
window.__TAURI_INVOKE__ = invoke;

// Initialize the application
// Show crashes instead of an empty window
const showFatalError = (error) => {
    const root = document.getElementById("root");
    if (!root) return;
    const message = (error && (error.stack || error.message)) || String(error);
    root.innerHTML = '';
    const box = document.createElement('pre');
    box.style.cssText = 'margin:60px 24px;padding:16px;white-space:pre-wrap;font:12px ui-monospace,Menlo,monospace;color:#ff6b6b;background:rgba(255,0,0,0.06);border-radius:8px;';
    box.textContent = 'Explr crashed:\n\n' + message;
    root.appendChild(box);
};

ReactDOM.createRoot(document.getElementById("root"), {
    onUncaughtError: (error) => showFatalError(error),
}).render(
    <React.StrictMode>
        <App />
    </React.StrictMode>
);