# 0003 — A project archive is the folder plus a manifest

## Context

The project folder *is* the film: documents, media, history and exports. A backup therefore has nothing to synthesise —
it is a copy — but it does need three properties: it must be one file (a folder of thousands of media files is not
something anyone copies reliably), it must be inspectable by a person, and an import must be able to prove what it is
holding before it writes anything into a host.

Compression is beside the point: PNG, MP4 and WAV are already compressed, so a slow maximum-ratio archive buys a few
percent and costs minutes on a real project.

## Decision

**Export writes one 7z containing the project folder as it stands, plus a manifest inside it.**

```
<project folder>/
  project.json               the document, as it is
  production.json
  story/  media/  cut/  exports/
  .slate/
    commits.jsonl            the history travels too
    export-manifest.json     ← written for the duration of the export, removed afterwards
```

- **7-Zip, discovered not assumed.** It joins the service catalogue (`SLATE_7Z_PATH` overrides), so the health panel says
  whether the host can archive, and an operation that needs it fails with `capability_missing` rather than half a backup.
- **The archive holds exactly one top-level folder**, because 7-Zip stores the path it is given. That is what makes
  extraction verifiable: one directory in, everything else inside it.
- **The manifest is the identity**: format, version, export time and actor, the project's id, name, revision, settings,
  budget and binding set, and counts of scenes, shots, entities, takes, assets and cut items. It names the film without
  opening a single document, and `project.import` refuses an archive whose manifest and `project.json` disagree.
- **Import verifies before it installs**: one root, no symbolic links, no path outside the unpacked folder, a manifest
  that parses, a document that parses, and an id that matches. Then it copies only the entries a project is made of.
- **Import refuses a project that is already here** (`conflict`). Restoring over a film that has moved on since the
  archive was taken would destroy newer work, and that is not a decision an import may take by itself.
- **The cache is excluded** (`-xr!cache`, by name so it is portable). Everything derived is rebuilt; everything else
  travels.
- **Compression is `-mx=1`.** Media is already compressed; a backup you take often should be fast.
- **The copy path is the browser's.** Export writes to the host's exports folder; taking the file anywhere else is the
  browser's save dialog, and importing is the browser's file picker. Slate never asks a person to type a host path, and
  the routes that serve those bytes are names-only (`/api/exports/:name`, `/api/imports`), owner-only, and never
  echo a path back.

## Consequences

- A film can move between hosts, and a deleted project can be restored as itself: same id, same revision, same media,
  with its history intact.
- The archive is self-describing, so a person with 7-Zip can open it and read what it is without Slate.
- A restored project keeps its id, so importing it into the host it came from is a conflict by design — delete the old
  one first. This is deliberate; a "replace" flag can be added when someone needs one, with the decision made openly.
- Storage is duplicated on export: a 40 GB project that is exported twice occupies 120 GB until the older archive is
  removed. Slate does not manage that; the destination folder is the operator's.
- Archive names carry the slug, the project id prefix and the revision, so two exports of the same film do not collide.

## Alternatives

- **Zip** — available in Node without a dependency, but the same size as 7z for media, and the request was 7z.
- **Copy the folder** — no tool needed, but it is not one file, cannot be handed over, and cannot be verified as a unit.
- **A database dump** — wrong shape: the documents are the truth, and the media is most of the bytes.
- **Upload to object storage** — a network dependency for a local backup, with credentials and egress; out of scope.
