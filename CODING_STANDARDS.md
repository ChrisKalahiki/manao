# Coding standards

Read during review. `bun run check` (typecheck, Biome, vitest) already enforces everything mechanical; these are the judgement calls it cannot make.

- **The package exports an API, not internals.** `src/index.ts` exports what consumers call (`openStore`, the query and result types, the hub and config entry points). Each store part's helpers (`eventPruner`, `healthSourceRows`, the `*Part` factories) stay module-private. `test/exports.test.ts` pins the list: a change to it needs a reason in the PR.
