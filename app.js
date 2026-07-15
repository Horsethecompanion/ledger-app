/* Ledger — a minimal notes app backed by a GitHub-hosted Obsidian vault.
 *
 * Storage model:
 *  - Full note text is cached in localStorage after an initial sync (via the
 *    repo zipball, one request instead of 897), then kept fresh with
 *    lightweight sha checks against the git trees API.
 *  - Each note file is plain markdown: an optional `---\ntags: a, b\n---`
 *    frontmatter block, then `# Title`, then body text.
 *  - Images live in attachments/ and are referenced as relative markdown
 *    image links; they're fetched on demand when a note is opened, not
 *    during the bulk sync (keeps the cache small and fast).
 */

const LS_CONFIG = "ledger_config";
const LS_CACHE = "ledger_cache";
const IDLE_SAVE_MS = 60 * 1000; // save 60s after the user stops typing
const AUTOCOMPLETE_MIN_CHARS = 1;

let config = null;      // {owner, repo, branch, token}
let cache = null;       // {notes: {path: {sha, content}}, lastSync}
let currentPath = null;
let currentSha = null;  // sha of the note as last loaded, for stale-write checks
let idleTimer = null;
let dirty = false;

// ---------- Boot ----------

window.addEventListener("load", () => {
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("sw.js").catch(() => {});
  }
  loadConfig();
  if (config) {
    showMain();
    boot();
  } else {
    showSetup();
  }
  window.addEventListener("online", () => setOfflineBanner(false));
  window.addEventListener("offline", () => setOfflineBanner(true));
  setOfflineBanner(!navigator.onLine);
});

function loadConfig() {
  const raw = localStorage.getItem(LS_CONFIG);
  config = raw ? JSON.parse(raw) : null;
}

function saveConfig() {
  localStorage.setItem(LS_CONFIG, JSON.stringify(config));
}

function loadCache() {
  const raw = localStorage.getItem(LS_CACHE);
  cache = raw ? JSON.parse(raw) : { notes: {}, lastSync: null };
}

function saveCache() {
  localStorage.setItem(LS_CACHE, JSON.stringify(cache));
}

// ---------- Setup screen ----------

document.getElementById("setup-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const owner = document.getElementById("setup-owner").value.trim();
  const repo = document.getElementById("setup-repo").value.trim();
  const branch = document.getElementById("setup-branch").value.trim() || "main";
  const token = document.getElementById("setup-token").value.trim();
  const errEl = document.getElementById("setup-error");
  errEl.hidden = true;

  try {
    const res = await fetch(`https://api.github.com/repos/${owner}/${repo}`, {
      headers: { Authorization: `token ${token}` }
    });
    if (!res.ok) throw new Error(`Couldn't reach that repo (${res.status}). Check the details and token permissions.`);
    config = { owner, repo, branch, token };
    saveConfig();
    showMain();
    boot();
  } catch (err) {
    errEl.textContent = err.message;
    errEl.hidden = false;
  }
});

function showSetup() {
  document.getElementById("setup-screen").hidden = false;
  document.getElementById("main-screen").hidden = true;
}
function showMain() {
  document.getElementById("setup-screen").hidden = true;
  document.getElementById("main-screen").hidden = false;
}

// ---------- Boot / sync ----------

async function boot() {
  loadCache();
  if (Object.keys(cache.notes).length > 0) {
    renderIndex(); // show cached content instantly
  }
  try {
    if (!cache.lastSync) {
      await fullSync();
    } else {
      await incrementalSync();
    }
  } catch (err) {
    console.error("Sync failed, using cached data:", err);
  }
  renderIndex();
}

function ghHeaders() {
  return { Authorization: `token ${config.token}`, Accept: "application/vnd.github+json" };
}

