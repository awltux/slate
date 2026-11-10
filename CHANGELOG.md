# Changelog

User-visible changes per slice. Internal refactors are not listed.

## The Frames button on the plan page works again

- **Frames was rejected as invalid input.** `frame.generate` did not accept the revision the plan page sends with every
  other write, so the button failed before rendering anything. It now takes the revision, checks it *before* spending,
  and still checks at commit time - a shot edited while a frame is rendering is a `conflict`, not an overwrite.
- **And the two frames a button press makes no longer conflict with each other**: the plan page carries the revision
  forward from the first commit to the second, instead of claiming the same snapshot twice.
## Uploads are an endpoint, and endpoints declare what they return

- **The file API moved out of the provider.** An upload is now an endpoint with the `upload` capability: a method, a
  path, a body template and a response you declare — the same shape as every other model. The provider keeps only how
  big a reference may be before it needs one, and the catalog points at the endpoint that takes the bytes.
- **Endpoints declare their responses**, by name and path, not just one result path. An upload therefore promises
  `upload_url` and `file_url` the way an image endpoint promises `images[0].url`, and a call can read both without
  guessing at the provider's shape.
- **Draft with AI.** A text endpoint is asked how a provider's endpoint works — given the base url and the path — and
  the form is filled with what it proposes, for review. The proposal is never saved by the model: you save it.
- **It says what it needs.** With no text endpoint bound, Draft with AI refuses with `capability_missing` and a
  sentence telling you to add and bind one, which is the prerequisite the whole feature depends on.
## Configuration lives in one place

- **A Config tab, first in the row**, holds every decision the film was made with: name, runtime, aspect ratio, frame
  rate, resolution, model profile, default look, budget, the archive and the delete guard.
- **Those settings are now editable.** They used to be write-once at creation; each save is a single commit that says
  what changed, so a change of frame rate has a name and a time on it.
- **The budget shows what is committed** against the ceiling, and a ceiling cannot be lowered below money already spent.
- **The header states the film's shape and look** without offering to change it there — one place to read, one to edit.
## Health is the host's, not a project's

- **Health moved to the top level.** The toolchain is a property of the machine, so the same panel now answers for every
  project — and it works with none selected, which is where a fresh host starts.
- **One probe, one snapshot.** The result is cached once on the host instead of once per project, so switching films no
  longer re-probes, and installing a tool shows up after a single "Probe again".
- **It says what it is**: "How this host will run", with the chains, the tools and their versions, and the install path
  on hover for the owner.

## A project can be backed up and restored

- **No paths to type.** Import opens the browser's file picker for a `.7z`; Export offers "Save a copy…" through your
  computer's save dialog, so a copy can be put anywhere without mistyping a folder. The archive itself is written to
  the host's exports folder, which the notice names.
- **Large projects can skip the browser copy.** Under Advanced, Export writes straight into a folder the host can
  reach: one move by this machine instead of the browser reading the archive and writing it again — for a 40 GB film
  that is 40 GB of extra traffic avoided.
- **Export writes the film to one 7z**: the whole project folder — documents, media, exports and its commit history —
  with a manifest inside that names the project, its revision, its shape and what it contains. A person can open the
  archive and read what it is without Slate.
- **Import puts it back as itself**: same id, same revision, same media, served again. The project returns to the host
  list, so a deleted film can be restored from its archive.
- **Import refuses to overwrite**: an archive whose project is already on this host is a conflict, not a silent
  replacement — a backup must not destroy work done since it was taken.
- **A missing tool says how to install it.** Every service carries the page to download it from and the version Slate
  relies on, shown in the health row when it is red or amber - a red dot alone tells you nothing to do.
- **7-Zip is in the health panel**, discovered like every other tool, with `SLATE_7Z_PATH` as the escape hatch. A host
  without it says so plainly instead of failing halfway through a backup.
- **The archive is verified before anything is written**: one root folder, no links, no paths outside itself, and a
  manifest that agrees with the project document.

## Reference images can reach a remote model

- **A reference travels as bytes, not as a localhost URL.** Providers that fetch a URL can now be given one: images
  under the provider's inline limit go in the request as a data URI, and anything larger is uploaded through the
  provider's own file API — fal's two-step upload, which hands back a URL fal can fetch.
