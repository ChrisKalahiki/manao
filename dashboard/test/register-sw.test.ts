import { describe, expect, it, vi } from "vitest";
import { registerServiceWorker } from "../src/register-sw.js";

describe("Service worker registration", () => {
  it("registers /sw.js for the whole dashboard", async () => {
    const register = vi.fn(async () => ({}));

    await registerServiceWorker({ serviceWorker: { register } });

    expect(register).toHaveBeenCalledWith("/sw.js", { scope: "/" });
  });

  it("does nothing where service workers are unavailable (plain HTTP on another device)", async () => {
    await expect(registerServiceWorker({})).resolves.toBeUndefined();
  });

  it("reports a failed registration without breaking the page", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const failure = new Error("SecurityError");

    await registerServiceWorker({ serviceWorker: { register: async () => Promise.reject(failure) } });

    expect(warn).toHaveBeenCalledWith(expect.stringContaining("service worker"), failure);
    warn.mockRestore();
  });
});
