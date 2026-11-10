# Changelog

User-visible changes per slice. Internal refactors are not listed.

## Scenes hold library items; frames are generated; the shoot runs between them

- **A scene carries the library items that are in it** — the place, the people, the things, as many as you like. The
  first location among them is the backdrop.
- **Start and end frames are generated**, not drawn: each is conditioned on the scene's items and, when the previz has
  one, on the blockout render that fixes the geometry. The frame records both, so it can be regenerated or blamed.
- **The shoot runs from the start frame to the end frame**, and the take records the pair it was made between.
- **Scenes are collapsed to a heading** in the plan, with only the selected scene open.

## Setup — AI connections

- **A Setup tab, for the owner only.** Declare any number of AI providers and, each hidden underneath its provider, the
  endpoints — one per model and capability. Nothing about a provider is hard-coded: fal's one key with a route per model
  and an OpenAI-compatible host with one route and many models are both just data.
- **Every REST method**: GET and DELETE send their values as a query string, POST, PUT and PATCH send a body.
- **Parameters are declared once** and placed by a body template (`"num_images": "{{param:num_images}}"`), so each API's
  unique shape is expressible without a new adapter. Parameters keep their declared types — `4`, not `"4"`.
- **Preview proves a connection without spending anything**: it renders the exact request, with the key masked, and
  never calls the network.
- **Keys are write-only.** Setup can replace a key but never display it, and only the owner can open the tab at all.

## Remote review

- **A review link is the only door that needs no account.** Signed, expiring and revocable, it shows the film and the
  shot list and lets the reviewer leave notes — nothing else. It cannot change the plan or approve spend.
- **Notes land in the project**, anchored to a shot or the cut, attributed to whatever name the reviewer typed and
  marked as coming from a link, so nobody mistakes them for an edit.
- **Revoking is immediate**: the next request through that link gets a page saying the link is no longer valid rather
  than a silent failure.
- The project Review tab creates links, lists their state, and resolves notes.

## Expanding a description into a prompt

- **Expand sits beside the description.** One button turns what you wrote into a generation prompt, folding in the style
  sheet when one is applied — and it reads the field it sits next to, so there is no separate save step.
- **A model writes it when one is configured** (an OpenAI-compatible endpoint in `config.json`); otherwise a
  deterministic local composer writes it and the result says so, with a warning. A prompt never claims a provenance it
  does not have.

## A shared library

- **Two libraries, one item shape.** A project has its own library of the characters, locations, props and styles it
  uses. The app has a library, a tab beside the project selector, holding what is shared across every project.
- **Push publishes, pull refreshes.** Pushing copies an entry — images included — into the app library as a versioned
  item; the project keeps its own copy, so editing it there never changes what others see. Pull takes the newest
  version, and the Pull button is highlighted when the shared version has moved on.
- **Import brings a shared item into a project** as a cloned entry, free to diverge.

## Scene backdrops

- **A scene can link to a location.** Pick one from the library in the plan; the location sheet is what the scene looks
  like and supplies the backdrop plate. When a shot has no frame of its own, the cut uses the location cover instead of
  dropping the shot, and readiness says so.

## Slice 9 — finish and deliver

- **Export a master.** The rendered cut is muxed with an optional audio bed and encoded (web: stream copy with
  faststart; master: H.264 CRF 16), then every QC check runs against the file that was actually produced.
- **QC is a report, not a checkbox**: duration against the cut, codec, resolution, audio presence, black-frame detection
  and total length. A night scene may legitimately be dark, so black frames warn rather than fail.
- **A provenance manifest ships with the film** — `exports/provenance-r<n>.json` names every shot, its take, the sheet
  versions it pinned and the FFmpeg that encoded it, and is downloadable by whoever can watch the master.

## Slice 8 — working together

- **See who else is in the room.** Presence shows the other people on a project, expiring on its own. It is a notice,
  never a lock.
- **Two people cannot silently overwrite each other.** A write carries the revision it was based on; if someone else
  wrote first, the second is refused with `conflict`, and the Plan page offers a reload instead of clobbering.
- **Undo your own last change.** The newest commit can be undone by its author (or an owner). Buried commits are
  refused, because undoing one would discard other people's later work.

## Slice 7 — the library: descriptions, candidates, sheets

- **Every entry starts with a description** in your own words; Expand turns it into a prompt, and both are kept so a
  sheet traces back to the sentence that made it.
- **Generate options, then pick.** Candidates are rendered from the prompt and priced per image; you assign a role to
  each image you keep, and that selection publishes a sheet version.
- **A character's sheet is six head rotations**; a partial selection publishes and reports what is missing.
- **Wardrobes and states are variants with their own prompts** — an outfit, a run-down location, a repainted wall.
- **Style sheets are entries too**; any character, location or prop can use one, and generation records which.
- **Edit anything; delete only what is unused.** Deleting an entry still referenced by a shot (or used as another
  entry's style) is refused, naming what uses it.

## Slice 6 — previz

- **Attach a digital set.** A Blender manifest is validated — units, frame rate, range, entity bindings and camera
  keys — and stored with the `.blend` as an asset. Slate consumes the agent's work; it does not model.
- **Attach a blockout for a shot.** First and last stills, the animatic at real duration, and the camera. The stills
  fill the shot's frame slots, so generation later has endpoints that agree by construction.
- **See the cheap gate before spending**: sets, camera, stills and a playable animatic, before any pixels are bought.

## Slice 5 — edit the plan

- **The plan is editable from the browser** — a shot in its row, a scene in place above its shots.
- **Editing is a review, and the system says what it broke**: saving a shot records what it was checked against;
  editing the scene marks exactly its own shots stale, with the cause beside each one.
- **Re-check is one click**, clearing the badge by recording what was reviewed.

## Slice 4 — spend with approval

- **An estimate is a record, not a message.** `estimate.create` prices each shot against a catalog entry and stores it.
- **Approval is signed, single use, and void if the plan changes.**
- **Spending reserves before rendering**; a failed job refunds, and two concurrent submits cannot both pass a ceiling
  check that neither has decremented.

## Slice 3 — a cut you can watch

- **A frame becomes an asset** by content hash; the document never records the path it came from.
- **The cut is a selection list** — shot, frame, duration — and rendering references it.
- **It plays**: FFmpeg renders exact durations, and media is served by asset id to a signed-in caller only.

## Slice 2 — story to shot list

- **The five lines are a document, not a prompt**, with a revision per save.
- **A scene becomes a shot list**, numbered and never reused.
- **Readiness is data**: named checks with pass/warn/fail instead of a disabled button.
- **Staleness is derived and scoped**; the envelope reports what a change invalidated.

## Slice 1 — boot, auth, health

- **One daemon, one project folder.** `slate serve` binds the loopback interface, prints the owner password once, and
  serves the app.
- **Roles are real**: viewer reads, editor writes, owner also changes host configuration and sees install paths.
- **Health is honest**: every tool is probed and reported green, amber (installed but unverifiable) or red, with the
  source of the discovery named and the install path shown on hover.

## Unreleased groundwork

- Documents are written atomically and committed with a snapshot, a validation pass and a commit log.
- Canonical hashing and derived staleness underpin every "what changed" answer.
- Tool discovery: environment override, vendored binaries, Windows uninstall registry, conventional folders, PATH.
