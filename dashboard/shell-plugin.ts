import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import type { Plugin } from "vite";

/** The service worker's entry name; its output is `sw.js` at the root so its scope is `/`. */
export const SW_ENTRY = "sw";
const SW_FILE = "sw.js";
/** The identifier sw/sw.ts reads its Shell from; replaced in the built sw.js. */
const PLACEHOLDER = "__SHELL__";

export interface ShellFile {
  name: string;
  content: string | Uint8Array;
}

/** A short hash over every shell file's name and content, so any change to the build is a new cache. */
export function shellVersion(files: readonly ShellFile[]): string {
  const hash = createHash("sha256");
  for (const file of [...files].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
    hash.update(file.name).update("\0").update(file.content).update("\0");
  }
  return hash.digest("hex").slice(0, 12);
}

function publicFiles(dir: string): ShellFile[] {
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => {
      const file = path.join(entry.parentPath, entry.name);
      return { name: path.relative(dir, file).split(path.sep).join("/"), content: readFileSync(file) };
    });
}

/**
 * Writes the app shell (the page, every emitted asset and the public files) and its version into sw.js,
 * in place of a PWA plugin: the worker precaches exactly what this build produced.
 */
export function shellPlugin(): Plugin {
  let publicDir = "";
  return {
    name: "manao-shell",
    apply: "build",
    // After Vite's own plugins, which emit index.html in their generateBundle.
    enforce: "post",
    configResolved(config) {
      publicDir = config.publicDir;
    },
    generateBundle(_options, bundle) {
      const worker = bundle[SW_FILE];
      if (worker?.type !== "chunk") throw new Error(`The build emitted no ${SW_FILE}`);
      const files: ShellFile[] = [
        ...Object.values(bundle)
          .filter((output) => output.fileName !== SW_FILE && !output.fileName.endsWith(".map"))
          .map((output) => ({ name: output.fileName, content: output.type === "chunk" ? output.code : output.source })),
        ...(publicDir ? publicFiles(publicDir) : []),
      ];
      const shell = {
        version: shellVersion([...files, { name: SW_FILE, content: worker.code }]),
        files: files.map((file) => (file.name === "index.html" ? "/" : `/${file.name}`)).sort(),
      };
      const parts = worker.code.split(PLACEHOLDER);
      if (parts.length !== 2) throw new Error(`${SW_FILE} must read ${PLACEHOLDER} exactly once`);
      worker.code = parts.join(JSON.stringify(shell));
    },
  };
}
