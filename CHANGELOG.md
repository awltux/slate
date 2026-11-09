# Changelog

User-visible changes per slice. Internal refactors are not listed.

## Slice 8 — working together

- **See who else is in the room.** Presence shows the other people on a project — a chip beside the title naming who else
  is looking, expiring on its own. It is a notice, never a lock.
- **Two people cannot silently overwrite each other.** A write carries the revision it was based on; if someone else
  wrote first, the second is refused with `conflict` and the Plan page says "changed underneath you" with a reload
  instead of clobbering the other person's work.
- **Undo your own last change.** The newest commit can be undone by whoever made it (or an owner), restoring the state
  before it. Buried commits are refused: undoing one would discard other people's later work.

## Slice 7 — the library: entities and sheets

- **Characters, locations and props are defined once.** An entity is created in the library; its sheet is published
  as a new version from a set of view images (front, three-quarter, close-up, costume, lighting, …), with a height in
  metres and a licence.
- **Versions, not edits.** Publishing v2 never changes what v1 meant. A shot pins the versions it was conditioned on,
  so a new sheet marks exactly the shots pinned to the old one stale — with the cause `The keeper sheet v1 → v2`.
- **Consent is a gate, not a note.** A character sheet defaults to *pending*; the readiness check fails until it is
  granted, which blocks the expensive tier rather than the cheap one.
- **Readiness now covers the face**: entities listed, a sheet published for each, three views including a close-up,
  and consent settled. Re-checking a shot re-pins its entities, so the badge can clear.

## Slice 6 — previz

- **Attach a digital set.** A Blender manifest is validated — units, frame rate, frame range, which object plays which
  entity, and each camera's lens, height and keys — and stored with the `.blend` as an asset. Slate consumes the
  agent's work; it does not attempt to model.
- **Attach a blockout for a shot.** First and last stills, the animatic at real duration, and the camera. The stills
  fill the shot's first and last frame slots, so generation later has endpoints that agree by construction.
- **See the cheap gate before spending.** The Previz page shows the set, each shot's camera, the pair of stills and a
  playable animatic — the point at which staging and timing are approved, before any pixels are bought.

## Slice 5 — edit the plan

- **Edit a shot in place.** Number, framing, angle, movement, duration and description are editable from the shot's
  row. Saving records that the shot was checked against the scene as it stands.
- **Edit a scene in place.** Heading, time of day, synopsis and body. Saving marks exactly that scene's shots stale and
  shows the cause beside each one — a badge with a reason, not an unlabelled warning.
- **Re-check is one click.** It records the scene hash the shot was reviewed against. Nothing is regenerated, and
  nothing that did not change goes stale.

## Slice 4 — spend with approval

- **See the price before you spend.** Estimate prices a shot against the catalog — a draft at $0.05/s, a final at
  $0.40/s — and stores it. Nothing is charged until a take is submitted.
- **Approve a number, not a vibe.** Approving returns a single-use token naming the estimate, its price and a fifteen
  minute expiry. If the plan changes, the token is void and must be re-priced.
- **The budget cannot be argued with.** The ceiling is checked when a job reserves money, before a frame renders; a
  refused batch says what it costs and what is left. A failed job refunds.
- **Takes arrive with provenance.** Each take records its endpoint, seed, price, job and asset. The first take for a
  shot is selected; any other can be selected with one click.
- **A skill travels with the project.** `project.create` writes `.dsh/skills/slate-production/SKILL.md`, so an agent
  opening the folder knows the workflow, the money rule and what readiness means without being told.

## Slice 3 — a cut you can watch

- **Build a cut from the plan.** Every shot with a board or first frame becomes an item, in scene order, at its
  planned duration. Building replaces the selection; the film's order is the plan's order.
- **Render and play it.** The cut renders to MP4 through FFmpeg, exactly as long as the selection says, and plays in
  the browser. Media is served by asset id, not by file path, with range support and only to a signed-in caller.
- **Know where a tool came from.** On Health, hover an application name to see the path it was found at. A reviewer
  never receives that path; the owner does.
- **Rename a project.** The owner (or an editor) can rename it from the project header; the name is part of the
  document, so the change is a commit with an author and the new name appears everywhere at once.
- **The gate renders a film.** `pnpm gate:3` generates two boards, builds an 8.0s cut, renders it, fetches the bytes
  with a range request, verifies the duration matches the cut, and refuses the same URL without a session.

## Slice 2 — story to shot list

- **Slate finds the tools you already have.** Applications installed somewhere other than `PATH` — a different drive,
  a versioned folder — are discovered from the system's own install records. The health panel now says where each
  tool was found ("installed application", "common install folder", `PATH`) instead of only whether it answered.
- **Installed but unverified is amber, not red.** A tool that runs but does not report a version is still the tool
  that will do the work; the chain uses it and marks the stage unverified. Red now means the program could not be
  started at all.
- **An escape hatch for unusual installs.** `SLATE_FFMPEG_PATH`, `SLATE_BLENDER_PATH`, `SLATE_OPENSHOT_CLI_PATH`,
  `SLATE_MPV_PATH`, `SLATE_MELT_PATH` and `SLATE_FFPROBE_PATH` override discovery entirely.
- **Write the five lines in the browser.** Situation, desire, conflict, change, result — each save keeps a revision
  with who changed it and why, and missing lines are marked rather than silently accepted.
- **Turn scenes into a shot list.** Add a scene with INT/EXT, location and time of day; add shots with framing,
  angle, movement, duration and a description. Shot numbers are assigned (`1A`, `1B`) and numbering is never reused.
- **Readiness you can act on.** Every shot reports named checks with pass, warn or fail — no description, a duration
  past ten seconds, a duplicate shot number, a story that is not settled yet.
- **Staleness with a cause.** Editing a scene marks exactly its own shots stale, says which scene changed, and offers
  a one-click re-check. Nothing else is invalidated.
- **One revision clock.** The project and the plan share a revision; a write based on an old one is refused with a
  conflict instead of overwriting someone else's work.
- **Every operation from the CLI.** `slate op <name> --input <json>` runs any operation with no daemon.
- **Every operation from an agent.** `slate mcp --root .` serves the same registry over MCP, so an assistant can
  read the plan, write the five lines and create shots without a browser, and `docs/OP-REGISTRY.md` lists exactly
  what it can do.

## Slice 1 — boot, auth, health

- **Sign in to Slate.** The first run creates an owner account and prints its password once in the terminal that
  started `slate serve`. Sessions are signed cookies; every change requires a CSRF token; a viewer account can read
  but cannot write.
- **Create a film project in the browser.** A project is a folder with a document, media directories and a genesis
  commit. Every later change is a commit with an author and an intent.
- **"How this will run."** Slate probes the machine and names the program that will execute each stage — assembly,
  previz, playback, mix — with the reason. Tools that are installed but not on `PATH` are found anyway. A degraded
  stage says what is lost, before any work starts.
- **Activity.** The commit log is visible as a readable feed.

## Unreleased groundwork

- Canonical hashing that refuses ambiguous values, an append-only commit log with atomic writes, and an operation
  registry that validates input, refuses writes without a declared touched set, and validates its own output.
