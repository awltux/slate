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
| 6 | Previz | `pnpm gate:6` | **done** | [previz](../artifacts/6/previz.png) · [report](../artifacts/6/report.json) |
| 7 | Library: prompts, candidates, sheets | `pnpm gate:7` | **done** | [library](../artifacts/7/library.png) · [report](../artifacts/7/report.json) |
| 8 | Collaboration | `pnpm gate:8` | **done** | [collaboration](../artifacts/8/collaboration.png) · [report](../artifacts/8/report.json) |
| 9 | Finish & deliver | `pnpm gate:9` | **done** | [finish](../artifacts/9/finish.png) · [report](../artifacts/9/report.json) |
| 10 | Remote review | `pnpm gate:10` | **done** | [review-link](../artifacts/10/review-link.png) · [report](../artifacts/10/report.json) |
| 11 | Setup: AI connections | `pnpm gate:11` | **done** | [setup](../artifacts/11/setup.png) · [edit](../artifacts/11/setup-edit.png) · [model](../artifacts/11/endpoint-edit.png) · [delete](../artifacts/11/setup-deleted.png) · [report](../artifacts/11/report.json) |
| 12 | Scenes, frames and the shoot | `pnpm gate:12` | **done** | [plan](../artifacts/12/plan-expanded.png) · [report](../artifacts/12/report.json) |
| 13 | Model profiles per project | `pnpm gate:13` | **done** | [profiles](../artifacts/13/binding-sets.png) · [project](../artifacts/13/project-binding.png) · [report](../artifacts/13/report.json) |
| 14 | Editable sheets, one reference image | `pnpm gate:14` | **done** | [editor](../artifacts/14/sheet-editor.png) · [published](../artifacts/14/sheet-published.png) · [report](../artifacts/14/report.json) |
| 15 | Project shape, models and look | `pnpm gate:15` | **done** | [create](../artifacts/15/new-project.png) · [project](../artifacts/15/project-created.png) · [report](../artifacts/15/report.json) |
| 16 | Deleting a project, guarded | `pnpm gate:16` | **done** | [confirm](../artifacts/16/delete-project.png) · [after](../artifacts/16/projects-after-delete.png) · [report](../artifacts/16/report.json) |
| 17 | References reach a remote model | `pnpm gate:17` | **done** | [transport](../artifacts/17/reference-transport.png) · [report](../artifacts/17/report.json) |
| 18 | Project backup and restore | `pnpm gate:18` | **done** | [export](../artifacts/18/project-export.png) · [import](../artifacts/18/project-import.png) · [report](../artifacts/18/report.json) |
| 19 | Health belongs to the host | `pnpm gate:19` | **done** | [host health](../artifacts/19/host-health.png) · [report](../artifacts/19/report.json) |
| 20 | One place for the project's configuration | `pnpm gate:20` | **done** | [config](../artifacts/20/project-config.png) · [report](../artifacts/20/report.json) |
| 21 | Uploads are an endpoint; endpoints declare responses | `pnpm gate:21` | **done** | [upload endpoint](../artifacts/21/upload-endpoint.png) · [report](../artifacts/21/report.json) |
| 22 | Each library type has instructions, in three layers | `pnpm gate:22` | **done** | [film's copy](../artifacts/22/type-prompts.png) · [report](../artifacts/22/type-prompts-host.png) |
| 23 | Test a provider and each endpoint, from the interface | `pnpm gate:23` | **done** | [provider test](../artifacts/23/provider-test.png) · [report](../artifacts/23/report.json) |
| 24 | Library items are made by the model the profile binds | `pnpm gate:24` | **done** | [generated item](../artifacts/24/library-by-model.png) · [report](../artifacts/24/report.json) |
| 25 | A known model, called synchronously or through a queue | `pnpm gate:25` | **done** | [known models](../artifacts/25/known-models.png) · [queued item](../artifacts/25/queued-model.png) · [activity message](../artifacts/25/activity-message.png) · [report](../artifacts/25/report.json) |
| 26 | A frame is edited from the scene's sheets, not painted from words | `pnpm verify` | **done** | [capabilities in Setup](../artifacts/26/capabilities.png) |

## Slice 25 — what it proves

- **The activity log keeps the exchange**: the prompt, the model, the endpoint, the style and the answer are written onto
  the commit, minimised in the interface and opened on demand. The gate opens the newest entry and finds the prompt in it.
- **Activity is paged**, with a cursor, so the page does not grow without bound.


- **A model is added in one click and called through fal's queue.** The gate stands up a queue-shaped server, adds
  FLUX schnell from the preset (pointed at that server), binds it, and generates. It asserts the job id, the polls, the
  seed the model used, the price, and that the body carried the film's exact pixel size.
- **A capability is data.** `text-to-image` replaces `image`; an older config parses, is normalised on read, and keeps
  every provider. The interface renders the capability table, so it cannot drift from what the operations accept.
- **A queued job is followed, not guessed at**: submit, poll with backoff, collect the result; a job that never
  completes is cancelled and reported as `provider_timeout`.
- **Nothing is sent that nobody asked for**: an unset parameter leaves the body rather than appearing as an empty
  string, which is what made a valid size into a 422.

## Slice 24 — what it proves

- **The sheet comes from the endpoint.** Gate 24 stands up its own model server, saves a provider and an image
  endpoint, binds them in a profile, and generates a character's sheet. It asserts the images came from that endpoint,
  that the price recorded is the endpoint's, that the model was called once per candidate with distinct seeds, and that
  both results were fetched as bytes and stored as assets of the film.
- **Nothing is drawn behind a person's back.** With no image endpoint bound, generation returns
  `capability_missing` and the interface offers the local renderer as a sentence with a button, not as a silent
  fallback. The same is true for a frame.
- **Expand prefers the configured text endpoint** over the `llm` block nobody can reach from the interface, and says
  which rung ran in `via`.

## Slice 23 — what it proves

- **A provider and each of its endpoints can be tested** from Setup. The test is a reachability check by default, with
  a declared path and method, and it reports the request it sent, the code it got and the body that came back, with the
  credential masked.
- **An endpoint test sends the endpoint's own body**, rendered with sample values, and reports whether the declared
  `resultPath` was actually present — the difference between a 200 and a working model.
- **A queue host is recorded, testable and refused where it would mislead**, because Slate cannot yet follow a request
  id.

## Slice 22 — what it proves

- **Instructions belong to the type, not to the code.** A character, a location, a prop, a style, a costume and a body
  each say what a prompt about them must contain. `prompt.expand` and `prompt.expand-text` send the resolved text as
  the system message; a unit test with an injected transport reads the request back and finds the project's words in
  it, which is the only way to prove a system prompt is used rather than merely written.
- **Three layers, and the screen says which applies.** The film's copy, else the host's, else the built-in. A blank
  box is not an override: clearing returns to inheriting, so "empty" can never become an empty instruction.
- **The host edits its own layer on the app Library tab**, behind one title that is closed until opened, and the gate
  asserts it starts closed. What it changes, every film inherits — hence owner-only.
- **The film's copy sits on the project Library tab**, one row per type, also minimised, and editing starts from the
  wording in force rather than an empty box.

## Slice 21 — what it proves

- **An upload is an endpoint, not a provider field.** The provider keeps only the inline ceiling; the file API is a
  declared endpoint with the `upload` capability, and the catalog points at the one bound to the provider. The gate
  saves one, checks the catalog points at it, and uploads a reference through it to its own loopback fake.
- **Endpoints declare their responses.** Named fields with paths, so an upload promises `upload_url` and `file_url` the
  way an image endpoint promises `images[0].url` — and a missing one is a coded refusal, not a guess.
- **A text model can draft an endpoint**, from the provider's base url and the path, and the form fills with the
  proposal for review. Unit tests prove the request the drafter builds and its four failure modes with an injected
  transport; the gate proves the button refuses with `capability_missing` when no text endpoint is bound, which is the
  prerequisite.
- **Nothing is saved by a model**: the drafter returns a proposal and the person saves it.

## Slice 20 — what it proves

- **The configuration is one document with one writer.** `project.update` changes the name, shape, rate, runtime,
  budget, model profile and default look, and writes a single commit whose intent says what changed (`rate 24 -> 30fps`,
  `resolution 1080p -> 720p`), so the history stays a record of decisions rather than "updated settings".
- **Every decision is reachable from one tab**, first in the row: the values the film was created with are now editable,
  which was the gap — they used to be write-once.
- **A ceiling cannot fall below what is committed.** The operation refuses it and says by how much, and the page shows
  committed versus remaining so the number is actionable.
- **A default look must be a style**: a character id is refused with `invalid_input`, and an unknown model profile with
  `not_found`.
- **Saving changes nothing when nothing changed** — no commit, no revision, no noise in the history.

## Slice 19 — what it proves

- **Health is host state, and says so.** The panel moved to the top level, where it answers with no project open —
  which is how a fresh host starts — and the cache moved with it: one snapshot in the home, not one copy per film.
- **Every tool is listed once**, including the archiver, with its version and (for the owner) the install path that
  explains a surprise.
- **An agent is a caller, not a service.** The panel names the three surfaces an agent can drive (MCP over stdio, HTTP,
  the CLI), counts the operations each reaches, and carries a paste-ready MCP config. It is not a toolchain row because
  Slate runs without a harness; what matters is the way in, and the honest limits of each (MCP needs no credentials, the
  HTTP surface has no bearer token yet).
- **A tool that is missing is actionable**: the row links to its download page and states the version Slate relies on,
  so a red dot is a next step rather than a diagnosis with no treatment. The gate asserts every non-green row carries an
  https link and a requirement, and that at least one such row exists on the gate host.
- **Probing again is the operator's fix**: it refreshes in place, so a tool installed a minute ago appears.

## Slice 18 — what it proves

- **Nothing is typed.** Import is the browser's file picker; export offers `Save a copy` through the save dialog, and
  **Choose folder…** opens the host's own dialog (a browser cannot name a folder to a server), so a large project is
  written in one move instead of copied through the browser. The chosen folder is a one-use token: the path stays on
  the host and never appears in a result. Export offers `Save a copy` through the save dialog, so a
  copy can go anywhere. The gate drives both: it picks the archive in a file input, opens the restored film, then
  clicks Save a copy and asserts the download is named after the archive. Advanced is proved too: the host writes
  straight into a folder, the notice says so, and no browser copy is offered for it.
- **A film leaves and comes back as itself.** The gate builds a project with a scene, a shot and a generated frame,
  exports it to one 7z, deletes the project outright, imports the archive, and asserts the same project id, name and
  revision return with the frame still served.
- **The archive is self-describing**: a manifest inside it names the project and counts its shots, so the file can be
  identified without opening the documents — the gate unpacks it and reads that manifest.
- **Nothing is written before the archive is proven**: one root folder, no links, no paths outside the unpacked tree, a
  manifest that parses, and a project document that agrees with it about which film this is.
- **A backup cannot overwrite a film that moved on**: importing an archive whose project is already on the host is a
  `conflict`.
- **7-Zip is discovered, not assumed**: it joins the service catalogue and the health list, with `SLATE_7Z_PATH` as the
  escape hatch, and a missing archiver is a `capability_missing` rather than a half-written backup. A cached capability
  snapshot that predates the tool is discarded and re-probed instead of hiding it.

## Slice 17 — what it proves

- **A local file can be handed to a remote model.** Image references are inlined as a data URI when they fit, and
  uploaded through the provider's own two-step file API when they do not — the gate runs that upload over real HTTP
  back to a loopback fake, asserting the initiate body (content type, byte count as a number) and that the presigned
  PUT received exactly the measured bytes.
- **The transport is declared, not hardcoded**: inline or inline-then-upload, the ceiling, the endpoint, its body
  template and the response paths all live on the provider.
- **Nothing is silently dropped.** A reference over the ceiling with no upload declared is planned as refused — a
  `reference_too_large` warning in preview — and would be a coded failure at call time, not a call that quietly ran
  without its reference.
- **Preview stays offline and still answers**: it reports the size, the rung and where the reference lands, without
  moving a byte.
- **The upload is testable before a shot needs it**: `ai.reference.test` uploads a tiny image, and the card offers it.
- **No test can reach the internet by accident**: the network is an injected port, and a test context without a fake
  throws rather than fetching.

## Slice 16 — what it proves

- **The guard is the typed name, and the operation enforces it.** The gate sends a wrong-case name through the API and
  is refused with a code — the project stays listed and its folder untouched. A form can be bypassed; this cannot.
- **Keeping the folder is the default**, so deleting is an unlisting rather than a loss: the gate asserts the project
  leaves the host list while `project.json` is still on disk.
- **With the option off the folder goes**, and the gate asserts it is gone rather than trusting the flag.
- **Only an owner may delete.** An editor's request is refused before the operation runs.
- **Creation and deletion now own the host index**: a project made from any surface is listed, and deleting unregisters
  the same way — the HTTP route no longer registers on the side.

## Slice 15 — what it proves

- **Creation is where the film's shape is decided**, not a default nobody chose: aspect ratio, frame rate, resolution,
  model profile and a style sheet are asked for and stored on the project.
- **The settings govern the pixels.** The gate generates a still for a 9:16 project at 720 and gets 720x1280, renders
  the cut at the same size, and asserts the encoder was told the project's frame rate rather than a baked-in 30.
- **The look is one decision.** The chosen library style is cloned into the project, and an entry that names no style
  of its own is written with it — the gate asserts `prompt.expand` reports and carries that style.
- **A session can read the film before touching it**: `session.brief` carries the settings and the profile.
- **The app library and profiles are readable before a project exists**, which is what makes choosing them at
  creation possible at all.

## Slice 14 — what it proves

- **A sheet is edited rather than rebuilt.** Opening it starts from the published items, and generating more candidates
  adds them to the same set — the gate proves that a second generation leaves one published sheet plus five draft
  items, not two.
- **An item's type is the edit.** A rotation or a kind, `disabled` to keep it out of the picture, `delete` to remove it
  when the sheet is published; the type dropdown carries all three.
- **Publishing composes one reference image** from the active items, and that single image is what a scene backdrop, a
  cut fallback and the app library's cover actually point at. A disabled item stays listed but is not in the composite;
  a deleted one is gone (`dropped` reports it).
- **Only a publish advances the version**, so an edit in progress does not make a shot pinned to v3 stale — the gate
  asserts the shot is fresh after the edit and stale after the publish.
- **The reference sheet travels**: pushing the entry to the app library makes the composite its cover, and pulling
  re-ingests it.
- **A gate whose browser step fails now fails.** The harness used to record a skipped UI step and still report
  `passed`, which meant a broken page could never fail its own gate.

## Slice 13 — what it proves

- **Bindings became profiles.** Any number of binding sets can exist over the same endpoints, each naming the endpoint
  that serves each capability, so one installation can offer a cheap draft and an expensive final at once.
- **A project chooses the profile it runs on**, and the choice is a document write with a revision rather than a UI
  preference: it is committed, attributable and undoable like any other edit.
- **The choice decides the model.** Resolution runs `project set → host default → any endpoint of that capability`, and
  `ai.preview` returns the profile that chose the endpoint, so the rung is reported rather than implied.
- **Removing an endpoint prunes it from every set**, so a profile can never keep a dangling id.
- **Old configurations still load**, migrating a flat binding map into one "Default" set on first read.

## Slice 12 — what it proves

- **A scene is a set of library items**, not a single location link, and the first location among them is the backdrop
  the cut falls back to.
- **Frames are generated from those items**: the frame records the entity ids, the sheet versions they were pinned at
  and the blockout it was conditioned on, so the picture has a provenance rather than a prompt.
- **The shoot runs between the frames**: an approved estimate produces a take that records `fromFrameId` and
  `toFrameId`, and the clip moves from one to the other over the shot's duration.
- **The plan stays readable**: scenes are one collapsed heading, and only the selected scene shows its items, shots and
  frames.

## Slice 11 — what it proves

- **The AI layer is data.** A provider is transport plus a credential; an endpoint is one capability plus one request
  shape; a binding chooses which endpoint serves a capability. Adding a provider or a second model is a form, not a
  deploy.
- **Heterogeneity is absorbed by a template.** Parameters are declared once and referenced from the body, keep their
  declared types, and are placed wherever the API wants them — which is what lets fal, OpenAI-compatible hosts and a
  local graph runner share one code path.
- **Preview is the offline test**: the exact URL, headers and body, key masked, no network call and no cost.
- **Credentials never come back out**; `ai.catalog` reports only that a key exists, and only an owner can reach any of
  these operations — an editor is refused with 403 before the registry runs.
- **A connection is edited or deleted from the same card.** Editing is the same operation as creating, keyed by id: the
  form opens on the stored host and auth shape, a blank key keeps the stored credential, and the endpoints follow the
  provider they belong to. Deleting a provider takes its endpoints, the profile bindings that named them and the stored
  key with it, and both the confirmation and the notice say how much that is.
- **A model is edited or deleted from its row.** Its form opens on the stored call — method, path, body template,
  parameter declarations — and saving keeps the same endpoint. Deleting one clears only the binding that named it: the
  host and its credential stay.

## Slice 10 — what it proves

- **A link, not an account.** The reviewer opens a signed URL with no session and sees the cut, the shot list and the
  notes. The token names the project, the link id and an expiry; the document holds the revocation flag, so revoking
  takes effect on the next request.
- **Notes are data**: anchored to a shot or the cut, attributed to the name typed, flagged `external`, and resolvable
  from the project side. They are never edits.
- **The blast radius is one page**: the only routes a link opens are read the summary, add a note, and fetch media.
- **Failure is honest**: an expired or revoked link says so in plain language instead of 404ing into a blank page.

## Slice 9 — what it proves

- **Delivery inspects the artefact, not the plan.** Every QC check runs on the encoded file: duration against the cut,
  codec, resolution, audio, black stretches, total length. A failure is data, not an opinion.
- **Black frames warn, they do not fail.** A film set at night is allowed to be dark.
- **The manifest is part of the deliverable**: each shot, its take, the pinned sheet versions and the encoder version,
  served to the same session as the master, so provenance travels with the file.

## Slice 8 — what it proves

- **Presence is a notice, not a lock.** The daemon keeps an in-memory registry of who is on which page, expiring after
  45 seconds. It never blocks a write; the conflict check does that.
- **Concurrency is refused, not merged.** A write carries `expectedRevision`; the second writer gets `conflict` with the
  head revision named, and the Plan page offers a reload instead of pretending the write landed.
- **Undo is scoped and attributable.** Only the head commit can be reverted, and only by its author (or an owner):
  reverting a buried commit would discard other people's later work. The undo is itself a commit, so it can be undone.
- **Roles do the rest.** Viewer reads, editor writes, owner also changes host configuration and sees install paths.

## Slice 7 — what it proves

- **Characters, locations and props are entities with versioned sheets.** Views are what a model is conditioned on,
  `heightM` is what a proxy is scaled from, and rights gate the expensive tier.
- **Publishing never edits.** A new sheet is a new version; shots that pinned the old one become stale, with the
  version change as the cause, and nothing else moves.
- **Consent defaults to pending for a character**, which fails the readiness check rather than being quietly allowed.
- **The library is visible**: versions, views, measurements and consent, with the ability to define new entities.
- **Two scopes**: the project library holds the entries a project uses; the app library (a tab beside the project
  selector) holds what is shared across projects. Push publishes a versioned copy, pull refreshes the clone, import
  brings a shared item into a project, and the Pull button highlights when the shared version has moved on.

## Slice 6 — what it proves

- **A set is declared, not invented.** The agent authors the `.blend`; Slate validates the manifest — units, frame
  rate, frame range, entity-to-object bindings and camera keys — and stores it with the file as an asset.
- **A blockout is four artifacts with four uses**: the animatic clip, the first and last stills, and the camera.
  Attaching it fills the shot's first and last frame slots, so a later generation step has endpoints that are
  geometrically consistent by construction.
- **Continuity becomes geometry.** The camera records lens, height and which side of the line of action it sits on;
  `axisSide` is data, so a deliberate axis break is visible rather than argued about.

## Slice 5 — what it proves

- **The plan is editable from the browser** — a shot in its row, a scene in place above its shots.
- **Editing is a review, and the system says what it broke**: saving a shot records that it was checked against the
  scene as it stands; editing the scene marks exactly its own shots stale, with the cause beside each one.
- **Re-check is one click**, clearing the badge by recording what was reviewed — not by regenerating anything.

## Slice 4 — what it proves

- **An estimate is a record, not a message.** `estimate.create` prices each shot against a catalog entry and stores it.
- **Approval is signed, single use, and void if the plan changes.** The token names the estimate, its price and expiry.
- **Spending reserves before rendering**; a failed job refunds, and concurrent submits cannot both pass a ceiling check
  that neither has decremented.
- **The loop is whole without a key**: the local gateway renders deterministically, draft at $0.05/s and final at
  $0.40/s, so the cost ladder is visible in the numbers.

## Slice 3 — what it proves

- **A frame becomes an asset** by content hash; the document never records the path it came from.
- **The cut is a selection list** — shot, frame, duration — and rendering references it, so a re-cut does not lose the
  take that was chosen.
- **It plays**: FFmpeg renders exact durations (pinned by a gate assertion) and media is served by asset id, only to a
  signed-in caller.

## Slice 2 — what it proved

- **The five lines are a document, not a prompt**, with a revision per save.
- **A scene becomes a shot list**, numbered and never reused.
- **Readiness is data**: named checks with pass/warn/fail instead of a disabled button.
- **Staleness is derived and scoped**; the envelope reports what a change invalidated.
- **One revision clock** across project and production documents.

## Backlog — known gaps

Not future features to invent: things the GUIDE promises, or the product obviously needs, with an honest note on what
already exists.

| Item | State |
|---|---|
| Sheet-conditioned generation (pass pinned views to the gateway) | provenance field exists, and references can now be staged inline or uploaded (slice 17); the local gateway still takes no reference input |
| Delete a scene or shot | missing — needs cascade rules for takes and cut items |
| Scene intent note (GUIDE §17 handoff) | missing |
| Coverage plan (GUIDE §7: master plus variants) | missing |
| Project settings after creation (runtime, shape, rate, look, budget) | only `project.create` sets them |
| Upload images from the browser (boards, sheet views) | operations take server-side paths |
| Compare two takes side by side | `take.list` returns both; the page stacks them |
| Conform a take into its slot (trim/retime) | `cut.build` uses planned durations |
| B-roll from source footage | missing |
| Cross-project library | the library is per project |
| Finish: mix, subtitles, titles, upscale | slice 9 |
| Remote review link | slice 10 |
| Conflict handling outside the Plan page | only Plan sends `expectedRevision` so far |

## Notes

- `artifacts/` is committed: screenshots are the evidence that a slice exists.
- The cut lives inline in `production.json` rather than in `cut/<id>.json` as `docs/ARCHITECTURE.md` §5.3 describes.
  One document means one commit and no cross-file sync; projections (OTIO/EDL) become files when they exist.
