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
| 11 | Setup: AI connections | `pnpm gate:11` | **done** | [setup](../artifacts/11/setup.png) · [report](../artifacts/11/report.json) |
| 12 | Scenes, frames and the shoot | `pnpm gate:12` | **done** | [plan](../artifacts/12/plan-expanded.png) · [report](../artifacts/12/report.json) |
| 13 | Model profiles per project | `pnpm gate:13` | **done** | [profiles](../artifacts/13/binding-sets.png) · [project](../artifacts/13/project-binding.png) · [report](../artifacts/13/report.json) |
| 14 | Editable sheets, one reference image | `pnpm gate:14` | **done** | [editor](../artifacts/14/sheet-editor.png) · [published](../artifacts/14/sheet-published.png) · [report](../artifacts/14/report.json) |

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
| Sheet-conditioned generation (pass pinned views to the gateway) | provenance field exists; the local gateway has no reference input |
| Delete a scene or shot | missing — needs cascade rules for takes and cut items |
| Scene intent note (GUIDE §17 handoff) | missing |
| Coverage plan (GUIDE §7: master plus variants) | missing |
| Project settings after creation (runtime, aspect, budget) | only `project.create` sets them |
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
