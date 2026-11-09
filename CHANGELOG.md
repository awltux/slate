# Changelog

User-visible changes per slice. Internal refactors are not listed.

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
- **Headless parity.** Every operation above is available from the CLI with no daemon running.

## Unreleased groundwork

- Canonical hashing that refuses ambiguous values, an append-only commit log with atomic writes, and an operation
  registry that validates input, refuses writes without a declared touched set, and validates its own output.
