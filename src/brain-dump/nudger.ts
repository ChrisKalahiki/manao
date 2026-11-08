import { type FSWatcher, type WatchListener, existsSync, watch } from "node:fs";
import path from "node:path";
import { errorMessage } from "../error-message.js";
import { watchUnavailable } from "./command.js";

interface FolderNudgerOptions {
  onNudge: () => void;
  debounceMs?: number;
  watch?: (folder: string, options: { recursive: false }, listener: WatchListener<string>) => FSWatcher;
}

export class FolderNudger {
  private watcher: FSWatcher | null = null;
  private folder: string | null = null;
  private stopped = false;
  private debounceTimer: NodeJS.Timeout | null = null;
  private watchProblem: string | undefined;
  private readonly debounceMs: number;

  constructor(private readonly opts: FolderNudgerOptions) {
    this.debounceMs = opts.debounceMs ?? 2000;
  }

  get problem(): string | undefined {
    return this.watchProblem;
  }

  watch(folder: string): void {
    if (this.stopped || this.folder === folder) return;
    this.closeWatch();
    try {
      const watcher = (this.opts.watch ?? watch)(folder, { recursive: false }, (event, filename) => {
        if (this.stopped || this.watcher !== watcher) return;
        if ((event === "rename" && filename === path.basename(folder)) || !existsSync(folder)) {
          this.closeWatch();
          this.watchProblem = watchUnavailable(`${folder}: folder was removed or renamed`);
        }
        this.nudge();
      });
      this.watcher = watcher;
      this.folder = folder;
      this.watchProblem = undefined;
      watcher.on("error", (error: unknown) => {
        if (this.watcher !== watcher) return;
        this.closeWatch();
        this.watchProblem = watchUnavailable(`${folder}: ${errorMessage(error)}`);
      });
    } catch (error) {
      this.watchProblem = watchUnavailable(`${folder}: ${errorMessage(error)}`);
    }
  }

  stop(): void {
    this.stopped = true;
    this.closeWatch();
  }

  private nudge(): void {
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null;
      this.opts.onNudge();
    }, this.debounceMs);
  }

  private closeWatch(): void {
    this.watcher?.close();
    this.watcher = null;
    this.folder = null;
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = null;
  }
}
