import os from "node:os";
import path from "node:path";

/** `MANAO_CONFIG`, else `$XDG_CONFIG_HOME/manao/config.json` (default `~/.config`). */
export function resolveConfigPath(env: NodeJS.ProcessEnv = process.env): string {
  if (env.MANAO_CONFIG) return env.MANAO_CONFIG;
  const configHome = env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config");
  return path.join(configHome, "manao", "config.json");
}

/** Where `manao auth google` writes the token: `$XDG_DATA_HOME/manao/google-token.json` (default `~/.local/share`). */
export function resolveGoogleTokenPath(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(dataHome(env), "manao", "google-token.json");
}

/** `MANAO_DB`, else the config's `dbPath`, else `$XDG_DATA_HOME/manao/hub.db` (default `~/.local/share`). */
export function resolveDbPath(env: NodeJS.ProcessEnv = process.env, config: { dbPath?: string } = {}): string {
  if (env.MANAO_DB) return env.MANAO_DB;
  if (config.dbPath) return config.dbPath;
  return path.join(dataHome(env), "manao", "hub.db");
}

function dataHome(env: NodeJS.ProcessEnv): string {
  return env.XDG_DATA_HOME || path.join(os.homedir(), ".local", "share");
}