async function fullSync() {
  setSyncStatus("syncing 0%…");
  const shaMap = await fetchTreeShas();
  const mdPaths = Object.keys(shaMap).filter((p) => p.endsWith(".md"));

  const notes = {};
  const CONCURRENCY = 12;
  let done = 0;

  async function fetchOne(path) {
    const sha = shaMap[path];
    try {
      const url = `https://api.github.com/repos/${config.owner}/${config.repo}/git/blobs/${sha}`;
      const res = await fetch(url, { headers: ghHeaders() });
      if (res.ok) {
        const data = await res.json();
        notes[path] = { sha, content: b64DecodeUnicode(data.content) };
      } else {
        console.error(`Failed to fetch ${path}: HTTP ${res.status}`);
      }
    } catch (err) {
      console.error(`Failed to fetch/decode ${path}:`, err);
      // Deliberately swallow: one bad file shouldn't abort the sync for the other 897.
    }
    done++;
    if (done % 20 === 0 || done === mdPaths.length) {
      setSyncStatus(`syncing ${Math.round((done / mdPaths.length) * 100)}%…`);
    }
  }

  const queue = [...mdPaths];
  async function worker() {
    while (queue.length) {
      const path = queue.shift();
      await fetchOne(path);
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));

  cache = { notes, shaMap, lastSync: new Date().toISOString() };
  saveCache();
  setSyncStatus("synced");
}

async function fetchTreeShas() {
  const url = `https://api.github.com/repos/${config.owner}/${config.repo}/git/trees/${config.branch}?recursive=1`;
  const res = await fetch(url, { headers: ghHeaders() });
  if (!res.ok) return {};
  const data = await res.json();
  const map = {};
  for (const item of data.tree || []) {
    if (item.type === "blob") map[item.path] = item.sha;
  }
  return map;
}

async function incrementalSync() {
  setSyncStatus("checking for changes…");
  try {
    const shaMap = await fetchTreeShas();
    const changedPaths = [];
    for (const [path, sha] of Object.entries(shaMap)) {
      if (!path.endsWith(".md")) continue;
      const cached = cache.notes[path];
      if (!cached || cached.sha !== sha) changedPaths.push(path);
    }
    // Also drop notes that no longer exist remotely
    for (const path of Object.keys(cache.notes)) {
      if (!shaMap[path]) delete cache.notes[path];
    }
    for (const path of changedPaths) {
      try {
        const file = await fetchFile(path);
        if (file) cache.notes[path] = { sha: file.sha, content: file.content };
      } catch (err) {
        console.error(`Incremental sync: failed to fetch ${path}:`, err);
      }
    }
    cache.shaMap = shaMap;
    cache.lastSync = new Date().toISOString();
    saveCache();
    setSyncStatus("synced");
  } catch (err) {
    setSyncStatus("offline (cached)");
  }
}

async function fetchFile(path) {
  const url = `https://api.github.com/repos/${config.owner}/${config.repo}/contents/${encodeURIComponent(path)}?ref=${config.branch}`;
  const res = await fetch(url, { headers: ghHeaders() });
  if (!res.ok) return null;
  const data = await res.json();
  return { sha: data.sha, content: b64DecodeUnicode(data.content) };
}

async function fetchFileRawBase64(path) {
  // Contents API silently returns no data for files over ~1MB (common for
  // photos), so fetch by blob sha instead - that endpoint supports up to 100MB.
  let sha = cache.shaMap && cache.shaMap[path];
  if (!sha) {
    // Not in our cached tree yet (e.g. very recently added) - look it up fresh.
    const freshMap = await fetchTreeShas();
    sha = freshMap[path];
    if (sha) {
      cache.shaMap = freshMap;
      saveCache();
    }
  }
  if (!sha) return null;

  const url = `https://api.github.com/repos/${config.owner}/${config.repo}/git/blobs/${sha}`;
  const res = await fetch(url, { headers: ghHeaders() });
  if (!res.ok) return null;
  const data = await res.json();
  return data.content.replace(/\n/g, "");
}

function setSyncStatus(text) {
  document.getElementById("sync-status").textContent = text;
}

function setOfflineBanner(isOffline) {
  document.getElementById("offline-banner").hidden = !isOffline;
}

// ---------- Frontmatter / parsing ----------

