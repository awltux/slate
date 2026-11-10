# Slate — architecture

Living design document. `AGENTS.md` governs how changes are made; this file governs what the system is.
A change to a non-negotiable needs an ADR in `docs/adr/` and an edit here.

---

## 1. Purpose

Slate is the **system of record for an AI film**: the story and its revisions, the shot plan, the reference
sheets and their pinned versions, the frames that condition generation, the takes and their provenance, the cut,
the budget and the review record.

It is not an editor, a renderer, a model host or a NLE. Blender, OpenShot, `melt`, Audacity, FFmpeg, ComfyUI and
fal own execution. Slate owns intent, money and evidence.

> **Spend pixels last, spend judgement first.**

Everything below exists to make the cheap half of the film fast to change and the expensive half hard to reach
by accident.

---

## 2. Vocabulary

These words have exactly one meaning in code, UI, docs and commits (`AGENTS.md` §6.2).

| Term | Means | Never means |
|---|---|---|
| **Project** | one film: a folder with documents, media and history | a workspace/tab |
| **Scene** | a screenplay scene, identified by a stable `sceneId` | a timeline section |
| **Shot** | the intent to show something: size, angle, move, duration, job | a clip on a track |
| **ShotVersion** | the spec at a point in time; takes point at one | a take |
| **Frame** | an image with a `role` (board/first/last/plate/match) and a `grade` (sketch/blockout/rough/refined/final) | a video frame |
| **Sheet** | a reference for an entity (character, location, prop), versioned | a mood board |
| **Set** | a 3D location version (`.blend` + manifest) | a scene |
| **Blockout** | a rendered previz pass: animatic, stills, camera metadata | a take |
| **Take** | one generation attempt with its provenance | a render job |
| **Cut** | an ordered list of selections (shot, take, in/out) | a rendered file |
| **Clip** | one placement inside a cut | a shot |
| **Render** | an encode of a cut, or of a range | a take |
| **Job** | any long-running unit of work and spend | a request |
| **Node** | any graph entity with a content hash | a UI element |

---

## 3. System context

```
                    ┌──────────── browser (local or remote) ────────────┐
   director ───────►│  Write · Plan · Previz · Shoot · Edit · Finish     │
   editor           │  Review (read-only, tokenised)                     │
   reviewer ───────►└───────────────▲───────────────────────────────────┘
                                    │ HTTP (ops), SSE (events), /media (signed)
                    ┌───────────────┴───────────────────────────────────┐
   agent (DSH) ────►│  slated — app server on the studio host            │
   CLI/CI   ───────►│  auth · ops · jobs · watchers · static UI          │
                    └───────────────▲───────────────────────────────────┘
                                    │
              ┌─────────────────────┴─────────────────────┐
              │  kernel + adapters                         │
              │  workspace · graph · ledger · jobs ·       │
              │  catalog · assets                          │
              └─────────────┬──────────────────────────────┘
                            │ argv arrays, no shell
        ffmpeg · mpv · openshot-cli · melt · blender · audacity · fal · comfyui
```

**Topologies**

| Topology | Host runs | Client needs |
|---|---|---|
| Single user | daemon + tools on one machine | a browser on `127.0.0.1` |
| Studio (office) | daemon + tools on the workstation with the GPU | a browser on the LAN, a user account |
| Remote reviewer | same | a browser anywhere, a `/r/<token>` link |

Desktop-only tools never leave the host. A remote client is always just a browser.

---

## 4. Process model

- **`slated`** — the app server: HTTP op routes, SSE, static UI, signed media, review links, job supervisor,
  file watchers. One per host; serves many projects.
- **`slate`** (CLI) — every operation, embedded by default; talks to a running daemon when one is present.
- **`slate mcp --stdio`** — MCP over stdio for a local agent; a thin client, no state.
- **`SLATE_HEADLESS=1`** — forces embedded mode. The same code path, no HTTP. Proven by `gate:headless`.

Nothing may require the daemon for correctness. A job started with the CLI detached supervisor survives the
CLI exiting; documents and the commit log are the durability boundary.

---

## 5. Data model and the graph

### 5.1 Files

