# Changelog

User-visible changes per slice. Internal refactors are not listed.

## Slice 2 — story to shot list (in progress)

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
