# Read Todos through Brain-Dump's CLI

Brain-Dump writes the Weekly Notes (it copies the template and files Todos), so it owns their format. manao reads Todos only by running `brain-dump todos` and parsing its JSON: it never parses the vault itself, so the format is defined in one place, and it never imports Brain-Dump's source, because Brain-Dump runs on bun (and uses Bun APIs) while manao runs on Node. A process boundary with a JSON contract is how manao already treats Herdr.

## Considered Options

- **A manao parser with the note convention in config.** Shareable without Brain-Dump, but two definitions of one format that drift the first time it changes.
- **Importing Brain-Dump's TypeScript.** One parser, but couples two repos across runtimes; a Bun API used there would break the hub only at runtime.

## Consequences

The Source is `brain-dump`, not `obsidian`; someone without Brain-Dump leaves it disabled. A change to the Todo shape is a change to Brain-Dump's `todos` output first.
