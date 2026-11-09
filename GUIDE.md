# Slate × DeepSeek Harness — the AI film workflow, start to finish

This walks the whole process with **DeepSeek Harness (DSH) as the orchestrator**. DSH plans, calls the tools and runs the
loop; Slate is the system of record — production plan, library, takes, provenance, budget, review; OpenShot, Blender,
Audacity, FFmpeg, ComfyUI and fal are the services. It follows one 90-second film — *The Last Light*, a lighthouse
keeper's final night — from a sentence to a delivered master.

---

## 0. The three layers

| Layer | Who | Does |
|---|---|---|
| **Director** | you | decides what the film is, approves spend, judges performance and rhythm |
| **Orchestrator** | **DSH** | runs the loop, calls Slate and the tools, reports progress, asks before spending |
| **System of record** | **Slate** | story, shots, frames, takes, provenance, budget, review, workspace |
| **Execution** | OpenShot, Blender, FFmpeg, Audacity, ComfyUI, fal | cut, previz, mix, generate |

You talk to DSH. DSH talks to Slate and the tools. Slate remembers.

---

## 1. Setup, once

1. **Install the services** (Slate checks them on first run):

   | Service | Required | Why |
   |---|---|---|
   | Slate | yes | plan, library, takes, provenance, jobs |
   | FFmpeg (bundled) | yes | probe, encode, mix, subtitles |
   | mpv (bundled) | yes | reliable playback; the webview is not a monitor |
   | OpenShot 4.1+ | recommended | `openshot-cli` cut and export |
   | MLT `melt` | fallback | headless assembly |
   | Blender | previz | sets, camera, blockout, VFX, titles |
   | Audacity | optional | the human audio pass |
   | ComfyUI | optional | local generation |
   | fal key | if no GPU | cloud generation |

2. **Open the project folder as a DSH workspace.** The folder is the project: story, production document, media, takes,
   previz, cut, render, deliver.

3. **Connect Slate to DSH.** Slate exposes its operations as MCP tools (or the `slate` CLI if the harness does not speak
   MCP). DSH sees `story.*`, `shot.*`, `frame.*`, `take.*`, `render.*`, `review.*`.

4. **Load the `slate-production` skill.** The skill holds the workflow, readiness rules, approval gates and command
   patterns. Without it, the agent guesses; with it, it follows the process. This is the same pattern as a modelling skill
   next to modelling tools: tools give mechanics, the skill gives judgement.

5. **Run the service check.** DSH calls Slate's capability probe and the shells:

   ```bash
   slate capabilities --json
   openshot-cli --version
   melt --version
   blender --version
   ffmpeg -version
   mpv --version
   ```

   Green / amber / red per service. Amber means installed but unverified; red means the fallback is in use. DSH must report
   which path it will take, not discover it mid-render.

---

## 2. The rule that keeps it sane

- **DSH orchestrates; Slate records.** DSH never hand-edits the project or production JSON. It calls operations.
- **Money goes through Slate.** Any billable generation or render is a Slate job, so budget, quotas and provenance are
  enforced in one place. DSH asks for approval before a batch.
- **Free compute can go through DSH.** Blender renders, FFmpeg passes and local scripts may run directly; the results are
  attached to Slate with provenance (`blockout.attach`, `take.attach`).
- **One writer at a time.** DSH takes the `production` writer seat; if you are editing in Slate, it waits or works on
  `timeline`. The app shows who holds the pen.
- **Slate is the memory.** DSH's context window is not. Projects outlive sessions; the production document, sheet pins and
  take provenance are what let a new session continue.

---

## 3. The shape

Five phases, sorted by **how expensive it is to change your mind**:

```
IDEA → STORY → PREVIZ → GENERATE → FINISH
minutes  cents  minutes   dollars    hours
```

Everything before generation is cheap to redo. The agent's job is to keep you in the cheap half; your job is to decide.

---

## 4. Step 0 — Project and service check

**You:** "Start a 90-second film, 16:9, budget $200, look: damp stone, sodium light, one warm window."

