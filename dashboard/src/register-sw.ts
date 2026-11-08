interface ServiceWorkerHost {
  serviceWorker?: { register(url: string, options: RegistrationOptions): Promise<unknown> };
}

/** Installs the shell worker (dashboard/sw); browsers only offer it over HTTPS or on localhost. */
export async function registerServiceWorker(host: ServiceWorkerHost = navigator): Promise<void> {
  if (!host.serviceWorker) return;
  try {
    await host.serviceWorker.register("/sw.js", { scope: "/" });
  } catch (err) {
    // The page works without it; it only loses the instant, offline-capable shell.
    console.warn("The service worker did not register", err);
  }
}
