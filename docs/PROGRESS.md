# Progress — slice board

One row per slice (`AGENTS.md` §3). A slice is `done` only when its gate passes and its screenshot is linked.

| # | Slice | Gate | Status | Evidence |
|---|---|---|---|---|
| 1 | Boot, auth, health | `pnpm gate:1` | **done** | [health](../artifacts/1/health.png) · [projects](../artifacts/1/projects.png) · [report](../artifacts/1/report.json) |
| 2 | Story → shots | `pnpm gate:2` | **next** | — |
| 3 | A cut you can watch | `pnpm gate:3` | pending | — |
| 4 | Spend with approval | `pnpm gate:4` | pending | — |
| 5 | Previz | `pnpm gate:5` | pending | — |
| 6 | Collaboration | `pnpm gate:6` | pending | — |
| 7 | Finish & deliver | `pnpm gate:7` | pending | — |
| 8 | Remote review | `pnpm gate:8` | pending | — |
| 9 | Polish | `pnpm gate:9` | pending | — |

## Slice 1 — what it proves

- A host-level owner account, a signed session cookie, CSRF on every mutation, and role-based refusal of writes.
- A project folder created from the browser: `project.json`, the media/story/work directories, and a genesis
  commit.
- The toolchain probe, resolved into four stage chains with a reason per stage. On this host FFmpeg is found at a
  known install location even though it is not on `PATH`, and the UI says plainly that assembly will be
  "hard cuts only".
- The same operations through the CLI with `SLATE_HEADLESS=1` — no daemon, no HTTP.
- No host path in any operation result (asserted by the gate).

## Slice 2 — next

Story → shot list, in the browser: five lines, a Fountain screenplay with anchored patches, scenes and shots, and
readiness returned as named checks. First write operations beyond project creation, so this is where the touched-set
and conflict rules get exercised.

## Notes

- `artifacts/` is committed: screenshots are the evidence that a slice exists.
- The `lighthouse` fixture project is created in slice 2 and shared by every later gate.