```
<project>/
  project.json            settings, budget, chains, counters, format version
  production.json         scenes, shots, versions, frames, takes, sets, cuts, reviews, notes
  story/
    five-lines.md
    screenplay.fountain
    revisions/<n>.json    anchored patches + author + intent
  cut/<id>.json           selections (the canonical cut)
  media/{source,boards,generated,blockouts,audio,library}/
  work/                   producer quarantine: agents write here; nothing else reads it
  exports/
  .slate/
    commits.jsonl         append-only; authority for recovery
    history/<commit>/     previous document pair
    jobs/<jobId>.json     durable job records
    ledger.jsonl          estimates, approvals, reservations, settlements
    capabilities.json     probe results + resolved chains, with verifiedAt
    lock/                 advisory presence seats
    cache/                thumbnails, proxies, contact sheets (disposable)
```

All paths in documents are relative to the project root. Absolute paths never enter a document or a response.

### 5.2 Nodes and hashing

Every plan entity is a node with `id`, `hash`, `builtFrom[{id, hash}]`, `builtAt`, `producer`.

- `hash` is computed by `domain/canonical.ts` over canonicalised content: sorted keys, normalised newlines,
  relative paths, media by SHA-256 of bytes, prompts by compiled output including the compiler version.
- `stale(n) = n.builtFrom.some(input => currentHash(input.id) !== input.hash)` — derived on read, never stored.
- Invalidation is **scoped**: replacing `keeper@v2` marks only nodes that pinned it. A model upgrade flags takes
  `deprecated`, never `stale`.
- `impact.plan(node, change)` reports the blast radius and issues a confirm token for destructive writes.

### 5.3 The cut is selections

A cut is a list of `{ shotId, takeId?, inSec, outSec, conform?, transition? }` plus audio tracks. It references
ids, never paths. OTIO, EDL, FCPXML and `.osp` are generated projections, hashed and logged when produced.
`timingSource` records whether the cut was cut to the animatic or to takes; a take whose duration differs from
its slot requires an explicit `conform: trim | retime | hold`.

Imported NLE cuts are immutable `kind: "imported"` records with a best-effort take mapping. They never merge.

### 5.6 Entities, sheets, scenes and sets — where a character and a place are defined

A character is not defined by a prompt and a location is not defined by a slugline alone. Both are **entities with
versioned sheets**, defined once in the library and pinned by the work that used them.

```
Entity (character | location | prop | style)
  ├── description          the director's words
  ├── prompt               the agent's draft, built from the description with flourish added
  ├── styleId ─────────────► a style sheet applied to this entity's generations
  ├── identity  SheetVersion (v1..vn)
  │      ├── images[]      6 head rotations for a character · views for a place or a thing
  │      ├── measurements  heightM (drives the Blender proxy scale)
  │      └── rights        licence · likenessConsent
  ├── variants[]           wardrobe (a character) · states (a location, a prop)
  │      └── { name, description, prompt, sheet: SheetVersion }
  └── candidates[]         generated options awaiting a decision
```

**The process is always the same shape:**

```
description ──(agent)──► prompt ──(generate)──► candidates ──(director picks)──► sheet version
```

1. Someone creates the entry and writes a **description** in their own words.
2. An agent turns that into a **prompt** — the flourish, the camera language, the negatives — and stores it beside the
   description. Both are kept, so a sheet can be traced to the sentence and the prompt that produced it.
3. `entity.generate` renders **candidates** from the prompt, with the entity's style sheet applied. A batch is priced
   and reserved before it runs; it is the cheapest paid step in the system.
4. The **director picks** one or more candidates and assigns each a role. That publishes a sheet version — no free-text
   editing, no "close enough".

- **A character's identity sheet is six head rotations** (front, three-quarter left, profile left, back, profile right,
  three-quarter right). A partial selection publishes, but reports what is missing, because a usable sheet with five
  angles beats no sheet at all.
- **A wardrobe item is a variant with its own prompt.** "Storm coat, oilskin, soaked, hood down" is generated and
  selected independently of the identity sheet, because an outfit is a different picture, not a different sentence.
- **A location's states are variants too** — run down, repainted, extended — and a prop's wear states the same way.
- **A style sheet is just another entity** (`kind:"style"`) whose images carry palette, texture and light. Any entity
  may point at one; generation records which style it used.