function parseNote(content) {
  let tags = [];
  let body = content;

  const fmMatch = body.match(/^---\s*\ntags:\s*(.*)\n---\s*\n/);
  if (fmMatch) {
    tags = fmMatch[1].split(",").map((t) => t.trim()).filter(Boolean);
    body = body.slice(fmMatch[0].length);
  }

  let title = "Untitled";
  const titleMatch = body.match(/^#\s+(.+)\n?/);
  if (titleMatch) {
    title = titleMatch[1].trim();
    body = body.slice(titleMatch[0].length);
  }

  return { tags, title, body: body.replace(/^\n+/, "") };
}

function serializeNote({ tags, title, body }) {
  let out = "";
  if (tags && tags.length) {
    out += `---\ntags: ${tags.join(", ")}\n---\n`;
  }
  out += `# ${title || "Untitled"}\n\n${body}`;
  return out;
}

function wordCount(text) {
  return (text.match(/\S+/g) || []).length;
}

// ---------- Index view ----------

let currentSort = "modified";
let activeTagFilter = null;

document.querySelectorAll('input[name="sort"]').forEach((el) => {
  el.addEventListener("change", (e) => {
    currentSort = e.target.value;
    renderIndex();
  });
});

document.getElementById("search-input").addEventListener("input", () => renderIndex());

function getAllTags() {
  const tags = new Set();
  for (const note of Object.values(cache.notes)) {
    const { tags: t } = parseNote(note.content);
    t.forEach((tag) => tags.add(tag));
  }
  return [...tags].sort();
}

function renderTagFilterBar() {
  const bar = document.getElementById("tag-filter-bar");
  const tags = getAllTags();
  bar.innerHTML = "";
  tags.forEach((tag) => {
    const pill = document.createElement("button");
    pill.className = "tag-pill" + (activeTagFilter === tag ? " active" : "");
    pill.textContent = tag;
    pill.onclick = () => {
      activeTagFilter = activeTagFilter === tag ? null : tag;
      renderIndex();
    };
    bar.appendChild(pill);
  });
}

function renderIndex() {
  document.getElementById("index-loading").hidden = true;
  renderTagFilterBar();

  const query = document.getElementById("search-input").value.trim();
  let entries = Object.entries(cache.notes).map(([path, note]) => {
    const parsed = parseNote(note.content);
    return { path, ...parsed, raw: note.content };
  });

  if (activeTagFilter) {
    entries = entries.filter((e) => e.tags.includes(activeTagFilter));
  }

  if (query) {
    entries = searchNotes(entries, query);
  } else {
    entries = entries.map((e) => ({ ...e, _score: 0 }));
    if (currentSort === "name") {
      entries.sort((a, b) => a.title.localeCompare(b.title));
    } else {
      // modified/created: without git commit dates cached per-file, fall back to path order;
      // a future pass could store commit timestamps per file for true modified/created sort.
      entries.sort((a, b) => a.title.localeCompare(b.title));
    }
  }

  const list = document.getElementById("note-list");
  list.innerHTML = "";
  document.getElementById("index-empty").hidden = entries.length > 0;

  entries.forEach((entry) => {
    const row = document.createElement("div");
    row.className = "note-row";
    row.onclick = () => openNote(entry.path);

    const wc = wordCount(entry.body);
    const isLong = wc >= 500;

    row.innerHTML = `
      <div class="note-row-main">
        <span class="note-row-title">${escapeHtml(entry.title)}</span>
        <div class="note-row-tags">${entry.tags.map((t) => `<span class="tag-pill">${escapeHtml(t)}</span>`).join("")}</div>
      </div>
      <div class="note-row-meta">
        ${wc} words
        ${isLong ? '<span class="essay-flag">● long-form</span>' : ""}
      </div>
    `;
    list.appendChild(row);
  });
}

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}

// ---------- Search: wildcards, quotes, +required, fuzzy fallback ----------

