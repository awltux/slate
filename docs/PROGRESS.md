# Progress — slice board

One row per slice (`AGENTS.md` §3). A slice is `done` only when its gate passes, its screenshot is linked, and all
four surfaces exist.

| # | Slice | Gate | Status | Evidence |
|---|---|---|---|---|
| 1 | Boot, auth, health | `pnpm gate:1` | **done** | [health](../artifacts/1/health.png) · [report](../artifacts/1/report.json) |
| 2 | Story → shots | `pnpm gate:2` | **done** | [write](../artifacts/2/write.png) · [plan](../artifacts/2/plan.png) · [report](../artifacts/2/report.json) |
| 3 | A cut you can watch | `pnpm gate:3` | **done** | [cut](../artifacts/3/cut.png) · [report](../artifacts/3/report.json) |
| 4 | Spend with approval | `pnpm gate:4` | **next** | — |
| 5 | Previz | `pnpm gate:5` | pending | — |
| 6 | Collaboration | `pnpm gate:6` | pending | — |
| 7 | Finish & deliver | `pnpm gate:7` | pending | — |
| 8 | Remote review | `pnpm gate:8` | pending | — |
| 9 | Polish | `pnpm gate:9` | pending | — |

## Slice 3 — what it proves

- **A frame becomes an asset.** Attaching a board copies it into the project under a content hash; the document
  records the asset, never the path it came from.
- **The cut is a selection list.** Shot, frame, duration — in scene order. Building it is one commit; rendering
  references it, so a re-cut does not lose the take that was chosen.
- **It plays.** FFmpeg renders the selections to MP4 (exact durations, pinned by a gate assertion), the render is
  ingested as an asset, and the browser plays it from `/p/:id/media/:assetId` with range support — but only for a
  signed-in caller.
- **Host paths are privileged.** The owner sees where each tool was found (hover over the name on Health); a reviewer
  receives `null` and no path anywhere in the payload.
- **Rename is a commit.** The project name lives in the document, so changing it is versioned, attributable, and
  visible to every surface at once.

## Slice 2 — what it proved

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
- **All four surfaces.** MCP serves the registry over stdio, and `docs/OP-REGISTRY.md` is generated and checked.

## Notes

- `artifacts/` is committed: screenshots are the evidence that a slice exists.
- The cut is stored inline in `production.json` for now, not in `cut/<id>.json` as `docs/ARCHITECTURE.md` §5.3
  describes. One document means one commit and no cross-file sync; the projections (OTIO/EDL) will be separate files
  when they exist.
