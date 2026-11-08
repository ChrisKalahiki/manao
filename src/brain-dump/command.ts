import path from "node:path";

export function weeklyNoteFolder(vaultRoot: string, note: string): string {
  return path.dirname(path.join(vaultRoot, note));
}

export function watchUnavailable(reason: string): string {
  return `folder watch unavailable; polling continues: ${reason}`;
}