function searchNotes(entries, query) {
  const quoted = [];
  let working = query.replace(/"([^"]+)"/g, (_, phrase) => {
    quoted.push(phrase.toLowerCase());
    return "";
  });

  const required = [];
  const optional = [];
  working.split(/\s+/).filter(Boolean).forEach((term) => {
    if (term.startsWith("+")) required.push(term.slice(1).toLowerCase());
    else optional.push(term.toLowerCase());
  });

  function wildcardToRegex(term) {
    const escaped = term.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
    return new RegExp(escaped, "i");
  }

  const scored = [];
  for (const entry of entries) {
    const haystack = (entry.title + " " + entry.body).toLowerCase();

    // Exact phrases: all must appear
    if (quoted.length && !quoted.every((p) => haystack.includes(p))) continue;

    // Required (+term) terms: all must match, wildcard-aware
    if (required.length) {
      const allRequired = required.every((term) =>
        term.includes("*") ? wildcardToRegex(term).test(haystack) : haystack.includes(term)
      );
      if (!allRequired) continue;
    }

    // Score optional terms + phrases; fuzzy fallback if nothing matched exactly
    let score = quoted.length * 10 + required.length * 8;
    let anyOptionalMatch = optional.length === 0;
    for (const term of optional) {
      if (term.includes("*")) {
        if (wildcardToRegex(term).test(haystack)) { score += 5; anyOptionalMatch = true; }
      } else if (haystack.includes(term)) {
        score += 5; anyOptionalMatch = true;
      } else if (fuzzyIncludes(haystack, term)) {
        score += 1; anyOptionalMatch = true; // weak fuzzy credit
      }
    }

    if (score > 0 && (anyOptionalMatch || quoted.length || required.length)) {
      scored.push({ ...entry, _score: score });
    }
  }
  scored.sort((a, b) => b._score - a._score);
  return scored;
}

// Very lightweight typo-tolerance: true if term's characters appear in haystack
// in order within a small window (a subsequence check), not a full edit-distance.
function fuzzyIncludes(haystack, term) {
  if (term.length < 4) return false; // skip fuzzy on very short terms, too noisy
  let hi = 0;
  for (let ti = 0; ti < term.length; ti++) {
    const idx = haystack.indexOf(term[ti], hi);
    if (idx === -1) return false;
    hi = idx + 1;
  }
  return true;
}

// ---------- Editor ----------

document.getElementById("new-note-btn").addEventListener("click", () => {
  const now = new Date();
  const path = `${now.toISOString().slice(0, 10)}-${Date.now()}.md`;
  cache.notes[path] = { sha: null, content: serializeNote({ tags: [], title: "", body: "" }) };
  openNote(path, true);
});

document.getElementById("back-btn").addEventListener("click", async () => {
  await saveCurrentNoteIfDirty();
  document.getElementById("editor-view").hidden = true;
  document.getElementById("index-view").hidden = false;
  renderIndex();
});

let currentTags = [];

function openNote(path, isNew = false) {
  currentPath = path;
  const note = cache.notes[path];
  const parsed = parseNote(note.content);
  currentSha = note.sha;
  currentTags = [...parsed.tags];

  document.getElementById("index-view").hidden = true;
  document.getElementById("editor-view").hidden = false;

  document.getElementById("note-title").value = parsed.title === "Untitled" && isNew ? "" : parsed.title;
  document.getElementById("note-date").textContent = pathToDateLabel(path);
  updateWordCount(parsed.body);
  renderTagChips();
  document.getElementById("note-body").innerHTML = markdownToHtml(parsed.body);

  if (isNew) document.getElementById("note-title").focus();
  dirty = false;
  clearIdleTimer();
  loadInlineImages();
}

async function loadInlineImages() {
  const imgs = [...document.querySelectorAll("#note-body img[data-relpath]")];
  for (const img of imgs) {
    const path = img.dataset.relpath;
    if (!path || img.dataset.loaded) continue;
    try {
      const raw = await fetchFileRawBase64(path);
      if (raw) {
        const ext = path.split(".").pop().toLowerCase();
        const mime = ext === "png" ? "image/png" : ext === "gif" ? "image/gif" : "image/jpeg";
        img.src = `data:${mime};base64,${raw}`;
        img.dataset.loaded = "true";
      }
    } catch (err) {
      console.error("Couldn't load image", path, err);
    }
  }
}

function pathToDateLabel(path) {
  const m = path.match(/^(\d{4}-\d{2}-\d{2})/);
  return m ? m[1] : "";
}

function updateWordCount(bodyText) {
  document.getElementById("note-wordcount").textContent = `${wordCount(bodyText)} words`;
}

// -- Tags --

