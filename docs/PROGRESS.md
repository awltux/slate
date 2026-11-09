# Progress — slice board

One row per slice (`AGENTS.md` §3). A slice is `done` only when its gate passes, its screenshot is linked, and all
four surfaces exist.

| # | Slice | Gate | Status | Evidence |
|---|---|---|---|---|
| 1 | Boot, auth, health | `pnpm gate:1` | **done** | [health](../artifacts/1/health.png) · [report](../artifacts/1/report.json) |
| 2 | Story → shots | `pnpm gate:2` | **in progress** — operations, CLI, UI and gate pass; MCP surface outstanding | [write](../artifacts/2/write.png) · [plan](../artifacts/2/plan.png) · [report](../artifacts/2/report.json) |
| 3 | A cut you can watch | `pnpm gate:3` | pending | — |
| 4 | Spend with approval | `pnpm gate:4` | pending | — |
| 5 | Previz | `pnpm gate:5` | pending | — |
| 6 | Collaboration | `pnpm gate:6` | pending | — |
| 7 | Finish & deliver | `pnpm gate:7` | pending | — |
| 8 | Remote review | `pnpm gate:8` | pending | — |
| 9 | Polish | `pnpm gate:9` | pending | — |

## Slice 2 — what it proves

- **The five lines are a document, not a prompt.** Each save keeps a revision with author, time and note, and the
  page names which lines are still missing.
- **A scene becomes a shot list.** Scene numbering is assigned, never reused; shots carry framing, angle, movement,
  duration and a description.
- **Readiness is data.** `shot.create` returns five named checks — scene-linked, described, duration, number-unique,
  story — with pass/warn/fail, so the agent can say *what* is missing instead of disabling a button.
- **Staleness is derived, and scoped.** Editing scene 1 marks its two shots stale and leaves scene 2 alone; the
  envelope reports `stale.added`, and `shot.rebase` reports `stale.cleared`.
- **One revision clock.** Project and production documents share a revision and a commit id; a write against a stale
  revision is a `conflict`, never an overwrite.
- **The same plan is reachable without a browser**: `slate op story.set … --root …` with `SLATE_HEADLESS=1`.

## Outstanding for slice 2

- **MCP surface.** `src/surfaces/mcp.ts` does not exist yet, so an agent can only reach Slate through HTTP or the
  CLI. The registry already generates schemas, so the work is a transport plus a naming rule
  (`story.set` → `story_set`, exposed by DSH as `mcp__slate__story_set`).
- `docs/OP-REGISTRY.md` is not generated yet; it should be produced from the registry, not hand-written.

## Notes

- `artifacts/` is committed: screenshots are the evidence that a slice exists.
- The `lighthouse` fixture project is created in slice 2 and shared by every later gate.
