import { z } from "zod";
import { errorMessage } from "./error-message.js";

/** What went wrong running a Source's CLI and reading its JSON; `contract` names the command whose output was checked. */
export function commandErrorMessage(
  error: unknown,
  { command, timeoutMs, contract }: { command: string; timeoutMs: number; contract: string },
): string {
  if (error instanceof SyntaxError) return "unparseable output (not JSON)";
  if (error instanceof z.ZodError) {
    return `output does not match the ${contract} contract: ${z.prettifyError(error)}`;
  }
  if (error instanceof Error) {
    if ("code" in error && error.code === "ENOENT") return `command not found: ${command}`;
    if ("killed" in error && error.killed) return `timed out after ${timeoutMs}ms`;
    if ("code" in error && typeof error.code === "number") {
      const stderr = "stderr" in error && typeof error.stderr === "string" ? error.stderr : "";
      return `exited with code ${error.code}: ${stderr.slice(0, 500)}`;
    }
  }
  return errorMessage(error);
}