- **A location entity can be materialised as a set**: the Blender file and manifest are the location made geometric,
  which is why `set.attach` binds entities to objects (`entityMap`).
- **A scene** is a screenplay unit — slugline, synopsis, body — that carries the **library items in it**
  (`entityIds`: the place, the people, the things, any number of any kind). The first location among them is the
  backdrop: when a shot has no frame of its own, the cut falls back to that location's cover image rather than dropping
  the shot. Two scenes in one place share the location sheet and usually one set version.
- **A frame is generated, not drawn.** `frame.generate` renders a shot's start or end still from the scene's items and,
  when one exists, from the previz blockout that fixes the geometry. Each frame records the `entityIds`, the sheet
  versions they were pinned at, and the blockout it was conditioned on (`firstSource` / `lastSource`), so it can be
  reproduced and a mismatch can be blamed on the right input.
- **The shoot runs between the frames.** A take is generated from an approved estimate and records `fromFrameId` and
  `toFrameId`; the renderer moves from the start frame to the end frame over the shot's duration.
- **A shot** lists the entities in frame (`entityIds`) and **pins** the sheet versions it was conditioned on:
  `pins: { entityId: sheetVersion }`.

**Two scopes, one shape.** A project has a library of the entities it uses. The host has a library of items shared by
every project: pushing copies an entity (images included) into it as a versioned item, importing brings a copy back.
A project entity is always a *clone* — it records which library version it came from, and its own edits never touch the
shared item — so "newer" is a version comparison, not a conflict.

**Deleting is a reference question.** An entry can be deleted only when nothing points at it: a shot that lists it, or
another entity styled by it. The refusal names what is using it, because "cannot delete" without a reason is a puzzle,
not an error.

**The chain, with versions at every step:**

```
location sheet v2 ──► set v3 (.blend + manifest) ──► rig ──► blockout stills (first / last)
                                                                   │
character sheet v4 (front, 3/4, close-up) ─────────────────────────┼──► refined frame (img2img on the blockout,
                                                                   │    conditioned on the character views)
                                                                   ▼
                                                                 take ──► cut
```

Every arrow records the version it consumed. Edit the character's face — v4 → v5 — and every frame and take pinned to
v4 becomes stale with the cause `character keeper sheet v4 → v5`; nothing else is invalidated. That is the whole point
of pinning: reproducibility is a version, not a hope.

**Refinement is conditioned, not re-prompted.** A frame refined from a blockout is generated with the blockout render
as its structural basis (depth/normal/canny) *and* the character sheet views as its identity basis. Recording both in
the frame's provenance is what lets the same frame be reproduced after a model upgrade, and what makes "the keeper
changed between shots 3 and 7" a diagnosable fact rather than an opinion.

### 5.7 AI connections are declared, not coded

Every generation API is REST but no two agree on anything: fal has one key and a route per model, OpenAI has one key
and one route with many models, a local ComfyUI has no key and a graph id. Writing an adapter per provider would mean a
deploy for every model. So the AI layer is three declarations and one renderer:

```
Provider   (transport)   id · name · baseUrl · auth { header, scheme: "Key {{key}}" } · credential
Endpoint   (a model)     provider · capability · method · path · params[] · body template · resultPath
Binding    (a profile)   id · name · capability → [endpoint ids], first that resolves wins
```

**A binding set is a profile, and a project picks one.** "Draft, cheap" and "Final, FLUX" are two sets over the same
endpoints; `project.aiBindingSetId` says which a film runs on, and null means the host default. Resolution is
`project set → host default → any endpoint of that capability`, so a set that loses an endpoint degrades a film instead
of breaking it. This is why a theme or a budget can change the models without touching the endpoints or the code.

**The body template is the whole trick.** An endpoint declares the parameters it accepts (`num_images`, `strength`,
`sync_mode`), and its body is ordinary JSON whose *strings* may reference them:

```json
{
  "prompt": "{{prompt}}",
  "image_url": "{{image}}",
  "num_images": "{{param:num_images}}",
  "enable_safety": "{{param:sync_mode}}"
}
```