**DSH:** creates the project, runs the service check, sets the budget ceiling, reports the fallback path (e.g. "OpenShot CLI
detected; `melt` available; Blender 5.2; no local GPU, fal configured").

**What you see:** the workspace folder and a health panel.

**Cost:** free.

**Watch out:** on Linux, do not install OpenShot or Audacity from Snap/Flatpak for this workflow — the sandbox blocks the
CLI's access to the project and its pipes. Use PPA, `deb` or AppImage.

---

## 5. Step 1 — The five-line story

**You:** "Pitch me three five-line stories for a lighthouse keeper's last night before automation."

**DSH:** drafts three versions of the five lines — situation, desire, conflict, change, result — not three loglines. You
pick one and edit it in plain language; DSH calls `story.update`.

**What you see:** the five lines, and later the scenes that carry each.

**Cost:** cents.

**Why:** the five lines take a minute to change; a script draft ten; a shoot a week.

**Watch out:** if a line needs two sentences, the idea is not settled yet.

---

## 6. Step 2 — Screenplay

**You:** "Draft it in Fountain. Elias doesn't speak until the last scene. The automation arrives earlier."

**DSH:** drafts, then returns anchored patches you accept or reject; every revision is kept. It estimates runtime from
pages and from dialogue at speaking pace; you choose which drives the target.

**Cost:** cents per pass.

**Watch out:** don't over-polish prose you haven't heard yet. Two pages of description may be twelve seconds of screen
time.

---

## 7. Step 3 — Breakdown and shot list

**You:** "Break scene 3 into shots. Master first, then coverage. Keep it under nine."

**DSH:** proposes a shot list with size, angle, move, duration, job and a readiness column; adds a coverage plan; calls
`shot.create` and `coverage.apply`. You edit: "the reveal is a slow push"; "lose shot 7".

**What you see:** the shot list and what each shot is missing.

**Cost:** minutes.

**Watch out:** past ~12 shots for 90 seconds, you are writing a longer film than you budgeted.

---

## 8. Step 4 — Sheets and pins

**You:** "Pull the keeper from the library. Give me a new lighthouse interior and lantern sheet."

**DSH:** generates views (front, three-quarter, profile, hands, costume) via fal or ComfyUI, attaches them, and pins the
versions. Measurements are recorded — the keeper's height is what Blender uses to scale the proxy.

**What you see:** a sheet per entity, with consent/licence fields that must be filled before final use.

**Cost:** cents per view.

**Watch out:** a sheet is not a mood board. It is a contract.

---

## 9. Step 5 — Previz and the animatic

**You:** "Build the lighthouse interior from the sheet, then block shots 3A–3D. Render the blockout."

**DSH:** uses its Blender tools to build the set, place the keeper proxy, set camera rigs and render the blockout, then
attaches the result (`set.attach`, `blockout.attach`). You review the floorplan and check views; if the geography is wrong,
reject it; if it is close, open the `.blend` and fix it yourself. DSH then cuts the animatic at real durations with a
scratch voice and temp music.

**What you see:** a floorplan, check renders, camera rigs, a correctly timed animatic.

**Cost:** minutes of local render; changing the animatic is free.

**Why:** this is where you direct — pacing, rhythm, staging — before paying for pixels.

**Watch out:** don't fall in love with a blockout rhythm the model cannot reproduce.

Under the hood, DSH runs something like:

```bash
blender -b previz/set.blend -P scripts/render_shot.py -- --rig rig_3a --out previz/blockout/3a.mp4
```

For simple scenes, skip Blender: DSH generates 3–4 board panels per shot, you pick one, and the animatic is built from
stills.

---

## 10. Step 6 — Frames

**You:** "Give me first and last frames for every shot; start from the blockout; damp stone, sodium glow."

**DSH:** refines frames from the blockout basis, checks the pair (subject size, lighting, lines), and reports readiness.
When an endpoint is missing, aspect is wrong, or the pair disagrees, it says which check failed — it does not proceed.

**Cost:** cents per frame.

**Watch out:** a first and last frame that disagree produce a morph, not a move.

**Camera match, when a frame is better than the blockout:** DSH brings the frame into Blender, you (or it) mark vanishing
points and horizon, scale with a known height, adjust the set until the camera view lines up, render an overlay at 50% and
check. Saving creates a new set version; everything built on the old geometry is marked stale.

---

## 11. Step 7 — Draft takes

**You:** "Three drafts for 3B, 720p, five seconds. Stop before finals."

**DSH:** estimates cost, asks for approval, submits to fal or ComfyUI, polls, downloads, hashes and attaches the takes. It
builds a contact sheet for the scene.

**Cost:** a fraction of a final take.

**Why:** most uncertainty is motion and performance. Drafts find a bad idea for a tenth of the price.

**Watch out:** a draft that looks right at low resolution can fall apart at final.

---

## 12. Step 8 — Final takes

**You:** "Final for 3B, three takes, same seed family. Show me the cost first."

**DSH:** shows the estimate, takes your approval, generates, attaches provenance — frames, sheet versions, endpoint, seed,
cost — and presents the takes side by side. You pick one and say why; DSH records the selection.

**Cost:** dollars per take, enforced by Slate's budget.

**Watch out:** three takes is healthy. If six fail, change the frame or the shot, not the seed.

---

## 13. Step 9 — The cut

**You:** "Assemble the selected takes, keep the animatic timing. Render a preview."

**DSH:** builds the **OTIO cut spec** from the selections and either drives OpenShot or renders headless:

```bash
openshot-cli session start
openshot-cli file import ./takes/3a/take02.mp4
openshot-cli clip add <file-id> --position 0 --start 2.0 --end 7.0
openshot-cli export start ./render/cut_v1.mp4 --wait
```

Fallback:

```bash
melt ./cut/cut_v1.mlt -consumer avformat:./render/cut_v1.mp4 vcodec=libx264 crf=18
```

**What you see:** the cut in **mpv**, in its own window, full height, on the other monitor if you have one. The timeline
workspace gets the full screen.

**Cost:** free to recut.

**Optional handoff:** export OTIO/EDL/XML, fine-cut or grade in Resolve/Premiere, bring the result back as a new cut
version with its render — never a silent two-way merge.

---

## 14. Step 10 — Finish

**You:** "Mix the dialogue and music, add subtitles, upscale to 4K, and give me a QC report."

**DSH:** generates or collects TTS/music, aligns subtitles (WhisperX), mixes with FFmpeg/SoX, hands a copy to Audacity if
you want the manual pass, runs Real-ESRGAN/RIFE, and checks black frames, loudness, duration, codec.

**Cost:** hours, mostly yours.

**Watch out:** sound exposes cuts that picture hides.

---

## 15. Step 11 — Review and delivery

**You:** "Send a review link, then export the master."

**DSH:** creates a review link with timecoded comments and approve / needs-work, records approvals against the version,
then exports with the target codec, bitrate, frame rate and aspect ratio, and writes the provenance manifest.

"Final" is a status, not a filename.

---

## 16. What DSH runs

| Stage | DSH calls | Tool |
|---|---|---|
| Story / script | `story.*`, `screenplay.*` | Slate + DeepSeek |
| Breakdown | `shot.*`, `coverage.apply` | Slate |
| Sheets / frames | `take.generate`, `frame.attach` | fal / ComfyUI |
| Previz | `set.attach`, `blockout.attach`, Blender tools | Blender |
| Cuts | `clip.*`, `render.*` | OpenShot / melt |
| Finish | `finish.*`, `take.attach` | FFmpeg / Real-ESRGAN / RIFE |
| Review | `review.*` | Slate |
| Everything | `job.get`, `graph.stale` | Slate |

**Approval gates.** DSH asks before: a batch of frames; a batch of drafts; final takes; a render/export; any destructive
change. Slate enforces the budget even if DSH forgets.

---

## 17. Sessions and continuity

- **Work scene by scene.** A long film does not fit in one context window. DSH handles a scene, Slate remembers; the next
  session starts from the production document, not from chat history.
- **Start each session with a state read:** `project.summary`, `graph.stale`, `shot.get` for the scene you are on. DSH
  should ask "what changed?" before doing anything.
- **Scene handoff:** when you move on, DSH writes a short intent note on the scene ("locked blocking; performance still
  soft on 3B"). The next session reads it.

---

## 18. When something fails

| Failure | DSH does | You see |
|---|---|---|
| OpenShot CLI missing or unstable | falls back to `melt`, says so | a note on the render |
| `melt` unavailable too | FFmpeg concat, hard cuts only | a warning that transitions are unavailable |
| Blender missing | generated boards only; no 3D previz or camera match | readiness says "no set" |
| No GPU | cloud generation + CPU finish | cost estimate increases |
| Endpoint rejects content | stops, surfaces the reason; does not silently try another model | the rejection text |
| Budget exhausted | stops before submitting; lists what is pending | the remaining shot list |
| Stale upstream | refuses to generate from a stale frame; offers to refresh | the stale node and its cause |

DSH never hides a fallback. Slate never lets a bad state through.

---

## 19. Cross-platform

DSH runs on Windows, macOS and Linux; the differences are in the services, and Slate's registry handles them.

- **Windows** — argv arrays, never shell strings; long paths; OpenShot in Program Files or `%LOCALAPPDATA%`.
- **macOS** — app bundles under `/Applications`; Homebrew paths; TCC prompts on first file access; notarised, not sandboxed.
- **Linux** — `deb`/AppImage, not Snap/Flatpak for driven tools; `QT_QPA_PLATFORM=offscreen` for headless Qt.
- **ARM64** — Blender and FFmpeg fine; OpenShot mac/Win ARM pending, Linux ARM64 available; `melt` is the fallback.
- **No GPU** — cloud generation, CPU finish; the workflow does not dead-end.

---

## 20. Cheat sheet

```
0   project        runtime, ratio, budget, service check
1   story          five lines → screenplay → revisions
2   plan           breakdown → shot list → coverage → readiness
3   sheets         character / location / prop, pinned + consent
4   previz         Blender set or boards → animatic → LOCK THE CUT
5   frames         first|last pairs, blockout → refined → final
6   drafts         cheap motion tests, compare
7   finals         takes, seeds, choose, note why
8   cut            OTIO → OpenShot / melt → mpv review
9   finish         sound, grade, titles, subtitles, upscale
10  deliver        encode, verify, provenance, approval
```

**Things to say to DSH**

- "Read the project state and tell me what's stale."
- "Draft three five-line stories for this premise."
- "Break scene 3 into shots; master first; under nine."
- "Build the set and block 3A–3D; render the animatic."
- "Give me frames for 3A, 3B, 3C; flag any pair that disagrees."
- "Three drafts for 3B; stop before finals."
- "Assemble what's selected and render a preview."
- "Mix it, subtitle it, and give me a QC report."

**The one rule:** spend pixels last, spend judgement first.
