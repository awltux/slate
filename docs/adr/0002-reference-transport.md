# 0002 — A reference leaves the machine as bytes, not as a URL

## Context

Slate is local: media is served from `127.0.0.1` behind a session cookie, and a host path never enters a document or a
response. Generation services are remote, and the ones that matter take a **reference image as a URL they fetch** — fal's
`image_url`, Replicate's file inputs, most image-to-video APIs. A localhost URL is unreachable from their side, so the
reference has to travel with the call.

Three ways to do that:

1. **Inline** — send the bytes in the request as `data:<mime>;base64,…`. No second service, no public URL, but +33%
   size and a practical ceiling of a few megabytes; some APIs accept it (Replicate documents it), some do not.
2. **The provider's own storage** — fal exposes a two-step upload: `POST …/storage/upload/initiate` → a presigned
   `upload_url` plus the public `file_url`, then `PUT` the bytes. The model then fetches a URL fal itself created.
3. **Somewhere public** — a tunnel to the local port, or object storage with presigned URLs. Works for video, costs a
   process or an account, and makes the machine reachable for as long as the render runs.

File-sharing services (Drive, Dropbox) were considered and rejected: OAuth apps and refreshable tokens, share links
that are HTML interstitials rather than fetchable files, sharing state that can flip mid-production, and a second party
receiving the film's references on top of the model provider.

## Decision

The transport is **declared per provider**, like auth, and defaults to `inline`:

```
Provider.reference
  transport       "inline" | "upload"
  maxInlineBytes  the ceiling for putting bytes in the body (default 1.5 MB)
  upload          { url, method, body template, uploadUrlPath, fileUrlPath } | null
```

- `stageReference()` decides: fits the limit → data URI; otherwise the provider's upload → the returned `file_url`;
  otherwise **refuse with a code** and a reason. The reference is never silently dropped: a call that claims to be
  conditioned on an image and is not would be a lie about what the model saw.
- The decision is available without moving bytes (`planReference`), so `ai.preview` can say *what would happen* and how
  big it is; preview still never calls the network.
- The upload's initiate body is a template (`{{contentType}}`, `{{bytes}}`, `{{fileName}}`) because every provider
  names these differently; an exactly-single placeholder keeps its type, so the byte count goes out as a number.
- `ai.reference.test` uploads a 64×64 image through the declared transport. It exists so the file API and the
  credential can be proved before a shot depends on them, and so the upload path is reachable rather than latent until
  generation calls a network.
- Network access is a port (`OpContext.http`), so every test is offline and a test context that was not given a fake
  **throws** instead of reaching the internet.

Out of scope, deliberately: `public-base` (tunnel / object storage). Nothing needs it yet — images inline or upload —
and until something does, it is a hole in the machine that nobody asked for. It is the documented answer for large
video references and for a LAN ComfyUI when that slice arrives.

## Consequences

- A provider is now three declarations: transport, credential, **and how bytes reach it**. Setup carries the fields;
  the card states the policy and offers the test upload.
- fal references accumulate on fal's side: their API exposes no delete.
- A reference larger than the inline limit, from a provider with no upload, fails at planning time with
  `invalid_input` and the numbers that explain it — visible in preview as a `reference_too_large` warning.
- The inline ceiling is per provider, so a local ComfyUI (no limit, data URIs) and fal (upload beyond 1.5 MB) can
  coexist on one host without a global switch.

## Alternatives

- **Always upload** — one code path, but it makes a remote round-trip mandatory even for a 60 KB thumbnail and forces
  every provider to have a file API, which many local ones do not.
- **Always inline** — simplest, but a 4K sheet composite cannot go in a body, and video references never would.
- **A tunnel by default** — the reference would be fetched from the operator's machine on every call; latency and
  exposure for the whole render, to avoid one upload.