- **The transport is declared, per provider**, like auth: inline or inline-then-upload, the inline ceiling, and the
  upload endpoint with its body template and response paths. Setup carries the fields and the card states the policy.
- **"Test upload" proves it** with a 64×64 image, so the file API and the credential are checked before a shot depends
  on them.
- **Nothing is silently dropped**: a reference too large for an inline limit with no upload declared is reported —
  in preview as a warning with its size and the limit, and at call time as a coded refusal.
- **Preview says what would happen without moving bytes**: the size, the rung, and where the reference lands in the body.

## A project can be deleted, and its name is the guard

- **Only an owner can retire a film**, and only by typing its name. The check is inside the operation, so an API call
  with the wrong name is refused exactly like a mistyped form — the form is not the guard.
- **The folder is kept by default.** Deleting removes the project from this host: it leaves the picker and the list,
  but its media, exports and documents stay on disk, so the decision can still be undone by hand. Turning the option
  off deletes the folder itself.
- **Creating a project registers it from the operation**, so a film made from the CLI or MCP is listed beside one made
  in the browser, and deleting unregisters it the same way.

## A project is created with its shape, rate, models and look

- **Creating a project asks for the decisions that shape everything after it**: aspect ratio, frame rate, resolution,
  the model profile it runs on, and a style sheet from the app library. They are stored on the project instead of being
  assumed by the page that happens to run first.
- **The shape is used, not decorative.** Stills are generated at the project's size, the cut is rendered at that size
  and the project's frame rate, and a delivered master's manifest records the settings it was made to.
- **A style chosen at creation is cloned into the project** and applied to every entry that names no style of its own,
  so a look is chosen once rather than for each character.
- **The app library and the model profiles are readable before a project exists** — `library.styles` and
  `ai.bindingsets` answer at host level, which is exactly when a new film needs them.

## Sheets you edit, and one reference image per sheet

- **A sheet is edited, not rebuilt.** Opening a sheet starts from the items already published, and generating
  candidates adds the new images to that same set — a second pass refines the sheet instead of throwing it away.
- **Every item has a type**: a head rotation or a kind, `disabled` to keep it out of the reference image, or `delete`
  to remove it when the sheet is published.
- **Publishing composes one reference sheet** from the active items: a single tiled image, and that is what a shot, a
  scene backdrop and the app library actually share. Disabled items stay listed but out of the picture; deleted ones
  are gone.
- **The version only advances on publish**, so a shot pinned to v3 is not made stale by an edit that is still in
  progress.
- **A pushed entry carries its reference sheet** to the app library as the item's cover, and a pull brings it back.

## Model profiles, chosen per project

- **A binding set is a profile, and there can be any number of them.** "Draft, cheap" and "Final, FLUX" are two sets
  over the same endpoints, each naming the endpoint that serves each capability. Setup lists them as cards, each with a
  selector per capability, and one of them is the host default.
- **A project picks the profile it runs on**, from a Models control on its own page; left on `host default`, it follows
  the installation's default set. The choice is a project write, so it is committed and attributable like any other edit.
- **The choice decides the model.** Resolution runs your set, then the host default, then any endpoint of that
  capability — and Preview names the profile that chose the endpoint, so you can see which model a film would call.
- **Deleting an endpoint prunes it from every profile**, so no set keeps a dangling id.
- **Existing configurations migrate**: a single flat binding map is read as one "Default" set, so nothing is lost.

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
  never calls the network — and it is retired as soon as the provider or model it described is edited, so it cannot
  claim a scheme the connection no longer uses.
- **Keys are write-only.** Setup can replace a key but never display it, and only the owner can open the tab at all.
- **A connection can be edited or deleted.** Edit opens on what is stored — host, kind, auth header and format — and a
  blank key field keeps the credential already held, with a checkbox to forget it on purpose. Deleting a provider takes
  its models, the profile bindings that named them and the stored key with it; the confirmation names them and the
  notice reports what actually went.
- **A model can be edited or deleted from its row.** Edit opens on the stored call — method, path, body template and
  parameter declarations — and saving keeps the same endpoint rather than adding a second one. Deleting a model leaves
  the host and its key standing, clearing only the profile binding that named it.

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