- A value that is exactly one `{{param:X}}` placeholder keeps the parameter's **declared type** — `num_images` arrives
  as `4`, not `"4"` — which is why the API field name and the UI field name may differ.
- `{{prompt}}`, `{{image}}`, `{{image2}}` and `{{seconds}}` are the standard slots; everything else comes from `params`.
- `resultPath` (`images[0].url`) says where the artefact is in the response, so the caller never parses a provider's
  envelope.
- `method: GET` sends the rendered body as query parameters instead.

**Preview is the test that costs nothing.** `ai.preview` renders the exact URL, headers and body an endpoint would send,
with the key masked as `••••`; it never calls the network. A new provider is therefore provable offline, in a gate.

**Credentials are write-only.** Keys live in `$SLATE_HOME/ai/keys.json` (mode 600), separate from the provider list, and
no operation returns them — `ai.catalog` reports `hasKey` and nothing more. Only the owner may read or change any of it:
these operations carry `ownerOnly`, which the HTTP surface enforces with a 403 before the registry is reached.

## 6. Identity, concurrency and collaboration

### 6.1 Identity

Host-level users (`SLATE_HOME/users.json`), argon2id hashes, roles `owner | editor | reviewer | viewer`.
Sessions are HMAC-signed httpOnly cookies (12 h); API tokens are hashed, scoped and revocable. OIDC slots in
behind the same session store later without touching operations.

Every write records `actor` (user id, display name, client). Notes, approvals and spend carry the same actor.

### 6.2 Concurrency: node-scoped optimistic

One document does not mean one writer.

1. Each write operation declares `touched: NodeId[]` — the nodes it changes and the derivations it invalidates.
2. Commit records store `touched`, `actor`, `parent`.
3. A write carries `expectedVersion`. If commits since that version have **disjoint** touched sets, the write is
   rebased onto the current document and committed with `rebasedFrom`; if they **intersect**, the write fails
   with `conflict`, naming the overlapping nodes and the other commit, and including a diff.
4. Presence is advisory: who is viewing or editing which node, over SSE with a TTL. It warns; it never blocks.
5. Undo is per user and per commit: revert your own commit when no later commit touched its nodes.

The GUIDE's "one writer at a time" applies to **agent versus app** on the same object, not to two humans in
different scenes.

### 6.3 What collaboration looks like

Presence avatars per page and per object, a live activity feed (commits, jobs, approvals), and "updated
underneath you" on any SSE version bump that touched what you are looking at. The browser holds no document
model to merge: it refetches.

---

## 7. Money

```
estimate.create(shots, tier)  → { estimateId, hash, usd, units, breakdown, expiresAt }
spend.approve(estimateId)     → { token }              TTL 15 min, single use, bound to the estimate hash
take.generate(token)          → reserve → submit → job → settle(refund)
```

- The ceiling and per-gateway quota floor are enforced **at reserve time**, so concurrent submits cannot
  overspend.
- Two currencies in one ledger: USD where priced, units where a subscription pays. Local compute records
  wall-clock and machine, not USD.
- `take.attach` (an externally produced artifact) must carry provenance and cost, or declare `free` explicitly.
- `ledger.jsonl` is append-only and per project: "why is this shot $14?" is answerable from the file.

---

## 8. Jobs and the fallback ladder

Job states: `declared → queued → awaiting_approval → submitted → running → downloading → ingesting → ready`,
with `retrying`, `failed`, `cancelled`, `expired`. Durable record per job; idempotency key per submission;
immediate download (provider URLs expire); hash then atomic ingest.

`job.declare` exists so work an agent runs with its own tools (Blender, FFmpeg) is visible and recoverable.

Every stage resolves to an ordered **chain**, e.g. `assembly: [openshot-cli, melt, ffmpeg-concat]`. The probe
records versions and features; the result carries `via` naming the rung that ran. A fallback is reported, never
silent. No tool present is `capability_missing` with an install hint.

**Discovery.** A tool installed but not on `PATH` is still the tool that will run. Each service declares candidates in
this order: a `SLATE_<SERVICE>_PATH` override, a vendored copy, a discovered install (on Windows, the uninstall
registry — which is how tools on another drive are found), a conventional install folder, then `PATH`. The result
reports the source (`configured path`, `vendored copy`, `installed application`, `common install folder`, `PATH`), so
"found via installed application" is visible rather than implied.

