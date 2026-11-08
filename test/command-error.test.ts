import { describe, expect, it } from "vitest";
import { z } from "zod";
import { commandErrorMessage } from "../src/command-error.js";

const read = { command: "custom-cli", timeoutMs: 500, contract: "custom-cli todos" };

describe("command read errors", () => {
  it.each([
    [Object.assign(new Error("spawn failed"), { code: "ENOENT" }), "command not found: custom-cli"],
    [Object.assign(new Error("failed"), { code: 7, stderr: "vault unavailable" }), "exited with code 7: vault unavailable"],
    [Object.assign(new Error("killed"), { killed: true, code: null }), "timed out after 500ms"],
    [new SyntaxError("Unexpected token"), "unparseable output (not JSON)"],
  ])("names the cause of %s", (error, expected) => {
    expect(commandErrorMessage(error, read)).toBe(expected);
  });

  it("limits stderr to its first 500 characters", () => {
    const error = Object.assign(new Error("failed"), { code: 3, stderr: `${"x".repeat(500)}omitted` });
    expect(commandErrorMessage(error, read)).toBe(`exited with code 3: ${"x".repeat(500)}`);
  });

  it("includes a zod summary for contract mismatches, naming the contract", () => {
    const result = z.object({ note: z.string() }).safeParse({ note: null });
    if (result.success) throw new Error("expected invalid fixture");
    expect(commandErrorMessage(result.error, read)).toBe(
      "output does not match the custom-cli todos contract: ✖ Invalid input: expected string, received null\n  → at note",
    );
  });
});
