/**
 * The reviewer's page is deliberately one HTML string with inline script: it is the only route that works without an
 * account, so it must not depend on the SPA bundle, cookies or the client's build. Everything it renders arrives from
 * `/r/:token/api/summary`, and it writes notes back through the same token.
 */
export function reviewPage(options: { invalid: boolean }): string {
  if (options.invalid) {
    return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Slate review</title><style>body{background:#0b0d10;color:#e7e9ee;font:16px/1.5 system-ui,sans-serif;display:grid;place-items:center;height:100vh;margin:0}</style>
</head><body><div style="max-width:32rem;text-align:center"><h1>This link is no longer valid</h1>
<p style="color:#9aa3b2">It may have expired or been revoked. Ask for a fresh link.</p></div></body></html>`;
  }

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Slate review</title>
<style>
  :root{--bg:#0b0d10;--panel:#141821;--line:#232936;--text:#e7e9ee;--muted:#9aa3b2;--accent:#f0b429}
  *{box-sizing:border-box}
  body{margin:0;background:var(--bg);color:var(--text);font:16px/1.55 system-ui,-apple-system,Segoe UI,sans-serif}
  main{max-width:64rem;margin:0 auto;padding:1.5rem}
  h1{font-size:1.4rem;margin:0 0 .25rem}
  .muted{color:var(--muted)}
  .card{background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:1rem;margin:1rem 0}
  video{width:100%;max-width:48rem;border-radius:8px;background:#000}
  .shots{display:grid;gap:.75rem;grid-template-columns:repeat(auto-fill,minmax(15rem,1fr))}
  .shot{border:1px solid var(--line);border-radius:10px;overflow:hidden;background:#0f131a}
  .shot img{width:100%;aspect-ratio:16/9;object-fit:cover;background:#000;display:block}
  .shot .body{padding:.6rem .75rem}
  textarea,input{width:100%;background:#0f131a;color:var(--text);border:1px solid var(--line);border-radius:8px;padding:.5rem;font:inherit}
  button{background:var(--accent);color:#151515;border:0;border-radius:8px;padding:.5rem .9rem;font-weight:600;cursor:pointer}
  .note{border-left:3px solid var(--accent);padding:.4rem .75rem;margin:.5rem 0;background:#0f131a;border-radius:0 8px 8px 0}
  .note time{color:var(--muted);font-size:.8rem}
  .row{display:flex;gap:.5rem;align-items:center}
</style></head>
<body><main>
  <h1 id="title">Loading…</h1>
  <p class="muted" id="subtitle"></p>
  <div class="card" id="master-card" hidden><video id="master" controls playsinline></video></div>
  <div class="card">
    <div class="row"><strong>Shots</strong><span class="muted" id="shot-count"></span></div>
    <div class="shots" id="shots"></div>
  </div>
  <div class="card">
    <h2 style="font-size:1.05rem;margin:.2rem 0 .6rem">Notes</h2>
    <div class="row" style="margin-bottom:.5rem">
      <input id="name" placeholder="Your name" style="max-width:16rem" />
    </div>
    <div id="notes"></div>
  </div>
</main>
<script>
  const token = location.pathname.split("/")[2];
  const base = "/r/" + token;
  const nameInput = document.getElementById("name");
  nameInput.value = localStorage.getItem("slate.reviewer") || "";
  nameInput.addEventListener("change", () => localStorage.setItem("slate.reviewer", nameInput.value));

  function esc(text) { return String(text ?? ""); }

  async function load() {
    const response = await fetch(base + "/api/summary");
    if (!response.ok) { document.getElementById("title").textContent = "This link is no longer valid"; return; }
    const { data } = await response.json();
    document.title = "Review — " + data.project.name;
    document.getElementById("title").textContent = data.project.name;
    document.getElementById("subtitle").textContent =
      (data.label ? data.label + " · " : "") + "link expires " + new Date(data.expiresAt).toLocaleString();
    if (data.masterAssetId) {
      const video = document.getElementById("master");
      video.src = base + "/media/" + data.masterAssetId;
      document.getElementById("master-card").hidden = false;
    }
    document.getElementById("shot-count").textContent = data.shots.length + " shots";
    const shots = document.getElementById("shots");
    shots.innerHTML = "";
    for (const shot of data.shots) {
      const card = document.createElement("div");
      card.className = "shot";
      const img = document.createElement(shot.assetId ? "img" : "div");
      if (shot.assetId) img.src = base + "/media/" + shot.assetId;
      card.appendChild(img);
      const body = document.createElement("div");
      body.className = "body";
      const heading = document.createElement("div");
      heading.innerHTML = "<strong>" + esc(shot.number) + "</strong> <span class='muted'>" + esc(shot.durationSec) + "s</span>";
      const text = document.createElement("div");
      text.className = "muted";
      text.textContent = shot.description || "(no description)";
      const button = document.createElement("button");
      button.textContent = "Add note";
      button.style.marginTop = ".5rem";
      button.addEventListener("click", () => addNote("shot", shot.id, shot.number));
      body.append(heading, text, button);
      card.appendChild(body);
      shots.appendChild(card);
    }
    renderNotes(data.notes);
  }

  function renderNotes(notes) {
    const host = document.getElementById("notes");
    host.innerHTML = "";
    if (notes.length === 0) {
      host.innerHTML = "<p class='muted'>No notes yet.</p>";
      return;
    }
    for (const note of notes) {
      const wrap = document.createElement("div");
      wrap.className = "note";
      const meta = document.createElement("div");
      meta.className = "muted";
      meta.style.fontSize = ".8rem";
      meta.textContent = note.author + " · " + new Date(note.createdAt).toLocaleString() +
        (note.resolvedAt ? " · resolved" : "");
      const body = document.createElement("div");
      body.textContent = note.body;
      wrap.append(meta, body);
      host.appendChild(wrap);
    }
  }

  async function addNote(kind, id, label) {
    const text = prompt("Note on " + (label || kind) + ":");
    if (!text) return;
    const response = await fetch(base + "/api/note", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ anchorKind: kind, anchorId: id, body: text, name: nameInput.value || "reviewer" }),
    });
    if (response.ok) await load();
  }

  load();
</script>
</body></html>`;
}
