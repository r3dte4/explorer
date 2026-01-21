/* public/app.js
 * Client for Storage Explorer
 * Matches server.js endpoints:
 *  - GET  /api/root
 *  - POST /api/scan
 *  - GET  /api/scan/status
 *  - GET  /api/list?path=...
 *  - GET  /api/meta?path=... ; POST /api/meta
 *  - POST /api/meta/bulk (op: addTags/removeTags/setDescription/appendDescription)
 *  - GET  /api/tags
 *  - GET  /api/search?q=...
 *  - GET  /api/preview/text?path=...&offset=...&limit=100
 *  - GET  /api/preview/binary?path=...
 *  - GET  /api/preview/imageThumb?path=...&max=...
 *  - POST /api/action/delete|move|archive
 */

const API = ""; // same origin
let ROOT = "";
let dangerousEnabled = false;

const state = {
  theme: localStorage.getItem("theme") || "dark",
  currentDir: "",
  sortKey: "name", // name | size | mtime
  sortDir: "asc",
  treeExpanded: new Set(),
  focusedPath: "",
  focusedIndex: -1,
  listItems: [], // items from /api/list or hydrated search results
  selection: new Set(),
  lastClickedIndex: null,
  tabs: [], // { path, title, kind:'text'|'image'|'binary'|'error'|'loading', offset, lines, hasMore, thumbUrl, meta, prismLang }
  activeTabPath: null,
  knownTags: [], // ['#archive', ...]
  // cache folder recursion resolve: folderPath -> { paths:[...], total:number }
  folderResolveCache: new Map(),
  // Timeline view state
  viewMode: 'folders', // 'folders' | 'timeline'
  timeline: {
    sortBy: 'modified', // 'modified' | 'created'
    groupBy: 'day', // 'day' | 'month'
    offset: 0,
    limit: 5,
    totalGroups: 0,
    totalFiles: 0,
    hasMore: false,
    hasPrev: false,
    groups: [] // [{ key, label, files, totalFiles, hasMore }]
  }
};

//
// DOM (matches index.html ids)
//
const rootBadge = document.getElementById("rootBadge");
const treeEl = document.getElementById("tree");
const listEl = document.getElementById("list");
const breadcrumbsEl = document.getElementById("breadcrumbs");
const copyPathBtn = document.getElementById("copyPathBtn");
const globalSearch = document.getElementById("globalSearch");
const refreshBtn = document.getElementById("refreshBtn");
const themeBtn = document.getElementById("themeBtn");

const selectAllBtn = document.getElementById("selectAllBtn");
const selectNoneBtn = document.getElementById("selectNoneBtn");
const invertBtn = document.getElementById("invertBtn");

const actionBar = document.getElementById("actionBar");
const selCount = document.getElementById("selCount");
const selSize = document.getElementById("selSize");
const deleteBtn = document.getElementById("deleteBtn");
const moveBtn = document.getElementById("moveBtn");
const archiveBtn = document.getElementById("archiveBtn");

const tabsEl = document.getElementById("tabs");
const previewEl = document.getElementById("preview");

const inspectorBody = document.getElementById("inspectorBody");
const bulkBadge = document.getElementById("bulkBadge");

const statusLeft = document.getElementById("statusLeft");
const statusRight = document.getElementById("statusRight");

const modal = document.getElementById("modal");
const modalTitle = document.getElementById("modalTitle");
const modalBody = document.getElementById("modalBody");
const modalCancel = document.getElementById("modalCancel");
const modalOk = document.getElementById("modalOk");

// Timeline view controls
const viewFoldersBtn = document.getElementById("viewFoldersBtn");
const viewTimelineBtn = document.getElementById("viewTimelineBtn");
const timelineControls = document.getElementById("timelineControls");
const sortBySelect = document.getElementById("sortBySelect");
const groupBySelect = document.getElementById("groupBySelect");
const prevGroupsBtn = document.getElementById("prevGroupsBtn");
const nextGroupsBtn = document.getElementById("nextGroupsBtn");
const groupsInfo = document.getElementById("groupsInfo");

//
// Utilities
//
function setTheme(t) {
  document.documentElement.setAttribute("data-theme", t);
  state.theme = t;
  localStorage.setItem("theme", t);
}

function escHtml(s) {
  return String(s).replace(/[&<>"']/g, (m) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;"
  }[m]));
}

function debounce(fn, ms = 250) {
  let t = null;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}

