import { type Shell, shellWorker } from "./shell.js";

declare const self: ServiceWorkerGlobalScope;
/** Written in by the build (shell-plugin.ts): this build's version and files. */
declare const __SHELL__: Shell;

const worker = shellWorker(__SHELL__, { caches, fetch: (request) => fetch(request), origin: self.location.origin });

// A rebuilt shell takes over at once rather than waiting for every open tab to close.
self.addEventListener("install", (event) => event.waitUntil(worker.install().then(() => self.skipWaiting())));
self.addEventListener("activate", (event) => event.waitUntil(worker.activate().then(() => self.clients.claim())));
self.addEventListener("fetch", (event) => {
  const response = worker.respond(event.request);
  if (response) event.respondWith(response);
});