**Amber is usable.** A tool that starts but does not report a version is `amber`, not `red`: it is installed and will
do the work, so a chain uses it and marks the stage unverified rather than silently skipping it for a worse fallback.
Red means the process could not be started at all.

---

## 9. Surfaces and contracts

| Surface | Shape |
|---|---|
| HTTP | `/p/{projectId}/api/op/<name>`, `GET /p/{projectId}/api/events` (SSE), `/media/<assetId>/<variant>?exp&sig`, `/r/<token>`, `/api/session`, `/api/auth/*` |
| CLI | `slate <domain> <verb> [args] --json`, exit codes 0/1/2/3/4/5/6 |
| MCP | server `slate`, snake_case tools → `mcp__slate__shot_get`; long work returns `jobId` |
| UI | React SPA served same-origin; server state only, refetch on SSE |

**Envelope** for every operation: `{ ok, data, version, commit, stale:{added,cleared}, via, warnings[], next[] }`.

### 9.1 How a harness connects

An agent harness (DeepSeek Harness, Claude Code, anything MCP-capable) reaches Slate three ways, all over the same
registry:

1. **MCP over stdio** — the primary path. `slate mcp --root <project>` serves every operation as a tool; DSH shows
   them as `mcp__slate__<tool>`. The server is stateless, so a harness restart costs nothing.

   ```yaml
   - id: mcp-slate
     name: '@deepseek-ai/dsh-mcp-client'
     config:
       serverName: slate
       transport: stdio
       command: slate
       args: ['mcp', '--root', '.']
   ```

2. **CLI** — `slate op <name> --root <dir> --input '<json>'` for scripts, CI and harnesses without MCP. Embedded by
   default, so it works with no daemon.

3. **HTTP** — the same operations over the daemon, for a remote harness or a tool that already speaks HTTP.

**The skill supplies the judgement.** `project.create` writes `.dsh/skills/slate-production/SKILL.md` into the
project, which is where DSH scans for project skills; it describes the order of work, the money rule, and what
readiness and staleness mean. Tools give mechanics; the skill gives process.

**What the agent reads first** is `session.brief`: budget, plan counts, stale nodes with causes, and the next useful
operation. Every write answers with what it invalidated (`stale.added`), so the agent can say what its change broke
instead of leaving the human to discover it.

**Activity is not the integration.** The Activity page renders the commit log for a human: who changed what, and why.
The agent's view of the same facts is `session.brief`, `graph.stale` and `project.history`.

**Errors** are `{ code, detail, retryable }` from one taxonomy: `capability_missing`, `service_unavailable`,
`capability_mismatch`, `budget_exhausted`, `approval_required`, `approval_expired`, `stale_upstream`,
`readiness_failed`, `pair_invalid`, `policy_rejected`, `provider_error`, `conflict`, `unauthorized`, `forbidden`,
`invalid_document`, `media_missing`, `hash_mismatch`, `not_found`.

---

## 10. Security

Loopback by default; non-loopback binds require a configured user and are refused otherwise. CSRF token on
mutations; signed expiring media URLs with range support; asset ids only, never paths; a leak test walks every
operation's output schema. Secrets live in `SLATE_HOME`, never in a project or a log.

---

## 11. Slices

Vertical, demoable, gated. Details and status in `docs/PROGRESS.md`.

1. Boot, auth, health — log in, create a project, see the toolchain and the resolved chain.
2. Story → shots — five lines, screenplay patches, breakdown, shot list with readiness.
3. A cut you can watch — boards into slots, cut, render, play over signed media URLs.
4. Spend with approval — estimate, approve, job, takes, compare, select.
5. Previz — set/blockout manifests, frames, pair checks, animatic.
6. Collaboration — roles, presence, conflicts, per-user undo.
7. Finish — mix, QC, export, provenance manifest.
8. Remote review — tokenised player, timecoded notes, approvals.
9. Polish — library, service install, backup/restore, optional Tauri shell.

---

## 12. Non-goals

No NLE, no renderer, no model hosting, no cloud service, no project management (call sheets, scheduling), no
realtime CRDT collaboration, no node canvas.
