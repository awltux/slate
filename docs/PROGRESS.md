# Progress — slice board

One row per slice (`AGENTS.md` §3). A slice is `done` only when its gate passes and its screenshot is linked.

| # | Slice | Gate | Status | Evidence |
|---|---|---|---|---|
| 1 | Boot, auth, health | `pnpm gate:1` | **in progress** | — |
| 2 | Story → shots | `pnpm gate:2` | pending | — |
| 3 | A cut you can watch | `pnpm gate:3` | pending | — |
| 4 | Spend with approval | `pnpm gate:4` | pending | — |
| 5 | Previz | `pnpm gate:5` | pending | — |
| 6 | Collaboration | `pnpm gate:6` | pending | — |
| 7 | Finish & deliver | `pnpm gate:7` | pending | — |
| 8 | Remote review | `pnpm gate:8` | pending | — |
| 9 | Polish | `pnpm gate:9` | pending | — |

## Now

Slice 1. Foundation being laid:

- [x] repo, toolchain, SDLC contract
- [ ] canonical hashing, ids, result envelope
- [ ] project scaffold + commit log
- [ ] service probes + resolved chains (`slate setup` vendors FFmpeg)
- [ ] HTTP server: auth, sessions, CSRF, signed media
- [ ] UI shell: login, Health, Activity
- [ ] CLI + MCP surfaces for the slice-1 operations
- [ ] `gate:1`, `gate:ui:1`, `gate:headless:1`

## Notes

- Slice-1 acceptance: on a machine with no `ffmpeg` on `PATH`, a new user logs in, creates a project, and sees the
  toolchain status and the resolved assembly chain (`ffmpeg-concat` when OpenShot/`melt` are absent), with the
  reason shown.
- The `lighthouse` fixture project is created in slice 2 and shared by every later gate.
