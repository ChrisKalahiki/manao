import { render } from "preact";
import { App } from "./app.js";
import { registerServiceWorker } from "./register-sw.js";

const root = document.getElementById("app");
if (!root) throw new Error("index.html has no #app element");
render(<App />, root);

// Vite's dev server has no sw.js; only the built dashboard installs one.
if (import.meta.env.PROD) void registerServiceWorker();