function normalizePath(p) {
  return String(p || "").replace(/\//g, "\\");
}
function pathKey(p) {
  return normalizePath(p).toLowerCase();
}
function isSamePath(a, b) {
  return pathKey(a) === pathKey(b);
}
function basename(p) {
  const parts = normalizePath(p).split("\\").filter(Boolean);
  return parts[parts.length - 1] || p;
}
function dirname(p) {
  const parts = normalizePath(p).split("\\");
  parts.pop();
  let d = parts.join("\\");
  if (/^[a-z]:$/i.test(d)) d += "\\";
  return d || p;
}

function humanSize(bytes) {
  if (bytes == null || Number.isNaN(bytes)) return "—";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let b = bytes, i = 0;
  while (b >= 1024 && i < units.length - 1) { b /= 1024; i++; }
  return `${b.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

function fmtDate(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  return d.toLocaleString();
}

async function apiGet(path) {
  const r = await fetch(API + path);
  if (!r.ok) {
    let msg = "Request failed";
    try { msg = (await r.json()).error || msg; } catch { }
    throw new Error(msg);
  }
  return r.json();
}
async function apiPost(path, body) {
  const r = await fetch(API + path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body || {})
  });
  if (!r.ok) {
    let msg = "Request failed";
    try { msg = (await r.json()).error || msg; } catch { }
    throw new Error(msg);
  }
  return r.json();
}

function showStatusToast(msg, ms = 1800) {
  const prev = statusRight.textContent;
  statusRight.textContent = msg;
  setTimeout(() => { statusRight.textContent = prev; }, ms);
}

//
// Modal
//
function confirmModal(title, body, okLabel = "Confirm") {
  return new Promise((resolve) => {
    modalTitle.textContent = title;
    modalBody.textContent = body;
    modalOk.textContent = okLabel;
    modal.style.display = "flex";

    const cleanup = (v) => {
      modal.style.display = "none";
      modalCancel.onclick = null;
      modalOk.onclick = null;
      resolve(v);
    };

    modalCancel.onclick = () => cleanup(false);
    modalOk.onclick = () => cleanup(true);
  });
}

//
// Sorting
//
function compareItems(a, b) {
  // folders first
  if (a.type !== b.type) return a.type === "folder" ? -1 : 1;

  const dir = state.sortDir === "asc" ? 1 : -1;
  const key = state.sortKey;

  const av = getSortVal(a, key);
  const bv = getSortVal(b, key);
  if (av < bv) return -1 * dir;
  if (av > bv) return 1 * dir;
  return 0;
}

function getSortVal(it, key) {
  if (key === "name") return (it.name || basename(it.path) || "").toLowerCase();
  if (key === "size") return Number(it.sizeBytes ?? it.size ?? 0);
  if (key === "mtime") return new Date(it.mtimeISO || it.mtime || 0).getTime();
  return (it.name || "").toLowerCase();
}

function sortedList() {
  return [...state.listItems].sort(compareItems);
}

//
// Root/init
//
async function init() {
  setTheme(state.theme);

  const rootInfo = await apiGet("/api/root"); // server.js provides this :contentReference[oaicite:6]{index=6}
  ROOT = rootInfo.rootPath;
  dangerousEnabled = !!rootInfo.dangerousActionsEnabled;
  rootBadge.textContent = ROOT + (dangerousEnabled ? " (actions enabled)" : " (actions locked)");

  state.currentDir = ROOT;
  state.treeExpanded.add(ROOT);

  await loadKnownTags();
  await refreshScanStatus();

  await renderTree();
  await loadDir(ROOT);

  hookEvents();
  startStatusPoll();
}

async function loadKnownTags() {
  try {
    const r = await apiGet("/api/tags"); // :contentReference[oaicite:7]{index=7}
    state.knownTags = (r.tags || []).map(x => x.tag);
  } catch {
    state.knownTags = [];
  }
}

async function refreshScanStatus() {
  try {
    const s = await apiGet("/api/scan/status"); // :contentReference[oaicite:8]{index=8}
    statusLeft.textContent = `Indexed: ${s.scannedFolders} folders, ${s.scannedFiles} files, total ${s.totalSizeHuman}`;
    const largest = (s.largestFiles || [])[0];
    statusRight.textContent = s.running ? "Scanning…" : (largest ? `Largest: ${largest.sizeHuman}` : "Ready");
  } catch {
    statusLeft.textContent = "Indexed: —";
    statusRight.textContent = "Ready";
  }
}

function startStatusPoll() {
  setInterval(async () => { await refreshScanStatus().catch(() => { }); }, 2000);
}

//
// Directory loading + breadcrumbs
//
async function loadDir(dirPath) {
  state.currentDir = dirPath;
  state.focusedPath = "";
  state.focusedIndex = -1;
  globalSearch.value = "";

  await refreshDirList();
  renderBreadcrumbs(dirPath);
  renderList();
  updateActionBar();
  await renderTree();
}

async function refreshDirList() {
  try {
    const r = await apiGet(`/api/list?path=${encodeURIComponent(state.currentDir)}`); // :contentReference[oaicite:9]{index=9}
    state.listItems = (r.items || []).map(normalizeServerItem);
  } catch (e) {
    state.listItems = [];
    showStatusToast(e.message || "Failed to list directory");
  }
}

function normalizeServerItem(it) {
  // server returns: { name, path, type, ext, sizeBytes, sizeHuman, mtimeISO, isText, isImage, meta } :contentReference[oaicite:10]{index=10}
  return {
    name: it.name,
    path: it.path,
    type: it.type,
    ext: it.ext,
    sizeBytes: it.sizeBytes,
    sizeHuman: it.sizeHuman || humanSize(it.sizeBytes),
    mtimeISO: it.mtimeISO,
    isText: !!it.isText,
    isImage: !!it.isImage,
    meta: it.meta || { description: "", tags: [] }
  };
}

function renderBreadcrumbs(path) {
  breadcrumbsEl.innerHTML = "";

  const p = normalizePath(path);
  const parts = p.split("\\").filter(Boolean);

  // drive root
  let drive = "";
  if (parts.length && /^[a-z]:$/i.test(parts[0])) {
    drive = parts.shift();
  } else if (/^[a-z]:/i.test(p)) {
    drive = p.slice(0, 2);
  }

  const segments = [];
  if (drive) segments.push(drive + "\\");
  for (const s of parts) segments.push(s);

  let cur = drive ? (drive + "\\") : "";
  segments.forEach((seg, idx) => {
    const btn = document.createElement("button");
    btn.className = "crumb";
    btn.textContent = seg;

    if (idx === 0 && seg.endsWith("\\")) cur = seg;
    else cur = cur ? (cur.endsWith("\\") ? cur + seg : cur + "\\" + seg) : seg;

    const target = cur;
    btn.addEventListener("click", async () => { await loadDir(target); });

    breadcrumbsEl.appendChild(btn);
    if (idx < segments.length - 1) {
      const sep = document.createElement("span");
      sep.className = "crumbSep";
      sep.textContent = "›";
      breadcrumbsEl.appendChild(sep);
    }
  });

  copyPathBtn.disabled = !path;
}

//
// Tree rendering (lazy expand; uses /api/list filtered to folders)
//
async function renderTree() {
  treeEl.innerHTML = "";
  const rootNode = await buildTreeNode(ROOT, 0, true);
  treeEl.appendChild(rootNode);
}

async function fetchFolderChildren(folderPath) {
  try {
    const r = await apiGet(`/api/list?path=${encodeURIComponent(folderPath)}`); // :contentReference[oaicite:11]{index=11}
    return (r.items || []).map(normalizeServerItem).filter(x => x.type === "folder");
  } catch {
    return [];
  }
}

function folderSelectedCount(folderPath) {
  // Best-effort: count selected items whose path starts with folderPath\
  const fp = normalizePath(folderPath);
  const prefix = fp.endsWith("\\") ? fp : (fp + "\\");
  let sel = 0;
  for (const p of state.selection) {
    const np = normalizePath(p);
    if (np === fp || np.startsWith(prefix)) sel++;
  }
  return sel;
}

function setFolderCheckboxState(cb, folderPath) {
  // Tri-state based on cached full resolve, else heuristic based on selected count only.
  const cache = state.folderResolveCache.get(pathKey(folderPath));
  if (cache && cache.total > 0) {
    const sel = cache.paths.reduce((acc, p) => acc + (state.selection.has(p) ? 1 : 0), 0);
    cb.checked = sel === cache.total;
    cb.indeterminate = sel > 0 && sel < cache.total;
    cb.dataset.counter = `${sel}/${cache.total}`;
    return;
  }

  // heuristic: indeterminate if any selection in subtree
  const sel = folderSelectedCount(folderPath);
  cb.checked = false;
  cb.indeterminate = sel > 0;
  cb.dataset.counter = "";
}

function iconFor(it) {
  if (it.type === "folder") return "📁";
  if (it.isImage) return "🖼️";
  if (it.isText) return "📄";
  return "📦";
}

async function buildTreeNode(folderPath, depth, isRoot = false) {
  const container = document.createElement("div");

  const node = document.createElement("div");
  node.className = "treeNode" + (isSamePath(state.currentDir, folderPath) ? " active" : "");
  node.dataset.path = folderPath;
  node.dataset.type = "folder";
  node.style.paddingLeft = `${6 + depth * 14}px`;

  const chev = document.createElement("div");
  chev.className = "chev";
  chev.textContent = state.treeExpanded.has(folderPath) ? "▾" : "▸";

  const cb = document.createElement("input");
  cb.type = "checkbox";
  cb.className = "checkbox";
  setFolderCheckboxState(cb, folderPath);

  const icon = document.createElement("div");
  icon.className = "icon";
  icon.textContent = "📁";

  const name = document.createElement("div");
  name.className = "nodeName";
  name.textContent = isRoot ? folderPath : basename(folderPath);

  const counter = document.createElement("div");
  counter.className = "nodeMeta";
  counter.textContent = cb.dataset.counter || "";

  node.appendChild(chev);
  node.appendChild(cb);
  node.appendChild(icon);
  node.appendChild(name);
  node.appendChild(counter);

  chev.addEventListener("click", async (e) => {
    e.stopPropagation();
    if (state.treeExpanded.has(folderPath)) state.treeExpanded.delete(folderPath);
    else state.treeExpanded.add(folderPath);
    await renderTree();
  });

  node.addEventListener("click", async (e) => {
    e.stopPropagation();
    await loadDir(folderPath);
  });

  cb.addEventListener("click", async (e) => {
    e.stopPropagation();
    const checked = cb.checked;
    await toggleFolderRecursive(folderPath, checked);
    await renderTree();
    renderList();
    updateActionBar();
  });

  container.appendChild(node);

  if (state.treeExpanded.has(folderPath)) {
    const kidsWrap = document.createElement("div");
    kidsWrap.className = "treeChildren";
    const kids = await fetchFolderChildren(folderPath);
    kids.sort(compareItems);
    for (const k of kids) {
      kidsWrap.appendChild(await buildTreeNode(k.path, depth + 1, false));
    }
    container.appendChild(kidsWrap);
  }

  return container;
}

//
// Recursive folder selection WITHOUT server resolve endpoint:
// BFS using /api/list; caches results per folder (in-memory).
//
async function resolveFolderContents(folderPath) {
  const k = pathKey(folderPath);
  const cached = state.folderResolveCache.get(k);
  if (cached) return cached;

  const queue = [folderPath];
  const out = [];
  const seen = new Set();

  while (queue.length) {
    const cur = queue.shift();
    const ck = pathKey(cur);
    if (seen.has(ck)) continue;
    seen.add(ck);

    out.push(cur); // include folder itself

    let listing;
    try {
      listing = await apiGet(`/api/list?path=${encodeURIComponent(cur)}`); // :contentReference[oaicite:12]{index=12}
    } catch {
      continue;
    }

    const items = (listing.items || []).map(normalizeServerItem);
    for (const it of items) {
      out.push(it.path);
      if (it.type === "folder") queue.push(it.path);
    }
  }

  const res = { paths: Array.from(new Set(out)), total: Array.from(new Set(out)).length };
  state.folderResolveCache.set(k, res);
  return res;
}

async function toggleFolderRecursive(folderPath, checked) {
  const res = await resolveFolderContents(folderPath);
  for (const p of res.paths) {
    if (checked) state.selection.add(p);
    else state.selection.delete(p);
  }
}

//
// List rendering (NOTE: index.html already has .listHeader; we only render rows into #list)
//
function renderList() {
  listEl.innerHTML = "";

  const items = sortedList();

  items.forEach((it, idx) => {
    const row = document.createElement("div");
    row.className = "listRow" +
      (state.selection.has(it.path) ? " selected" : "") +
      (isSamePath(state.focusedPath, it.path) ? " focused" : "");
    row.dataset.path = it.path;
    row.dataset.type = it.type;

    const cbCell = document.createElement("div");
    cbCell.className = "cell cb";

    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.className = "checkbox";
    cb.checked = state.selection.has(it.path);
    cb.addEventListener("click", async (e) => {
      e.stopPropagation();
      await handleSelectionClick(idx, it, e);
      renderList();
      updateActionBar();
      await renderTree();
    });
    cbCell.appendChild(cb);

    const nameCell = document.createElement("div");
    nameCell.className = "cell name";
    nameCell.innerHTML = `
      <span class="ico">${escHtml(iconFor(it))}</span>
      <span class="nm">${escHtml(it.name || basename(it.path))}</span>
    `;

    const sizeCell = document.createElement("div");
    sizeCell.className = "cell size";
    sizeCell.textContent = it.sizeHuman || humanSize(it.sizeBytes);

    const modCell = document.createElement("div");
    modCell.className = "cell mtime";
    modCell.textContent = fmtDate(it.mtimeISO);

    row.appendChild(cbCell);
    row.appendChild(nameCell);
    row.appendChild(sizeCell);
    row.appendChild(modCell);

    row.addEventListener("click", async () => {
      state.focusedPath = it.path;
      state.focusedIndex = idx;
      await openInspectorSingle(it.path);
      renderList();
    });

    row.addEventListener("mousedown", async (e) => {
      if (e.target && e.target.tagName === "INPUT") return;
      if (e.shiftKey || e.ctrlKey || e.metaKey) {
        e.preventDefault();
        await handleSelectionClick(idx, it, e);
        renderList();
        updateActionBar();
        await renderTree();
      }
    });

    row.addEventListener("dblclick", async () => {
      if (it.type === "folder") {
        await loadDir(it.path);
      } else {
        await openPreview(it);
      }
    });

    listEl.appendChild(row);
  });

  if (items.length === 0) {
    const empty = document.createElement("div");
    empty.className = "emptyState";
    empty.textContent = "No items.";
    listEl.appendChild(empty);
  }
}

//
// Timeline View Functions
//
function updateViewModeUI() {
  if (state.viewMode === 'timeline') {
    viewFoldersBtn.classList.remove('active');
    viewTimelineBtn.classList.add('active');
    timelineControls.style.display = 'flex';
  } else {
    viewFoldersBtn.classList.add('active');
    viewTimelineBtn.classList.remove('active');
    timelineControls.style.display = 'none';
  }
}

async function loadTimeline() {
  const { sortBy, groupBy, offset, limit } = state.timeline;

  try {
    const params = new URLSearchParams({
      sortBy,
      groupBy,
      order: 'desc',
      offset: offset.toString(),
      limit: limit.toString(),
      filesPerGroup: '50'
    });

    const r = await apiGet(`/api/files/timeline?${params}`);

    state.timeline.groups = r.groups || [];
    state.timeline.totalGroups = r.totalGroups || 0;
    state.timeline.totalFiles = r.totalFiles || 0;
    state.timeline.hasMore = r.hasMoreGroups || false;
    state.timeline.hasPrev = r.hasPrevGroups || false;

    // Flatten files for selection operations
    state.listItems = [];
    for (const group of state.timeline.groups) {
      for (const file of group.files) {
        state.listItems.push(file);
      }
    }

    renderTimelineList();
    updateTimelineNav();
    updateActionBar();

  } catch (e) {
    showStatusToast(e.message || "Failed to load timeline");
  }
}

function updateTimelineNav() {
  const { offset, limit, totalGroups, hasPrev, hasMore } = state.timeline;

  prevGroupsBtn.disabled = !hasPrev;
  nextGroupsBtn.disabled = !hasMore;

  const currentEnd = Math.min(offset + limit, totalGroups);
  const currentStart = totalGroups > 0 ? offset + 1 : 0;
  groupsInfo.textContent = `${currentStart}-${currentEnd} of ${totalGroups}`;
}

function renderTimelineList() {
  listEl.innerHTML = "";

  const { groups } = state.timeline;

  if (!groups.length) {
    const empty = document.createElement("div");
    empty.className = "emptyState";
    empty.textContent = "No files found. Try scanning first.";
    listEl.appendChild(empty);
    return;
  }

  for (const group of groups) {
    // Date group header
    const header = document.createElement("div");
    header.className = "dateGroupHeader";
    header.innerHTML = `
      <span class="label">${escHtml(group.label)}</span>
      <span class="count">${group.totalFiles} file${group.totalFiles !== 1 ? 's' : ''}</span>
      ${group.hasMore ? `<span class="showMore">+${group.totalFiles - group.files.length} more</span>` : ''}
    `;
    listEl.appendChild(header);

    // Files in this group
    for (const file of group.files) {
      const row = document.createElement("div");
      row.className = "listRow" +
        (state.selection.has(file.path) ? " selected" : "") +
        (isSamePath(state.focusedPath, file.path) ? " focused" : "");
      row.dataset.path = file.path;
      row.dataset.type = file.type;

      const cbCell = document.createElement("div");
      cbCell.className = "cell cb";

      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.className = "checkbox";
      cb.checked = state.selection.has(file.path);
      cb.addEventListener("click", async (e) => {
        e.stopPropagation();
        if (state.selection.has(file.path)) state.selection.delete(file.path);
        else state.selection.add(file.path);
        renderTimelineList();
        updateActionBar();
      });
      cbCell.appendChild(cb);

      const nameCell = document.createElement("div");
      nameCell.className = "cell name";
      nameCell.innerHTML = `
        <span class="ico">${escHtml(iconFor(file))}</span>
        <span class="nm">${escHtml(file.name)}</span>
      `;

      const sizeCell = document.createElement("div");
      sizeCell.className = "cell size";
      sizeCell.textContent = file.sizeHuman || humanSize(file.sizeBytes);

      const modCell = document.createElement("div");
      modCell.className = "cell mtime";
      modCell.textContent = fmtDate(file.mtimeISO);

      row.appendChild(cbCell);
      row.appendChild(nameCell);
      row.appendChild(sizeCell);
      row.appendChild(modCell);

      row.addEventListener("click", async () => {
        state.focusedPath = file.path;
        await openInspectorSingle(file.path);
        renderTimelineList();
      });

      row.addEventListener("dblclick", async () => {
        await openPreview(file);
      });

      listEl.appendChild(row);
    }
  }
}

async function handleSelectionClick(index, item, e) {
  const items = sortedList();
  const path = item.path;

  if (e.shiftKey && state.lastClickedIndex != null) {
    const a = Math.min(state.lastClickedIndex, index);
    const b = Math.max(state.lastClickedIndex, index);
    for (let i = a; i <= b; i++) state.selection.add(items[i].path);
    state.lastClickedIndex = index;
    return;
  }

  if (e.ctrlKey || e.metaKey) {
    if (state.selection.has(path)) state.selection.delete(path);
    else state.selection.add(path);
    state.lastClickedIndex = index;
    return;
  }

  // default toggle
  if (state.selection.has(path)) state.selection.delete(path);
  else state.selection.add(path);
  state.lastClickedIndex = index;
}

//
// Action bar + size calc (best-effort; only sizes for currently loaded directory items are known)
//
function updateActionBar() {
  const count = state.selection.size;
  if (count <= 0) {
    actionBar.style.display = "none";
    bulkBadge.style.display = "none";
    selCount.textContent = "0 selected";
    selSize.textContent = "";
    return;
  }

  actionBar.style.display = "flex";
  bulkBadge.style.display = count > 1 ? "inline-flex" : "none";
  selCount.textContent = `${count} selected`;

  // best-effort size sum from current dir list; unknown items count as 0
  let sum = 0;
  for (const p of state.selection) {
    const it = state.listItems.find(x => isSamePath(x.path, p));
    if (it && typeof it.sizeBytes === "number") sum += it.sizeBytes;
  }
  selSize.textContent = sum > 0 ? humanSize(sum) : "—";

  // Bulk inspector if multi-select, else keep single inspector if focused
  if (count > 1) openInspectorBulk().catch(() => { });
  else if (count === 1 && !state.focusedPath) {
    openInspectorSingle(Array.from(state.selection)[0]).catch(() => { });
  }
}

//
// Bulk actions (use server routes /api/action/*) :contentReference[oaicite:13]{index=13}
//
async function doDeleteSelection() {
  if (!dangerousEnabled) {
    await confirmModal("Actions locked", "Dangerous actions are disabled by server configuration.", "OK");
    return;
  }
  const paths = Array.from(state.selection);
  const ok = await confirmModal("Delete selected items", `Delete ${paths.length} item(s)? This is permanent.`, "Delete");
  if (!ok) return;

  try {
    await apiPost("/api/action/delete", { paths });
    state.selection.clear();
    await refreshDirList();
    renderList();
    updateActionBar();
    await renderTree();
    showStatusToast("Deleted.");
  } catch (e) {
    showStatusToast(e.message || "Delete failed");
  }
}

async function doMoveSelection() {
  if (!dangerousEnabled) {
    await confirmModal("Actions locked", "Dangerous actions are disabled by server configuration.", "OK");
    return;
  }
  const destination = prompt("Move to folder (absolute path):", state.currentDir);
  if (!destination) return;

  const paths = Array.from(state.selection);
  const ok = await confirmModal("Move selected items", `Move ${paths.length} item(s) to:\n${destination}`, "Move");
  if (!ok) return;

  try {
    await apiPost("/api/action/move", { paths, destination });
    state.selection.clear();
    await refreshDirList();
    renderList();
    updateActionBar();
    await renderTree();
    showStatusToast("Moved.");
  } catch (e) {
    showStatusToast(e.message || "Move failed");
  }
}

async function doArchiveSelection() {
  if (!dangerousEnabled) {
    await confirmModal("Actions locked", "Dangerous actions are disabled by server configuration.", "OK");
    return;
  }
  const paths = Array.from(state.selection);
  const ok = await confirmModal("Archive selected items", `Archive ${paths.length} item(s) under _Archive?`, "Archive");
  if (!ok) return;

  try {
    const r = await apiPost("/api/action/archive", { paths });
    state.selection.clear();
    await refreshDirList();
    renderList();
    updateActionBar();
    await renderTree();
    showStatusToast(`Archived to: ${r.archiveRoot || "_Archive"}`);
  } catch (e) {
    showStatusToast(e.message || "Archive failed");
  }
}

//
// Preview (uses server /api/preview/text|binary|imageThumb) :contentReference[oaicite:14]{index=14}
//
function getPrismLangFromExt(ext) {
  const e = String(ext || "").toLowerCase();
  const map = {
    ".json": "json",
    ".js": "javascript",
    ".jsx": "javascript",
    ".ts": "typescript",
    ".tsx": "typescript",
    ".py": "python",
    ".md": "markdown",
    ".css": "css",
    ".html": "markup",
    ".htm": "markup",
    ".xml": "markup"
  };
  return map[e] || "markup";
}

function ensureTab(path) {
  const existing = state.tabs.find(t => isSamePath(t.path, path));
  if (existing) return existing;

  // cap 5
  if (state.tabs.length >= 5) state.tabs.shift();

  const tab = { path, title: basename(path), kind: "loading", offset: 0, lines: [], hasMore: false, thumbUrl: null, meta: null, prismLang: "markup" };
  state.tabs.push(tab);
  return tab;
}

function setActiveTab(path) {
  state.activeTabPath = path;
  renderTabs();
}

function renderTabs() {
  tabsEl.innerHTML = "";
  for (const t of state.tabs) {
    const tabEl = document.createElement("div");
    tabEl.className = "tab" + (isSamePath(state.activeTabPath, t.path) ? " active" : "");
    tabEl.title = t.path;

    const label = document.createElement("div");
    label.className = "tabLabel";
    label.textContent = t.title;

    const close = document.createElement("button");
    close.className = "tabClose";
    close.textContent = "×";
    close.addEventListener("click", (e) => {
      e.stopPropagation();
      closeTab(t.path);
    });

    tabEl.appendChild(label);
    tabEl.appendChild(close);

    tabEl.addEventListener("click", async () => {
      setActiveTab(t.path);
      await renderActiveTab();
    });

    tabsEl.appendChild(tabEl);
  }

  if (!state.tabs.length) {
    previewEl.innerHTML = `<div class="previewEmpty">Double-click a file (or press Enter) to preview.</div>`;
  }
}

function closeTab(path) {
  const idx = state.tabs.findIndex(t => isSamePath(t.path, path));
  if (idx >= 0) state.tabs.splice(idx, 1);

  if (state.tabs.length === 0) {
    state.activeTabPath = null;
    renderTabs();
    return;
  }

  if (state.activeTabPath && isSamePath(state.activeTabPath, path)) {
    state.activeTabPath = state.tabs[Math.max(0, idx - 1)].path;
  }
  renderTabs();
  renderActiveTab().catch(() => { });
}

async function openPreview(itemOrPath) {
  const it = typeof itemOrPath === "string"
    ? state.listItems.find(x => isSamePath(x.path, itemOrPath)) || { path: itemOrPath, name: basename(itemOrPath), type: "file", ext: "", isText: false, isImage: false }
    : itemOrPath;

  const tab = ensureTab(it.path);
  tab.title = it.name || basename(it.path);
  tab.prismLang = getPrismLangFromExt(it.ext);
  tab.kind = "loading";
  tab.offset = 0;
  tab.lines = [];
  tab.thumbUrl = null;
  tab.meta = null;

  setActiveTab(it.path);
  renderActiveTabLoading();

  // decide which preview endpoint to use
  try {
    if (it.isImage) {
      tab.kind = "image";
      tab.thumbUrl = `/api/preview/imageThumb?path=${encodeURIComponent(it.path)}&max=360`;
      tab.meta = {
        path: it.path,
        size: it.sizeHuman || humanSize(it.sizeBytes),
        modified: fmtDate(it.mtimeISO)
      };
    } else if (it.isText) {
      tab.kind = "text";
      await loadTextPage(it.path, 0);
      return;
    } else {
      tab.kind = "binary";
      const meta = await apiGet(`/api/preview/binary?path=${encodeURIComponent(it.path)}`);
      tab.meta = meta;
    }

    renderTabs();
    await renderActiveTab();
  } catch (e) {
    tab.kind = "error";
    tab.meta = { error: e.message || "Preview failed" };
    renderTabs();
    await renderActiveTab();
  }
}

async function loadTextPage(path, offset) {
  const tab = state.tabs.find(t => isSamePath(t.path, path));
  if (!tab) return;
  tab.kind = "loading";
  tab.offset = offset;
  renderTabs();
  renderActiveTabLoading();

  const r = await apiGet(`/api/preview/text?path=${encodeURIComponent(path)}&offset=${encodeURIComponent(offset)}&limit=100`); // :contentReference[oaicite:15]{index=15}
  tab.kind = "text";
  tab.lines = r.lines || [];
  tab.offset = r.offset || offset;
  tab.hasMore = !!r.hasMore;

  renderTabs();
  await renderActiveTab();
}

function renderActiveTabLoading() {
  previewEl.innerHTML = `<div class="previewLoading">Loading preview…</div>`;
}

async function renderActiveTab() {
  const p = state.activeTabPath;
  const tab = state.tabs.find(t => isSamePath(t.path, p));
  if (!tab) return;

  if (tab.kind === "loading") {
    renderActiveTabLoading();
    return;
  }

  if (tab.kind === "error") {
    previewEl.innerHTML = `<div class="previewError">${escHtml(tab.meta?.error || "Preview error")}</div>`;
    return;
  }

  if (tab.kind === "image") {
    const meta = tab.meta || {};
    previewEl.innerHTML = `
      <div class="previewHeader">
        <div class="previewTitle">${escHtml(tab.title)}</div>
        <div class="hint">Thumbnail only (no editing)</div>
      </div>
      <div class="imageWrap">
        <img class="thumb" src="${escHtml(tab.thumbUrl)}" alt="thumbnail">
      </div>
      <div class="metaGrid">
        ${renderMetaRow("Path", meta.path || tab.path)}
        ${renderMetaRow("Size", meta.size || "—")}
        ${renderMetaRow("Modified", meta.modified || "—")}
      </div>
    `;
    return;
  }

  if (tab.kind === "binary") {
    const meta = tab.meta || {};
    previewEl.innerHTML = `
      <div class="previewHeader">
        <div class="previewTitle">${escHtml(tab.title)}</div>
        <div class="hint">Binary/unknown file: metadata only</div>
      </div>
      <div class="metaGrid">
        ${renderMetaRow("Path", meta.path || tab.path)}
        ${renderMetaRow("Size", meta.sizeHuman || "—")}
        ${renderMetaRow("Modified", meta.mtimeISO ? fmtDate(meta.mtimeISO) : "—")}
        ${renderMetaRow("MIME", meta.mime || "application/octet-stream")}
        ${renderMetaRow("SHA-256", meta.sha256 || "—")}
      </div>
    `;
    return;
  }

  // text
  const start = tab.offset + 1;
  const end = tab.offset + (tab.lines?.length || 0);

  previewEl.innerHTML = `
    <div class="previewHeader">
      <div class="previewTitle">${escHtml(tab.title)}</div>
      <div class="previewPager">
        <button id="prev100" class="btn btnSmall">Prev 100</button>
        <div class="pageInfo">Lines ${start}–${end}</div>
        <button id="next100" class="btn btnSmall">Next 100</button>
      </div>
    </div>
    <pre class="previewPre"><code id="codeBlock" class="language-${escHtml(tab.prismLang)}"></code></pre>
  `;

  const codeBlock = document.getElementById("codeBlock");
  codeBlock.textContent = (tab.lines || []).join("\n");

  try {
    if (window.Prism && Prism.highlightElement) Prism.highlightElement(codeBlock);
  } catch { }

  const prev = document.getElementById("prev100");
  const next = document.getElementById("next100");
  prev.disabled = tab.offset <= 0;
  next.disabled = !tab.hasMore;

  prev.onclick = async () => { await loadTextPage(tab.path, Math.max(0, tab.offset - 100)); };
  next.onclick = async () => { await loadTextPage(tab.path, tab.offset + 100); };
}

function renderMetaRow(k, v) {
  return `
    <div class="metaRow">
      <div class="metaK">${escHtml(k)}</div>
      <div class="metaV">${escHtml(String(v ?? "—"))}</div>
    </div>
  `;
}

//
// Inspector (single + bulk) using /api/meta and /api/meta/bulk :contentReference[oaicite:16]{index=16}
//
async function openInspectorSingle(path) {
  // if multi-select, show bulk instead
  if (state.selection.size > 1) {
    await openInspectorBulk();
    return;
  }

  const item = state.listItems.find(x => isSamePath(x.path, path));
  const title = item?.name || basename(path);

  inspectorBody.innerHTML = `
    <div class="inspectorTop">
      <div class="inspectorName">${escHtml(title)}</div>
      <div class="inspectorPath" title="${escHtml(path)}">${escHtml(path)}</div>
      <div class="inspectorPills">
        <span class="pill">${escHtml(item?.type || "item")}</span>
        <span class="pill">${escHtml(item?.sizeHuman || humanSize(item?.sizeBytes))}</span>
        <span class="pill">${escHtml(fmtDate(item?.mtimeISO))}</span>
      </div>
    </div>

    <div class="field">
      <label>Description</label>
      <textarea id="descField" class="textarea" rows="6" placeholder="Description (saved to local JSON index)…"></textarea>
      <div class="fieldHint" id="descStatus">—</div>
    </div>

    <div class="field">
      <label>Tags</label>
      <div id="tagChips" class="chips"></div>
      <input id="tagInput" class="input" placeholder="Add tag (#archive) and press Enter…">
      <div id="tagSuggest" class="suggest"></div>
    </div>

    <div class="field">
      <button id="copyItemPath" class="btn btnSmall">Copy path</button>
    </div>
  `;

  const descField = document.getElementById("descField");
  const descStatus = document.getElementById("descStatus");
  const tagChips = document.getElementById("tagChips");
  const tagInput = document.getElementById("tagInput");
  const tagSuggest = document.getElementById("tagSuggest");
  const copyItemPath = document.getElementById("copyItemPath");

  copyItemPath.onclick = async () => {
    try { await navigator.clipboard.writeText(path); showStatusToast("Copied."); }
    catch { showStatusToast("Copy failed"); }
  };

  // Load meta from server
  try {
    const m = await apiGet(`/api/meta?path=${encodeURIComponent(path)}`); // :contentReference[oaicite:17]{index=17}
    descField.value = m.description || "";
    renderTags(tagChips, m.tags || []);
    descStatus.textContent = "Loaded";
  } catch (e) {
    descField.value = "";
    renderTags(tagChips, []);
    descStatus.textContent = e.message || "Failed to load metadata";
  }

  const saveMeta = debounce(async () => {
    try {
      descStatus.textContent = "Saving…";
      await apiPost("/api/meta", { path, description: descField.value, tags: getTagsFromChips(tagChips) }); // :contentReference[oaicite:18]{index=18}
      descStatus.textContent = "Saved";
      await loadKnownTags();
    } catch (e) {
      descStatus.textContent = e.message || "Save failed";
    }
  }, 300);

  descField.addEventListener("input", () => {
    descStatus.textContent = "Unsaved…";
    saveMeta();
  });

  tagInput.addEventListener("keydown", async (e) => {
    if (e.key !== "Enter") return;
    e.preventDefault();
    const t = normalizeTag(tagInput.value);
    if (!t) return;
    addTagChip(tagChips, t);
    tagInput.value = "";
    tagSuggest.innerHTML = "";
    saveMeta();
  });

  tagInput.addEventListener("input", () => {
    const q = normalizeTag(tagInput.value, true);
    renderTagSuggestions(tagSuggest, q, (picked) => {
      addTagChip(tagChips, picked);
      tagInput.value = "";
      tagSuggest.innerHTML = "";
      saveMeta();
    });
  });

  tagChips.addEventListener("click", (e) => {
    const btn = e.target.closest("button[data-tag]");
    if (!btn) return;
    btn.parentElement.remove();
    saveMeta();
  });
}

async function openInspectorBulk() {
  const count = state.selection.size;
  if (count <= 1) return;

  inspectorBody.innerHTML = `
    <div class="inspectorTop">
      <div class="inspectorName">Bulk edit</div>
      <div class="inspectorPath">${count} items selected</div>
      <div class="inspectorPills"><span class="pill">Bulk apply</span></div>
    </div>

    <div class="field">
      <label>Append to description</label>
      <textarea id="bulkDesc" class="textarea" rows="4" placeholder="Appended to each selected item…"></textarea>
    </div>

    <div class="field">
      <label>Add tags</label>
      <div id="bulkTagChips" class="chips"></div>
      <input id="bulkTagInput" class="input" placeholder="Add tag and press Enter…">
      <div id="bulkTagSuggest" class="suggest"></div>
    </div>

    <div class="field">
      <label>Remove tags</label>
      <div id="bulkRemoveChips" class="chips"></div>
      <input id="bulkRemoveInput" class="input" placeholder="Remove tag and press Enter…">
      <div id="bulkRemoveSuggest" class="suggest"></div>
    </div>

    <div class="field actions">
      <button id="bulkApplyBtn" class="btn danger">Apply</button>
    </div>
  `;

  const bulkDesc = document.getElementById("bulkDesc");
  const bulkTagChips = document.getElementById("bulkTagChips");
  const bulkTagInput = document.getElementById("bulkTagInput");
  const bulkTagSuggest = document.getElementById("bulkTagSuggest");

  const bulkRemoveChips = document.getElementById("bulkRemoveChips");
  const bulkRemoveInput = document.getElementById("bulkRemoveInput");
  const bulkRemoveSuggest = document.getElementById("bulkRemoveSuggest");

  const bulkApplyBtn = document.getElementById("bulkApplyBtn");

  renderTags(bulkTagChips, []);
  renderTags(bulkRemoveChips, []);

  wireTagInput(bulkTagInput, bulkTagSuggest, bulkTagChips);
  wireTagInput(bulkRemoveInput, bulkRemoveSuggest, bulkRemoveChips);

  bulkTagChips.addEventListener("click", (e) => {
    const btn = e.target.closest("button[data-tag]");
    if (!btn) return;
    btn.parentElement.remove();
  });
  bulkRemoveChips.addEventListener("click", (e) => {
    const btn = e.target.closest("button[data-tag]");
    if (!btn) return;
    btn.parentElement.remove();
  });

  bulkApplyBtn.onclick = async () => {
    const paths = Array.from(state.selection);
    const addTags = getTagsFromChips(bulkTagChips);
    const removeTags = getTagsFromChips(bulkRemoveChips);
    const appendDesc = String(bulkDesc.value || "").trim();

    const any = addTags.length || removeTags.length || appendDesc.length;
    if (!any) {
      showStatusToast("Nothing to apply.");
      return;
    }

    const ok = await confirmModal("Apply metadata", `Apply changes to ${paths.length} item(s)?`, "Apply");
    if (!ok) return;

    try {
      if (addTags.length) {
        await apiPost("/api/meta/bulk", { paths, op: "addTags", tags: addTags }); // :contentReference[oaicite:19]{index=19}
      }
      if (removeTags.length) {
        await apiPost("/api/meta/bulk", { paths, op: "removeTags", tags: removeTags }); // :contentReference[oaicite:20]{index=20}
      }
      if (appendDesc.length) {
        await apiPost("/api/meta/bulk", { paths, op: "appendDescription", description: appendDesc }); // :contentReference[oaicite:21]{index=21}
      }

      await loadKnownTags();
      showStatusToast("Applied.");
    } catch (e) {
      showStatusToast(e.message || "Bulk apply failed");
    }
  };
}

function wireTagInput(inputEl, suggestEl, chipsEl) {
  inputEl.addEventListener("keydown", (e) => {
    if (e.key !== "Enter") return;
    e.preventDefault();
    const t = normalizeTag(inputEl.value);
    if (!t) return;
    addTagChip(chipsEl, t);
    inputEl.value = "";
    suggestEl.innerHTML = "";
  });

  inputEl.addEventListener("input", () => {
    const q = normalizeTag(inputEl.value, true);
    renderTagSuggestions(suggestEl, q, (picked) => {
      addTagChip(chipsEl, picked);
      inputEl.value = "";
      suggestEl.innerHTML = "";
    });
  });
}

function normalizeTag(raw, allowPartial = false) {
  let t = String(raw || "").trim();
  if (!t) return "";
  if (!t.startsWith("#")) t = "#" + t;
  if (!allowPartial) {
    t = t.toLowerCase().replace(/\s+/g, "");
    if (t === "#") return "";
  }
  return t;
}

function renderTags(container, tags) {
  container.innerHTML = "";
  (tags || []).forEach(t => addTagChip(container, t));
}

function addTagChip(container, tag) {
  const t = normalizeTag(tag);
  if (!t) return;

  const exists = Array.from(container.querySelectorAll(".chip")).some(ch => ch.dataset.tag === t);
  if (exists) return;

  const chip = document.createElement("div");
  chip.className = "chip";
  chip.dataset.tag = t;

  const label = document.createElement("span");
  label.className = "chipLabel";
  label.textContent = t;

  const x = document.createElement("button");
  x.className = "chipX";
  x.type = "button";
  x.dataset.tag = t;
  x.textContent = "×";

  chip.appendChild(label);
  chip.appendChild(x);
  container.appendChild(chip);
}

function getTagsFromChips(container) {
  return Array.from(container.querySelectorAll(".chip"))
    .map(ch => ch.dataset.tag)
    .filter(Boolean);
}

function renderTagSuggestions(container, q, onPick) {
  container.innerHTML = "";
  const query = (q || "").toLowerCase();
  if (!query || query === "#") return;

  const matches = (state.knownTags || [])
    .map(t => normalizeTag(t))
    .filter(t => t.toLowerCase().includes(query))
    .slice(0, 8);

  for (const t of matches) {
    const b = document.createElement("button");
    b.className = "suggestItem";
    b.type = "button";
    b.textContent = t;
    b.onclick = () => onPick(t);
    container.appendChild(b);
  }
}

//
// Search (uses /api/search; note server returns minimal {path,name,meta}) :contentReference[oaicite:22]{index=22}
//
const runSearch = debounce(async () => {
  const q = String(globalSearch.value || "").trim();
  if (!q) {
    await loadDir(state.currentDir);
    return;
  }

  try {
    const r = await apiGet(`/api/search?q=${encodeURIComponent(q)}`); // :contentReference[oaicite:23]{index=23}
    const items = (r.items || []).map(x => ({
      name: x.name || basename(x.path),
      path: x.path,
      type: "other",          // unknown without parent list; we keep placeholders
      ext: "",
      sizeBytes: null,
      sizeHuman: "—",
      mtimeISO: null,
      isText: false,
      isImage: false,
      meta: x.meta || { description: "", tags: [] }
    }));
    state.listItems = items;
    renderBreadcrumbs(`${state.currentDir}  (Search: ${q})`);
    renderList();
    updateActionBar();
  } catch (e) {
    showStatusToast(e.message || "Search failed");
  }
}, 250);

//
// Sorting header click (index.html has .listHeader .sort[data-sort]) :contentReference[oaicite:24]{index=24}
//
function hookSortHeaders() {
  const headers = document.querySelectorAll(".listHeader .sort");
  headers.forEach(h => {
    h.addEventListener("click", () => {
      const key = h.dataset.sort;
      if (!key) return;
      if (state.sortKey === key) state.sortDir = (state.sortDir === "asc" ? "desc" : "asc");
      else { state.sortKey = key; state.sortDir = "asc"; }
      renderList();
    });
  });
}

//
// Events + keyboard
//
function hookEvents() {
  hookSortHeaders();

  themeBtn.onclick = () => setTheme(state.theme === "dark" ? "light" : "dark");

  copyPathBtn.onclick = async () => {
    try { await navigator.clipboard.writeText(state.currentDir); showStatusToast("Copied."); }
    catch { showStatusToast("Copy failed"); }
  };

  refreshBtn.onclick = async () => {
    // server uses POST /api/scan to start/resume scan :contentReference[oaicite:25]{index=25}
    try {
      await apiPost("/api/scan", {});
      await refreshScanStatus();
      await refreshDirList();
      renderList();
      await renderTree();
      showStatusToast("Scan started.");
    } catch (e) {
      showStatusToast(e.message || "Refresh failed");
    }
  };

  globalSearch.addEventListener("input", runSearch);

  // Timeline view controls
  viewFoldersBtn.onclick = async () => {
    if (state.viewMode === 'folders') return;
    state.viewMode = 'folders';
    updateViewModeUI();
    await loadDir(state.currentDir);
  };

  viewTimelineBtn.onclick = async () => {
    if (state.viewMode === 'timeline') return;
    state.viewMode = 'timeline';
    state.timeline.offset = 0;
    updateViewModeUI();
    await loadTimeline();
  };

  sortBySelect.onchange = async () => {
    state.timeline.sortBy = sortBySelect.value;
    state.timeline.offset = 0;
    await loadTimeline();
  };

  groupBySelect.onchange = async () => {
    state.timeline.groupBy = groupBySelect.value;
    state.timeline.offset = 0;
    await loadTimeline();
  };

  prevGroupsBtn.onclick = async () => {
    if (state.timeline.offset > 0) {
      state.timeline.offset -= state.timeline.limit;
      if (state.timeline.offset < 0) state.timeline.offset = 0;
      await loadTimeline();
    }
  };

  nextGroupsBtn.onclick = async () => {
    if (state.timeline.hasMore) {
      state.timeline.offset += state.timeline.limit;
      await loadTimeline();
    }
  };

  selectAllBtn.onclick = async () => {
    for (const it of state.listItems) state.selection.add(it.path);
    renderList();
    updateActionBar();
    await renderTree();
  };
  selectNoneBtn.onclick = async () => {
    state.selection.clear();
    renderList();
    updateActionBar();
    await renderTree();
  };
  invertBtn.onclick = async () => {
    for (const it of state.listItems) {
      if (state.selection.has(it.path)) state.selection.delete(it.path);
      else state.selection.add(it.path);
    }
    renderList();
    updateActionBar();
    await renderTree();
  };

  deleteBtn.onclick = doDeleteSelection;
  moveBtn.onclick = doMoveSelection;
  archiveBtn.onclick = doArchiveSelection;

  // Keyboard: arrows navigate, Space toggle, Enter preview/open, Del delete (guarded)
  document.addEventListener("keydown", async (e) => {
    const tag = (e.target && e.target.tagName) ? e.target.tagName.toLowerCase() : "";
    const typing = (tag === "input" || tag === "textarea");
    if (typing && e.key !== "Escape") return;

    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "f") {
      e.preventDefault();
      globalSearch.focus();
      return;
    }

    if (e.key === "Escape") {
      if (modal.style.display === "flex") modal.style.display = "none";
      return;
    }

    const items = sortedList();
    if (!items.length) return;

    if (e.key === "ArrowDown") {
      e.preventDefault();
      state.focusedIndex = Math.min(items.length - 1, (state.focusedIndex < 0 ? 0 : state.focusedIndex + 1));
      state.focusedPath = items[state.focusedIndex].path;
      await openInspectorSingle(state.focusedPath);
      renderList();
      scrollFocusedIntoView();
      return;
    }

    if (e.key === "ArrowUp") {
      e.preventDefault();
      state.focusedIndex = Math.max(0, (state.focusedIndex < 0 ? 0 : state.focusedIndex - 1));
      state.focusedPath = items[state.focusedIndex].path;
      await openInspectorSingle(state.focusedPath);
      renderList();
      scrollFocusedIntoView();
      return;
    }

    if (e.key === " ") {
      e.preventDefault();
      const it = items[state.focusedIndex < 0 ? 0 : state.focusedIndex];
      if (!it) return;
      if (state.selection.has(it.path)) state.selection.delete(it.path);
      else state.selection.add(it.path);
      updateActionBar();
      renderList();
      await renderTree();
      return;
    }

    if (e.key === "Enter") {
      e.preventDefault();
      const it = items[state.focusedIndex < 0 ? 0 : state.focusedIndex];
      if (!it) return;
      if (it.type === "folder") await loadDir(it.path);
      else await openPreview(it);
      return;
    }

    if (e.key === "Delete") {
      e.preventDefault();
      if (state.selection.size > 0) await doDeleteSelection();
      return;
    }
  });
}

function scrollFocusedIntoView() {
  const p = state.focusedPath;
  if (!p) return;
  // Use attribute selector safely
  const row = Array.from(listEl.querySelectorAll(".listRow")).find(r => isSamePath(r.dataset.path, p));
  if (row && row.scrollIntoView) row.scrollIntoView({ block: "nearest" });
}

//
// Boot
//
renderTabs();
init().catch((e) => {
  console.error(e);
  showStatusToast(e.message || "Initialization failed");
});