function renderTagChips() {
  const wrap = document.getElementById("tag-chips");
  wrap.innerHTML = "";
  currentTags.forEach((tag, i) => {
    const chip = document.createElement("span");
    chip.className = "tag-chip";
    chip.innerHTML = `${escapeHtml(tag)} <button title="Remove tag">×</button>`;
    chip.querySelector("button").onclick = () => {
      currentTags.splice(i, 1);
      renderTagChips();
      markDirty();
    };
    wrap.appendChild(chip);
  });
}

document.getElementById("tag-input").addEventListener("keydown", (e) => {
  if (e.key === "Enter" || e.keyCode === 13) {
    e.preventDefault();
    addTagFromInput();
  }
});
document.getElementById("tag-add-btn").addEventListener("click", (e) => {
  e.preventDefault();
  addTagFromInput();
  document.getElementById("tag-input").focus();
});

function addTagFromInput() {
  const input = document.getElementById("tag-input");
  const value = input.value.trim();
  if (!value) return;
  currentTags.push(value);
  input.value = "";
  renderTagChips();
  markDirty();
}

// -- Formatting toolbar (simple execCommand-based; matches "very basic" ask) --

document.getElementById("bold-btn").addEventListener("click", () => { document.execCommand("bold"); markDirty(); });
document.getElementById("italic-btn").addEventListener("click", () => { document.execCommand("italic"); markDirty(); });
document.getElementById("bullet-btn").addEventListener("click", () => { document.execCommand("insertUnorderedList"); markDirty(); });

// -- Image insert --

document.getElementById("image-btn").addEventListener("click", () => {
  document.getElementById("image-input").click();
});

document.getElementById("image-input").addEventListener("change", async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const base64 = await fileToBase64(file);
  const ext = file.name.split(".").pop().toLowerCase();
  const hash = await sha1Hex(base64);
  const filename = `${hash.slice(0, 10)}.${ext}`;
  const attachPath = `attachments/${filename}`;

  setSyncStatus("uploading image…");
  try {
    await putFile(attachPath, base64, null);
    const img = document.createElement("img");
    img.src = `data:${file.type};base64,${base64}`;
    img.dataset.relpath = attachPath;
    document.getElementById("note-body").appendChild(img);
    markDirty();
    setSyncStatus("synced");
  } catch (err) {
    setSyncStatus("image upload failed");
    console.error(err);
  }
  e.target.value = "";
});

function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result.split(",")[1]);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

