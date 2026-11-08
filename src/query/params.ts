import * as z from "zod";

/** A bad parameter: a 400 from the API, an error result from an MCP tool. The message names the parameter. */
export class ParamError extends Error {
  override name = "ParamError";
}

/**
 * One parameter's rule, read from either transport: a query-string value
 * for the API, or a JSON argument for an MCP tool. Both apply the same
 * limits and say the same thing when a value breaks them.
 */
export interface Param<T> {
  /** Turns the raw query-string value into `T`, or throws a ParamError naming `name`. */
  fromText(raw: string, name: string): T;
  /** Accepts the JSON argument and yields `T`; its messages leave the name out, as the SDK prefixes the path. */
  readonly schema: z.ZodType<T, unknown>;
}

export type ParamSpec = Record<string, Param<unknown>>;

export type Params<S extends ParamSpec> = { [K in keyof S]?: S[K] extends Param<infer T> ? T : never };

function unknownParam(name: string, spec: ParamSpec): string {
  const known = Object.keys(spec);
  return `${name} is not a known parameter (expected ${known.length ? `one of: ${known.join(", ")}` : "none"})`;
}

/**
 * Reads `query` against a route's parameters. Anything not in `spec`, given
 * twice or malformed is a ParamError, so a typo never silently matches everything.
 */
export function readParams<S extends ParamSpec>(query: URLSearchParams, spec: S): Params<S> {
  const params: Record<string, unknown> = {};
  for (const name of new Set(query.keys())) {
    const param = Object.hasOwn(spec, name) ? spec[name] : undefined;
    if (!param) throw new ParamError(unknownParam(name, spec));
    const [value, ...more] = query.getAll(name);
    if (more.length > 0) throw new ParamError(`${name} is given more than once`);
    params[name] = param.fromText(value, name);
  }
  return params as Params<S>;
}

/** A tool's input schema: every parameter optional, anything not in `spec` refused by name. */
export function paramsSchema<S extends ParamSpec>(spec: S) {
  // Object.fromEntries loses the keys, so zod infers Record<string, unknown>. The
  // cast restores them: the shape has exactly spec's keys, each the optional
  // form of that Param's schema, which is what Params<S> spells out.
  const shape = Object.fromEntries(Object.entries(spec).map(([name, param]) => [name, param.schema.optional()]));
  return z.strictObject(shape, {
    error: (issue) =>
      issue.code === "unrecognized_keys" ? issue.keys.map((name) => unknownParam(name, spec)).join("; ") : undefined,
  }) as z.ZodType<Params<S>, unknown>;
}

const NOT_EMPTY = "must not be empty";

export const text: Param<string> = {
  fromText: (raw, name) => {
    if (raw === "") throw new ParamError(`${name} ${NOT_EMPTY}`);
    return raw;
  },
  schema: z.string({ error: "must be a string" }).min(1, NOT_EMPTY),
};

const TRUE_OR_FALSE = "must be true or false";

export const boolean: Param<boolean> = {
  fromText: (raw, name) => {
    if (raw === "true") return true;
    if (raw === "false") return false;
    throw new ParamError(`${name} ${TRUE_OR_FALSE}`);
  },
  schema: z.boolean({ error: TRUE_OR_FALSE }),
};

/** A whole number from `min` to `max`; as text, written in plain digits. */
export function integer(min: number, max = Number.MAX_SAFE_INTEGER): Param<number> {
  const rule = `must be an integer ${max === Number.MAX_SAFE_INTEGER ? `${min} or more` : `from ${min} to ${max}`}`;
  return {
    fromText: (raw, name) => {
      const value = /^\d+$/.test(raw) ? Number(raw) : Number.NaN;
      if (!(value >= min && value <= max)) throw new ParamError(`${name} ${rule}`);
      return value;
    },
    schema: z.int({ error: rule }).min(min, rule).max(max, rule),
  };
}

/** One of `values`, as given. */
export function oneOf<T extends string>(values: readonly [T, ...T[]]): Param<T> {
  const rule = `must be one of: ${values.join(", ")}`;
  return {
    fromText: (raw, name) => {
      if (!values.includes(raw as T)) throw new ParamError(`${name} ${rule}`);
      return raw as T;
    },
    schema: z.enum(values, { error: rule }),
  };
}

const ISO_DATE_RULE = "must be a date, e.g. 2026-10-19";

/** A real calendar date, written `YYYY-MM-DD`. */
function isIsoDate(raw: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) return false;
  // Date rolls 2026-02-30 over into March, so only a date that reads back the same is real.
  const day = new Date(`${raw}T00:00:00Z`);
  return !Number.isNaN(day.getTime()) && day.toISOString().startsWith(raw);
}

/** A calendar date such as a Measurement's, `YYYY-MM-DD`, with no time or zone: the day as the hub counts it. */
export const isoDate: Param<string> = {
  fromText: (raw, name) => {
    if (!isIsoDate(raw)) throw new ParamError(`${name} ${ISO_DATE_RULE}`);
    return raw;
  },
  schema: z.string({ error: ISO_DATE_RULE }).refine(isIsoDate, ISO_DATE_RULE),
};

const ISO_TIME = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2}))?$/;
const ISO_TIME_RULE = "must be an ISO 8601 time, e.g. 2026-10-19T08:00:00Z";

function parseIsoTime(raw: string): Date | undefined {
  const time = new Date(raw);
  return ISO_TIME.test(raw) && !Number.isNaN(time.getTime()) ? time : undefined;
}

/**
 * An ISO 8601 date, or a date and time with `Z` or an offset, so its meaning
 * never depends on the hub's time zone. A plain date is midnight UTC.
 */
export const isoTime: Param<Date> = {
  fromText: (raw, name) => {
    const time = parseIsoTime(raw);
    if (!time) throw new ParamError(`${name} ${ISO_TIME_RULE}`);
    return time;
  },
  schema: z
    .string({ error: ISO_TIME_RULE })
    .refine((raw) => parseIsoTime(raw) !== undefined, ISO_TIME_RULE)
    .transform((raw) => new Date(raw)),
};
