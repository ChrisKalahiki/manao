import { z } from "zod";

/** The JSON `paper-bot picks --json` prints. paper-bot owns it; the hub only checks it. */
export type PicksOutput = z.infer<typeof outputSchema>;

const instant = z.iso.datetime({ offset: true });
const date = z.iso.date();
const outcome = z.enum(["briefing", "skipped", "failed"]);

const pickSchema = z.object({
  id: z.string().min(1),
  title: z.string(),
  url: z.string(),
  date,
  interests: z.array(z.string()),
  wildcard: z.boolean(),
  why: z.string(),
  kept: z.boolean(),
  keptAt: instant.nullable(),
  briefing: z.string(),
});

const outputSchema = z.object({
  scans: z.object({
    daily: z
      .object({
        at: instant,
        date,
        outcome,
        reason: z.string().nullable(),
        sources: z.array(z.object({ name: z.string(), ok: z.boolean(), error: z.string().nullable() })),
      })
      .nullable(),
    weekly: z
      .object({
        at: instant,
        week: z.string(),
        outcome,
        reason: z.string().nullable(),
      })
      .nullable(),
  }),
  keeps: z.object({
    failing: z.array(z.object({ id: z.string(), title: z.string(), error: z.string(), since: instant })),
  }),
  week: z.string(),
  picks: z.array(pickSchema).refine((picks) => new Set(picks.map((pick) => pick.id)).size === picks.length, {
    message: "Pick ids must be distinct",
  }),
});

export function parsePicksOutput(raw: unknown): PicksOutput {
  return outputSchema.parse(raw);
}