async function sha1Hex(base64) {
  const bin = atob(base64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  const digest = await crypto.subtle.digest("SHA-1", bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// -- Backlinks: [[ triggers autocomplete of existing note titles --

document.getElementById("note-body").addEventListener("input", () => {
  markDirty();
  updateWordCount(htmlToMarkdown(document.getElementById("note-body").innerHTML));
  checkBacklinkTrigger();
});
document.getElementById("note-title").addEventListener("input", markDirty);

function checkBacklinkTrigger() {
  const sel = window.getSelection();
  if (!sel.rangeCount) return;
  const node = sel.anchorNode;
  if (!node || node.nodeType !== Node.TEXT_NODE) return hideAutocomplete();
  const textBefore = node.textContent.slice(0, sel.anchorOffset);
  const match = textBefore.match(/\[\[([^\]]*)$/);
  if (!match) return hideAutocomplete();
  showBacklinkAutocomplete(match[1]);
}

function showBacklinkAutocomplete(query) {
  const box = document.getElementById("backlink-autocomplete");
  const titles = Object.entries(cache.notes)
    .map(([path, note]) => parseNote(note.content).title)
    .filter((t) => t.toLowerCase().includes(query.toLowerCase()))
    .slice(0, 8);

  if (!titles.length) return hideAutocomplete();

  box.innerHTML = titles
    .map((t) => `<div class="backlink-option">${escapeHtml(t)}</div>`)
    .join("");
  box.hidden = false;

  [...box.children].forEach((el, i) => {
    el.onclick = () => insertBacklink(titles[i], query);
  });

  const sel = window.getSelection();
  const range = sel.getRangeAt(0).cloneRange();
  const rect = range.getBoundingClientRect();
  box.style.left = rect.left + "px";
  box.style.top = rect.bottom + window.scrollY + 4 + "px";
}

function hideAutocomplete() {
  document.getElementById("backlink-autocomplete").hidden = true;
}

function insertBacklink(title, query) {
  const sel = window.getSelection();
  const node = sel.anchorNode;
  const textBefore = node.textContent.slice(0, sel.anchorOffset);
  const idx = textBefore.lastIndexOf("[[");
  const before = node.textContent.slice(0, idx);
  const after = node.textContent.slice(sel.anchorOffset);

  const link = document.createElement("a");
  link.className = "wikilink";
  link.dataset.title = title;
  link.textContent = title;

  const beforeNode = document.createTextNode(before);
  const afterNode = document.createTextNode(" " + after);
  const parent = node.parentNode;
  parent.replaceChild(afterNode, node);
  parent.insertBefore(link, afterNode);
  parent.insertBefore(beforeNode, link);

  hideAutocomplete();
  markDirty();
}

// -- Save flow: idle-triggered + visibility fallback, with stale-write guard --

function markDirty() {
  dirty = true;
  document.getElementById("save-indicator").textContent = "unsaved changes…";
  clearIdleTimer();
  idleTimer = setTimeout(() => saveCurrentNoteIfDirty(), IDLE_SAVE_MS);
}

function clearIdleTimer() {
  if (idleTimer) clearTimeout(idleTimer);
}

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden") saveCurrentNoteIfDirty();
});

async function saveCurrentNoteIfDirty() {
  if (!dirty || !currentPath) return;
  clearIdleTimer();
  document.getElementById("save-indicator").textContent = "saving…";

  const title = document.getElementById("note-title").value.trim() || "Untitled";
  const bodyHtml = document.getElementById("note-body").innerHTML;
  const body = htmlToMarkdown(bodyHtml);
  const content = serializeNote({ tags: currentTags, title, body });

  cache.notes[currentPath] = { sha: currentSha, content };
  saveCache(); // local cache updated immediately regardless of network state

  if (!navigator.onLine) {
    document.getElementById("save-indicator").textContent = "saved locally (offline)";
    dirty = false;
    return;
  }

  try {
    const result = await putFile(currentPath, b64EncodeUnicode(content), currentSha);
    currentSha = result.sha;
    cache.notes[currentPath].sha = result.sha;
    saveCache();
    dirty = false;
    document.getElementById("save-indicator").textContent = "saved";
  } catch (err) {
    if (err.message === "STALE") {
      document.getElementById("save-indicator").textContent =
        "⚠ this note changed elsewhere — reload it before continuing to avoid overwriting that change";
    } else {
      document.getElementById("save-indicator").textContent = "saved locally, will retry sync";
    }
  }
}

async function putFile(path, base64Content, sha) {
  const url = `https://api.github.com/repos/${config.owner}/${config.repo}/contents/${encodeURIComponent(path)}`;
  const body = {
    message: `Update ${path}`,
    content: base64Content,
    branch: config.branch
  };
  if (sha) body.sha = sha;

  const res = await fetch(url, {
    method: "PUT",
    headers: { ...ghHeaders(), "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });

  if (res.status === 409 || res.status === 422) throw new Error("STALE");
  if (!res.ok) throw new Error("Save failed: " + res.status);
  const data = await res.json();
  return { sha: data.content.sha };
}

// ---------- Very small markdown <-> HTML conversion (bold/italic/bullets/images/wikilinks only) ----------

function markdownToHtml(md) {
  // Pull out image markdown first, across the whole text - alt text can
  // legitimately span many lines (e.g. long OCR text OneNote attaches to
  // pasted images), so a single-line regex would miss these entirely.
  const images = [];
  const withPlaceholders = md.replace(/!\[([\s\S]*?)\]\(([^)\n]+)\)/g, (_, alt, src) => {
    const token = `\u0000IMG${images.length}\u0000`;
    images.push({ alt: alt.replace(/\n/g, " ").trim(), src });
    return token;
  });

  const lines = withPlaceholders.split("\n");
  let html = "";
  let inList = false;
  for (const line of lines) {
    const placeholderMatch = line.match(/^\u0000IMG(\d+)\u0000$/);
    if (placeholderMatch) {
      if (inList) { html += "</ul>"; inList = false; }
      const img = images[Number(placeholderMatch[1])];
      html += `<img src="${img.src}" alt="${escapeHtml(img.alt)}" data-relpath="${img.src}">`;
      continue;
    }
    if (line.startsWith("- ")) {
      if (!inList) { html += "<ul>"; inList = true; }
      html += `<li>${inlineMdToHtml(line.slice(2))}</li>`;
      continue;
    }
    if (inList) { html += "</ul>"; inList = false; }
    if (line.trim() === "") { html += "<div><br></div>"; continue; }
    html += `<div>${inlineMdToHtml(line)}</div>`;
  }
  if (inList) html += "</ul>";
  return html;
}

function inlineMdToHtml(text) {
  let out = escapeHtml(text);
  out = out.replace(/\*\*(.+?)\*\*/g, "<b>$1</b>");
  out = out.replace(/(?<!\*)\*(?!\*)(.+?)\*(?!\*)/g, "<i>$1</i>");
  out = out.replace(/\[\[([^\]]+)\]\]/g, '<a class="wikilink" data-title="$1">$1</a>');
  return out;
}

function htmlToMarkdown(html) {
  const container = document.createElement("div");
  container.innerHTML = html;
  const lines = [];

  function inlineToMd(node) {
    let out = "";
    node.childNodes.forEach((child) => {
      if (child.nodeType === Node.TEXT_NODE) { out += child.textContent; return; }
      const tag = child.tagName;
      if (tag === "B" || tag === "STRONG") out += `**${inlineToMd(child)}**`;
      else if (tag === "I" || tag === "EM") out += `*${inlineToMd(child)}*`;
      else if (tag === "A" && child.classList.contains("wikilink")) out += `[[${child.dataset.title}]]`;
      else if (tag === "BR") out += "\n";
      else out += inlineToMd(child);
    });
    return out;
  }

  container.childNodes.forEach((node) => {
    if (node.nodeType === Node.TEXT_NODE) {
      if (node.textContent.trim()) lines.push(node.textContent);
      return;
    }
    const tag = node.tagName;
    if (tag === "IMG") {
      const path = node.dataset.relpath || node.getAttribute("src");
      lines.push(`![${node.alt || ""}](${path})`);
    } else if (tag === "UL" || tag === "OL") {
      [...node.children].forEach((li) => lines.push(`- ${inlineToMd(li)}`));
    } else if (tag === "DIV" || tag === "P") {
      const text = inlineToMd(node);
      lines.push(text === "" ? "" : text);
    } else {
      lines.push(inlineToMd(node));
    }
  });

  return lines.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

// ---------- Base64 helpers (unicode-safe) ----------

function b64EncodeUnicode(str) {
  const bytes = new TextEncoder().encode(str);
  let binary = "";
  bytes.forEach((b) => { binary += String.fromCharCode(b); });
  return btoa(binary);
}
function b64DecodeUnicode(base64) {
  const binary = atob(base64.replace(/\n/g, ""));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new TextDecoder("utf-8").decode(bytes);
}

// ---------- Settings / download ----------

document.getElementById("settings-btn").addEventListener("click", () => {
  if (confirm("Disconnect this device from the vault? (Your token will be forgotten here; nothing is deleted from GitHub.)")) {
    localStorage.removeItem(LS_CONFIG);
    localStorage.removeItem(LS_CACHE);
    location.reload();
  }
});

document.getElementById("download-btn").addEventListener("click", async () => {
  setSyncStatus("zipping…");
  const zip = new JSZip();
  for (const [path, note] of Object.entries(cache.notes)) {
    zip.file(path, note.content);
  }
  // Best-effort: include attachments referenced by cached notes
  const attachPaths = new Set();
  for (const note of Object.values(cache.notes)) {
    const matches = note.content.matchAll(/!\[[^\]]*\]\((attachments\/[^)]+)\)/g);
    for (const m of matches) attachPaths.add(m[1]);
  }
  for (const path of attachPaths) {
    try {
      const raw = await fetchFileRawBase64(path);
      if (raw) zip.file(path, raw, { base64: true });
    } catch (e) { /* skip on failure, note text backup still succeeds */ }
  }
  const blob = await zip.generateAsync({ type: "blob" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `ledger-vault-backup-${new Date().toISOString().slice(0, 10)}.zip`;
  a.click();
  URL.revokeObjectURL(url);
  setSyncStatus("synced");
});
