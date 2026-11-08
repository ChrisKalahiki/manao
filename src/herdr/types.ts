import { z } from "zod";

/** The herdr-core protocol generation this package speaks (`hc` 0.1.16). */
export const PROTOCOL_GENERATION = 1;

/**
 * A terminal as `terminal.list` reports it, narrowed to what the hub keeps.
 * Parsing strips everything else, so `argv`, `foreground` (command lines) and
 * `records` never get past the client.
 */
export type Terminal = z.infer<typeof terminalSchema>;

/** The program's own OSC 7501 report: `state` is idle, working, done, blocked or error. */
export type TerminalStatus = z.infer<typeof statusSchema>;

const statusSchema = z.object({
  state: z.string(),
  app: z.string().optional(),
  msg: z.string().optional(),
  kind: z.string().nullish(),
  progress: z.number().nullish(),
});

const terminalSchema = z.object({
  address: z.string().min(1),
  state: z.string(),
  cwd: z.string(),
  labels: z.record(z.string(), z.string()),
  name: z.string().nullish(),
  title: z.string().optional(),
  status: statusSchema.nullish(),
  status_ms: z.number().nullish(),
  turn: z.number().optional(),
});

const listSchema = z.object({ terminals: z.array(terminalSchema) });

export function parseTerminalList(raw: unknown): Terminal[] {
  return listSchema.parse(raw).terminals;
}

export interface HelloResult {
  generation: number;
  version: string;
  core: { id: string; name: string };
}
