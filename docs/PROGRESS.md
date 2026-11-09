# Progress — slice board

One row per slice (`AGENTS.md` §3). A slice is `done` only when its gate passes, its screenshot is linked, and all
four surfaces exist.

| # | Slice | Gate | Status | Evidence |
|---|---|---|---|---|
| 1 | Boot, auth, health | `pnpm gate:1` | **done** | [health](../artifacts/1/health.png) · [report](../artifacts/1/report.json) |
| 2 | Story → shots | `pnpm gate:2` | **done** | [write](../artifacts/2/write.png) · [plan](../artifacts/2/plan.png) · [report](../artifacts/2/report.json) |
| 3 | A cut you can watch | `pnpm gate:3` | **done** | [cut](../artifacts/3/cut.png) · [report](../artifacts/3/report.json) |
| 4 | Spend with approval | `pnpm gate:4` | **done** | [shoot](../artifacts/4/shoot.png) · [report](../artifacts/4/report.json) |
| 5 | Plan editing | `pnpm gate:5` | **done** | [plan-edit](../artifacts/5/plan-edit.png) · [report](../artifacts/5/report.json) |
| 6 | Previz | `pnpm gate:6` | **next** | — |
| 7 | Collaboration | `pnpm gate:7` | pending | — |
| 8 | Finish & deliver | `pnpm gate:8` | pending | — |
| 9 | Remote review | `pnpm gate:9` | pending | — |
| 10 | Polish | `pnpm gate:10` | pending | — |

## Slice 5 — what it proves

- **The plan is editable from the browser.** A shot's number, framing, angle, movement, duration and description are
  edited in the row itself; a scene's heading, synopsis and body in place above its shots.
- **Editing is a review, and the system says what it broke.** Saving a shot records that it was checked against the
  scene as it stands; editing the scene marks exactly its own shots stale and shows the cause next to each one.
- **Re-check is one click**, and it clears the badge by recording the scene hash the shot was reviewed against — not by
  regenerating anything.
- **No new operations were needed.** `scene.update` and `shot.update` already existed and were reachable from the CLI
  and MCP; this slice was the missing door, which is why it shipped in a fraction of the time the others took.

## Slice 4 — what it proves

- **An estimate is a record, not a message.** `estimate.create` prices each shot against a catalog entry and stores
  the result; nothing is charged.
- **Approval is signed.** `spend.approve` returns a token naming the estimate, its price and an expiry. The token is
  single use and void if the estimate's hash changes, so a plan edited after approval cannot ride the same yes.
- **Spending reserves before rendering.** The reservation lands in `.slate/ledger.jsonl` before the first frame; a
  failed job refunds. Two concurrent submits cannot both pass a ceiling check that neither has decremented.
- **The loop is whole without a key.** The local gateway renders a deterministic clip from the shot's board, so
  drafts cost a fraction ($$0.05/s) and finals cost more ($$0.40/s) — the ladder is visible in the numbers.
- **The browser shows the decision**: `$2.00 of $3.00`, what a batch will cost, and what came back.

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

## Backlog — known gaps

Not future features to invent: things the GUIDE promises, or the product obviously needs, with an honest note on what
already exists. "Operation exists" means it is reachable from the CLI and MCP today; only the browser has no way in.

| Item | Operation | Browser |
|---|---|---|
| **Edit a scene** (heading, synopsis, body) | `scene.update` exists | **missing** |
| **Edit a shot** (number, framing, angle, movement, duration, description) | `shot.update` exists | **missing** |
| Delete a scene or a shot | missing — needs cascade rules for takes and cut items | missing |
| Scene intent note (GUIDE §17 handoff) | missing | missing |
| Coverage plan (GUIDE §7, master plus variants) | missing | missing |
| Project settings after creation (runtime, aspect, budget) | missing — only `project.create` sets them | missing |
| Upload a board from the browser | `frame.attach` takes a server-side path | missing |
| Compare two takes side by side | `take.list` returns both | missing |
| Conform a take into its slot (trim/retime) | `cut.build` uses planned durations | missing |
| B-roll from source footage (import, not generate) | missing | missing |
| Library (cross-project sheets) | missing | last |
| Finish: mix, subtitles, titles, upscale | missing | slice 8 |
| Presence, conflicts, per-user undo | partial: node-scoped `touched` + `expectedRevision` | slice 6 |
| Remote review link | missing | slice 9 |

Editing a scene or a shot is the first thing a director tries to do after the first plan exists, and today it can only
be done by an agent. It is the next slice after spend.

## Notes

- `artifacts/` is committed: screenshots are the evidence that a slice exists.
- The cut is stored inline in `production.json` for now, not in `cut/<id>.json` as `docs/ARCHITECTURE.md` §5.3
  describes. One document means one commit and no cross-file sync; the projections (OTIO/EDL) will be separate files
  when they exist.
