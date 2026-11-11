# ADR 0004 — Capabilities are a table, and `image` became `text-to-image`

## Context

The capability list was a zod enum in `declaration.ts` and a second array in `Setup.tsx`. `image` covered both
text-to-image and (later) image-to-image, and adding either a capability or a provider meant editing several files and a
stored format. A host configured before a rename must not lose its providers either: `readAiConfig` falls back to an
empty catalogue when the stored file fails to parse.

## Decision

- Capabilities live in **one table** (`src/kernel/ai/capabilities.ts`): `id`, `label`, `paid`, `requires`, `produces`,
  `modes`. Every operation and the interface read it.
- **`image` is renamed `text-to-image`.** `image-to-image` is a separate capability and is not declared yet.
- The stored schema accepts **legacy spellings**; `readAiConfig` normalises them (`image` → `text-to-image`) for endpoint
  capabilities and binding-set keys, and the save operations normalise on write. The schema deliberately keeps the old
  name so an older file parses instead of silently coming back empty.
- `modes: ("sync" | "queue")[]` is part of the table, so an asynchronous provider is the same concept rather than a
  second one.

## Consequences

- Adding a capability is a table row plus the code that uses it; adding a provider is data, and (per the preset plan) a
  row in the preset table.
- Old configurations keep working, and are rewritten in the new spelling the next time they are saved.
- `ai.catalog` returns capability **specs**, so `Setup` cannot drift from what the operations accept.
- Anything that asked for `"image"` must ask for `"text-to-image"`; the alias covers stored data and inbound calls, not
  internal code.

## Alternatives

- **Silent migration without the legacy schema member** — rejected: a parse failure empties the catalogue, which is a data
  loss that looks like a fresh install.
- **Per-provider adapters instead of a table** — rejected: it reintroduces the code change per provider that the
  declaration model exists to avoid.
