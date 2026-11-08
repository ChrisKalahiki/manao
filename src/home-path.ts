import os from "node:os";

/**
 * `text` with every path under the home directory written `~/...`. Health
 * crosses the tailnet and CLI output lands in logs; neither needs to carry
 * the username.
 */
export function homeRelative(text: string): string {
  const home = os.homedir().replace(/\/+$/, "");
  if (home === "") return text;
  const escaped = home.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return text.replace(new RegExp(`${escaped}(?=/|$|[^\\w.-])`, "g"), "~");
}
