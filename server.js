const express = require("express");
const cors = require("cors");
const os = require("os");
const path = require("path");
const fs = require("fs");
const fsp = fs.promises;
const crypto = require("crypto");
const mime = require("mime-types");
const sharp = require("sharp");
const readline = require("readline");

const app = express();
app.use(cors());
app.use(express.json({ limit: "2mb" }));
app.use(express.static(path.join(__dirname, "public")));

const DATA_DIR = path.join(__dirname, "data");
const INDEX_PATH = path.join(DATA_DIR, "index.json");

function winNormalize(p) {
  // Keep Windows paths consistent; avoid trailing separators except root.
  return path.win32.normalize(p);
}

function getRootPath() {
  const username = os.userInfo().username;
  return winNormalize(`C:\\Users\\${username}`);
}

const ROOT = getRootPath();

// Danger actions are OFF by default. Enable explicitly if you want.
const ALLOW_DANGEROUS_ACTIONS = String(process.env.ALLOW_DANGEROUS_ACTIONS || "").toLowerCase() === "true";

// -----------------------
// Security: keep all paths inside ROOT
// -----------------------
function ensureInsideRoot(absPath) {
  const normalized = winNormalize(absPath);
  const rootNorm = winNormalize(ROOT);

  // Case-insensitive compare for Windows paths
  const nLower = normalized.toLowerCase();
  const rLower = rootNorm.toLowerCase();

  if (nLower === rLower) return normalized;
  if (nLower.startsWith(rLower + "\\")) return normalized;

  const err = new Error("Path is outside allowed root.");
  err.status = 400;
  throw err;
}

function absFromQuery(qPath) {
  if (!qPath) return ROOT;
  const decoded = decodeURIComponent(qPath);
  const normalized = winNormalize(decoded);
  return ensureInsideRoot(normalized);
}

// -----------------------
// JSON index (descriptions/tags)
// -----------------------
async function ensureDataDir() {
  await fsp.mkdir(DATA_DIR, { recursive: true });
  try {
    await fsp.access(INDEX_PATH, fs.constants.F_OK);
  } catch {
    await fsp.writeFile(INDEX_PATH, JSON.stringify({ version: 1, items: {} }, null, 2), "utf8");
  }
}

async function readIndex() {
  await ensureDataDir();
  const raw = await fsp.readFile(INDEX_PATH, "utf8");
  let json;
  try {
    json = JSON.parse(raw);
  } catch {
    json = { version: 1, items: {} };
  }
  if (!json.items) json.items = {};
  return json;
}

async function writeIndex(json) {
  await ensureDataDir();
  await fsp.writeFile(INDEX_PATH, JSON.stringify(json, null, 2), "utf8");
}

function getMetaFromIndex(indexJson, absPath) {
  const item = indexJson.items[absPath];
  if (!item) return { description: "", tags: [] };
  return {
    description: String(item.description || ""),
    tags: Array.isArray(item.tags) ? item.tags : []
  };
}

function normalizeTags(tags) {
  const out = [];
  if (!Array.isArray(tags)) return out;
  for (const t of tags) {
    const s = String(t || "").trim();
    if (!s) continue;
    const normalized = s.startsWith("#") ? s.toLowerCase() : ("#" + s.toLowerCase());
    if (!out.includes(normalized)) out.push(normalized);
  }
  return out;
}

// -----------------------
// File classification
// -----------------------
const TEXT_EXT = new Set([
  ".txt", ".md", ".json", ".js", ".ts", ".jsx", ".tsx", ".css", ".html", ".htm",
  ".py", ".java", ".c", ".cpp", ".h", ".hpp", ".cs", ".go", ".rs", ".php", ".rb",
  ".yml", ".yaml", ".toml", ".ini", ".log", ".xml", ".sql", ".sh", ".bat", ".ps1",
  ".csv"
]);

const IMAGE_EXT = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".tiff", ".tif"
]);

function classifyByExt(absPath) {
  const ext = path.extname(absPath).toLowerCase();
  const isText = TEXT_EXT.has(ext);
  const isImage = IMAGE_EXT.has(ext);
  return { ext, isText, isImage };
}

async function isLikelyText(absPath) {
  const { ext, isText } = classifyByExt(absPath);
  if (isText) return true;
  // Heuristic: check first chunk for NUL bytes
  try {
    const fd = await fsp.open(absPath, "r");
    const buf = Buffer.alloc(4096);
    const { bytesRead } = await fd.read(buf, 0, buf.length, 0);
    await fd.close();
    const slice = buf.subarray(0, bytesRead);
    return !slice.includes(0);
  } catch {
    return false;
  }
}

// -----------------------
// Scan index (in-memory) for search/stats and folder sizes
// -----------------------
let scanState = {
  running: false,
  startedAt: 0,
  finishedAt: 0,
  scannedFiles: 0,
  scannedFolders: 0,
  errors: 0,
  totalSizeBytes: 0,
  largestFiles: [],
  // maps
  fileInfo: new Map(),   // absPath -> { sizeBytes, mtimeMs, ext, name, parent }
  folderChildren: new Map(), // folderAbs -> array of childAbs (files+folders)
  folderSizeCache: new Map(), // folderAbs -> sizeBytes
  flatList: [] // array for search: { path, nameLower, pathLower }
};

function considerLargest(filePath, sizeBytes) {
  const entry = { path: filePath, sizeBytes };
  scanState.largestFiles.push(entry);
  scanState.largestFiles.sort((a, b) => b.sizeBytes - a.sizeBytes);
  if (scanState.largestFiles.length > 20) scanState.largestFiles.length = 20;
}

async function scanTree(rootAbs) {
  scanState.running = true;
  scanState.startedAt = Date.now();
  scanState.finishedAt = 0;
  scanState.scannedFiles = 0;
  scanState.scannedFolders = 0;
  scanState.errors = 0;
  scanState.totalSizeBytes = 0;
  scanState.largestFiles = [];
  scanState.fileInfo = new Map();
  scanState.folderChildren = new Map();
  scanState.folderSizeCache = new Map();
  scanState.flatList = [];

  async function walk(dirAbs) {
    scanState.scannedFolders++;
    let entries;
    try {
      entries = await fsp.readdir(dirAbs, { withFileTypes: true });
    } catch {
      scanState.errors++;
      return;
    }

    const children = [];
    for (const ent of entries) {
      const childAbs = winNormalize(path.join(dirAbs, ent.name));
      try {
        ensureInsideRoot(childAbs);
      } catch {
        // Should not happen; skip
        continue;
      }

      children.push(childAbs);

      if (ent.isDirectory()) {
        await walk(childAbs);
      } else if (ent.isFile()) {
        scanState.scannedFiles++;
        let st;
        try {
          st = await fsp.stat(childAbs);
        } catch {
          scanState.errors++;
          continue;
        }
        const { ext } = classifyByExt(childAbs);
        const info = {
          path: childAbs,
          name: ent.name,
          parent: dirAbs,
          sizeBytes: st.size,
          mtimeMs: st.mtimeMs,
          ctimeMs: st.ctimeMs,
          birthtimeMs: st.birthtimeMs,
          ext
        };
        scanState.fileInfo.set(childAbs, info);
        scanState.totalSizeBytes += st.size;
        considerLargest(childAbs, st.size);
        scanState.flatList.push({
          path: childAbs,
          nameLower: ent.name.toLowerCase(),
          pathLower: childAbs.toLowerCase()
        });
      } else {
        // ignore symlinks/others for safety
      }
    }

    scanState.folderChildren.set(dirAbs, children);
    scanState.flatList.push({
      path: dirAbs,
      nameLower: path.basename(dirAbs).toLowerCase(),
      pathLower: dirAbs.toLowerCase()
    });
  }

  await walk(rootAbs);

  // Build folder sizes bottom-up using recursion with memoization:
  const folderSize = async (folderAbs) => {
    if (scanState.folderSizeCache.has(folderAbs)) return scanState.folderSizeCache.get(folderAbs);
    const kids = scanState.folderChildren.get(folderAbs) || [];
    let sum = 0;
    for (const k of kids) {
      if (scanState.fileInfo.has(k)) {
        sum += scanState.fileInfo.get(k).sizeBytes;
      } else {
        // folder
        sum += await folderSize(k);
      }
    }
    scanState.folderSizeCache.set(folderAbs, sum);
    return sum;
  };

  // Ensure root size computed
  await folderSize(rootAbs);

  scanState.running = false;
  scanState.finishedAt = Date.now();
}

// Kick initial scan on startup (non-blocking)
ensureDataDir().then(() => {
  scanTree(ROOT).catch(() => { });
});

// -----------------------
// Helpers
// -----------------------
function humanSize(bytes) {
  if (bytes == null || Number.isNaN(bytes)) return "";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let b = bytes;
  let i = 0;
  while (b >= 1024 && i < units.length - 1) {
    b /= 1024;
    i++;
  }
  return `${b.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

async function statSafe(absPath) {
  try {
    return await fsp.stat(absPath);
  } catch {
    return null;
  }
}

function itemPayload(absPath, st, indexJson) {
  const base = path.basename(absPath);
  const isDir = st && st.isDirectory();
  const isFile = st && st.isFile();
  const { ext, isText, isImage } = classifyByExt(absPath);

  let sizeBytes = null;
  if (isFile) sizeBytes = st.size;
  if (isDir) {
    // Use scan cache if available
    if (scanState.folderSizeCache && scanState.folderSizeCache.has(absPath)) {
      sizeBytes = scanState.folderSizeCache.get(absPath);
    }
  }

  const meta = getMetaFromIndex(indexJson, absPath);

  return {
    name: base,
    path: absPath,
    type: isDir ? "folder" : (isFile ? "file" : "other"),
    ext,
    sizeBytes,
    sizeHuman: humanSize(sizeBytes),
    mtimeMs: st ? st.mtimeMs : null,
    mtimeISO: st ? new Date(st.mtimeMs).toISOString() : null,
    isText,
    isImage,
    meta
  };
}

async function safeRenameOrCopyDelete(src, dst) {
  try {
    await fsp.mkdir(path.dirname(dst), { recursive: true });
    await fsp.rename(src, dst);
    return;
  } catch (e) {
    // Cross-device or permission: fallback copy+delete
  }

  const st = await statSafe(src);
  if (!st) return;

  if (st.isDirectory()) {
    await fsp.mkdir(dst, { recursive: true });
    const entries = await fsp.readdir(src, { withFileTypes: true });
    for (const ent of entries) {
      const s = path.join(src, ent.name);
      const d = path.join(dst, ent.name);
      await safeRenameOrCopyDelete(s, d);
    }
    await fsp.rm(src, { recursive: true, force: true });
  } else if (st.isFile()) {
    await fsp.mkdir(path.dirname(dst), { recursive: true });
    await new Promise((resolve, reject) => {
      const rs = fs.createReadStream(src);
      const ws = fs.createWriteStream(dst);
      rs.on("error", reject);
      ws.on("error", reject);
      ws.on("finish", resolve);
      rs.pipe(ws);
    });
    await fsp.rm(src, { force: true });
  }
}

// -----------------------
// API
// -----------------------
app.get("/api/root", async (req, res) => {
  res.json({
    rootPath: ROOT,
    username: os.userInfo().username,
    dangerousActionsEnabled: ALLOW_DANGEROUS_ACTIONS
  });
});

app.post("/api/scan", async (req, res) => {
  if (scanState.running) {
    return res.json({ ok: true, running: true });
  }
  scanTree(ROOT).catch(() => { });
  res.json({ ok: true, running: true });
});

app.get("/api/scan/status", async (req, res) => {
  res.json({
    running: scanState.running,
    startedAt: scanState.startedAt,
    finishedAt: scanState.finishedAt,
    scannedFiles: scanState.scannedFiles,
    scannedFolders: scanState.scannedFolders,
    errors: scanState.errors,
    totalSizeBytes: scanState.totalSizeBytes,
    totalSizeHuman: humanSize(scanState.totalSizeBytes),
    largestFiles: scanState.largestFiles.slice(0, 10).map(x => ({
      path: x.path,
      sizeBytes: x.sizeBytes,
      sizeHuman: humanSize(x.sizeBytes)
    }))
  });
});

app.get("/api/list", async (req, res, next) => {
  try {
    const abs = absFromQuery(req.query.path || "");
    const st = await statSafe(abs);
    if (!st || !st.isDirectory()) return res.status(400).json({ error: "Not a directory." });

    const indexJson = await readIndex();

    let entries = [];
    try {
      entries = await fsp.readdir(abs, { withFileTypes: true });
    } catch (e) {
      return res.status(403).json({ error: "Cannot read directory (permission denied)." });
    }

    const items = [];
    for (const ent of entries) {
      if (!ent.isDirectory() && !ent.isFile()) continue;
      const childAbs = winNormalize(path.join(abs, ent.name));
      try {
        ensureInsideRoot(childAbs);
      } catch {
        continue;
      }

      const cst = await statSafe(childAbs);
      if (!cst) continue;
      items.push(itemPayload(childAbs, cst, indexJson));
    }

    res.json({
      ok: true,
      path: abs,
      items
    });
  } catch (e) {
    next(e);
  }
});

app.get("/api/meta", async (req, res, next) => {
  try {
    const abs = absFromQuery(req.query.path);
    const indexJson = await readIndex();
    const meta = getMetaFromIndex(indexJson, abs);
    res.json({ ok: true, path: abs, ...meta });
  } catch (e) {
    next(e);
  }
});

app.post("/api/meta", async (req, res, next) => {
  try {
    const abs = absFromQuery(req.body.path);
    const description = String(req.body.description || "");
    const tags = normalizeTags(req.body.tags);

    const indexJson = await readIndex();
    indexJson.items[abs] = {
      description,
      tags,
      updatedAt: Date.now()
    };
    await writeIndex(indexJson);

    res.json({ ok: true });
  } catch (e) {
    next(e);
  }
});

app.post("/api/meta/bulk", async (req, res, next) => {
  try {
    const paths = Array.isArray(req.body.paths) ? req.body.paths : [];
    const op = String(req.body.op || "");
    const tags = normalizeTags(req.body.tags);
    const description = String(req.body.description || "");

    const indexJson = await readIndex();

    for (const p of paths) {
      const abs = absFromQuery(p);
      const cur = getMetaFromIndex(indexJson, abs);
      let newDesc = cur.description;
      let newTags = normalizeTags(cur.tags);

      if (op === "addTags") {
        for (const t of tags) if (!newTags.includes(t)) newTags.push(t);
      } else if (op === "removeTags") {
        newTags = newTags.filter(t => !tags.includes(t));
      } else if (op === "setDescription") {
        newDesc = description;
      } else if (op === "appendDescription") {
        const add = description.trim();
        if (add) {
          newDesc = (newDesc ? (newDesc.trimEnd() + "\n") : "") + add;
        }
      }

      indexJson.items[abs] = {
        description: newDesc,
        tags: newTags,
        updatedAt: Date.now()
      };
    }

    await writeIndex(indexJson);
    res.json({ ok: true });
  } catch (e) {
    next(e);
  }
});

app.get("/api/tags", async (req, res, next) => {
  try {
    const indexJson = await readIndex();
    const counts = new Map();
    for (const k of Object.keys(indexJson.items)) {
      const tags = normalizeTags(indexJson.items[k].tags);
      for (const t of tags) counts.set(t, (counts.get(t) || 0) + 1);
    }
    const out = Array.from(counts.entries())
      .map(([tag, count]) => ({ tag, count }))
      .sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag));
    res.json({ ok: true, tags: out });
  } catch (e) {
    next(e);
  }
});

// Search across scan index + metadata index
app.get("/api/search", async (req, res, next) => {
  try {
    const q = String(req.query.q || "").trim();
    if (!q) return res.json({ ok: true, items: [] });

    const indexJson = await readIndex();
    const qLower = q.toLowerCase();

    // Simple token parsing: tag:#x, desc:"...", ext:pdf
    const tokens = q.split(/\s+/).filter(Boolean);
    const wants = { namePath: [], tag: [], desc: [], ext: [], sizeGt: null, sizeLt: null };
    for (const tok of tokens) {
      const t = tok.trim();
      if (t.toLowerCase().startsWith("tag:")) wants.tag.push(t.slice(4).toLowerCase());
      else if (t.toLowerCase().startsWith("ext:")) wants.ext.push("." + t.slice(4).toLowerCase().replace(/^\./, ""));
      else if (t.toLowerCase().startsWith("desc:")) wants.desc.push(t.slice(5).toLowerCase().replace(/^"|"$/g, ""));
      else if (t.toLowerCase().startsWith("size:")) {
        const v = t.slice(5);
        // size:>500MB or size:<10MB
        const m = v.match(/^([<>])\s*([\d.]+)\s*(b|kb|mb|gb|tb)$/i);
        if (m) {
          const op = m[1];
          const num = parseFloat(m[2]);
          const unit = m[3].toLowerCase();
          const mult = { b: 1, kb: 1024, mb: 1024 ** 2, gb: 1024 ** 3, tb: 1024 ** 4 }[unit] || 1;
          const bytes = Math.floor(num * mult);
          if (op === ">") wants.sizeGt = bytes;
          else wants.sizeLt = bytes;
        }
      } else {
        wants.namePath.push(t.toLowerCase());
      }
    }

    const results = [];
    const max = 300;

    // Use scanState.flatList for performance; if scan not ready, fallback to empty
    for (const item of scanState.flatList) {
      if (results.length >= max) break;
      const p = item.path;
      // only inside root already
      const base = path.basename(p);

      // ext filter
      if (wants.ext.length) {
        const ext = path.extname(p).toLowerCase();
        if (!wants.ext.includes(ext)) continue;
      }

      // size filters (files only)
      if (wants.sizeGt != null || wants.sizeLt != null) {
        const info = scanState.fileInfo.get(p);
        if (!info) continue;
        if (wants.sizeGt != null && info.sizeBytes <= wants.sizeGt) continue;
        if (wants.sizeLt != null && info.sizeBytes >= wants.sizeLt) continue;
      }

      // name/path tokens
      let ok = true;
      for (const np of wants.namePath) {
        if (!item.nameLower.includes(np) && !item.pathLower.includes(np)) { ok = false; break; }
      }
      if (!ok) continue;

      // metadata filters
      const meta = getMetaFromIndex(indexJson, p);
      if (wants.tag.length) {
        const mtags = normalizeTags(meta.tags).map(x => x.toLowerCase());
        for (const t of wants.tag) {
          const tt = t.startsWith("#") ? t : ("#" + t);
          if (!mtags.includes(tt)) { ok = false; break; }
        }
        if (!ok) continue;
      }

      if (wants.desc.length) {
        const d = (meta.description || "").toLowerCase();
        for (const dTok of wants.desc) {
          if (!d.includes(dTok)) { ok = false; break; }
        }
        if (!ok) continue;
      }

      results.push({ path: p, name: base, meta });
    }

    res.json({ ok: true, items: results });
  } catch (e) {
    next(e);
  }
});

// SAFE preview: text 100-line paging
app.get("/api/preview/text", async (req, res, next) => {
  try {
    const abs = absFromQuery(req.query.path);
    const offset = Math.max(0, parseInt(req.query.offset || "0", 10) || 0);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit || "100", 10) || 100));

    const st = await statSafe(abs);
    if (!st || !st.isFile()) return res.status(400).json({ error: "Not a file." });

    const likelyText = await isLikelyText(abs);
    if (!likelyText) return res.status(415).json({ error: "Not a text file (binary detected)." });

    const stream = fs.createReadStream(abs, { encoding: "utf8" });
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

    const lines = [];
    let idx = 0;
    let hasMore = false;

    for await (const line of rl) {
      if (idx < offset) {
        idx++;
        continue;
      }
      if (lines.length < limit) {
        lines.push(line);
      } else {
        hasMore = true;
        break;
      }
      idx++;
    }

    rl.close();
    stream.destroy();

    res.json({
      ok: true,
      path: abs,
      offset,
      limit,
      lines,
      hasMore
    });
  } catch (e) {
    next(e);
  }
});

// Preview: binary metadata only
app.get("/api/preview/binary", async (req, res, next) => {
  try {
    const abs = absFromQuery(req.query.path);
    const st = await statSafe(abs);
    if (!st || !st.isFile()) return res.status(400).json({ error: "Not a file." });

    const ct = mime.lookup(abs) || "application/octet-stream";
    // optional hash is expensive; provide only if requested
    const doHash = String(req.query.hash || "").toLowerCase() === "true";
    let sha256 = null;

    if (doHash) {
      sha256 = await new Promise((resolve, reject) => {
        const h = crypto.createHash("sha256");
        const rs = fs.createReadStream(abs);
        rs.on("error", reject);
        rs.on("data", (chunk) => h.update(chunk));
        rs.on("end", () => resolve(h.digest("hex")));
      });
    }

    res.json({
      ok: true,
      path: abs,
      sizeBytes: st.size,
      sizeHuman: humanSize(st.size),
      mtimeMs: st.mtimeMs,
      mtimeISO: new Date(st.mtimeMs).toISOString(),
      mime: ct,
      sha256
    });
  } catch (e) {
    next(e);
  }
});

// Image thumbnail only (resized server-side)
app.get("/api/preview/imageThumb", async (req, res, next) => {
  try {
    const abs = absFromQuery(req.query.path);
    const st = await statSafe(abs);
    if (!st || !st.isFile()) return res.status(400).json({ error: "Not a file." });

    const { isImage } = classifyByExt(abs);
    if (!isImage) return res.status(415).json({ error: "Not an image." });

    const max = Math.min(600, Math.max(120, parseInt(req.query.max || "360", 10) || 360));

    const buf = await sharp(abs)
      .resize({ width: max, height: max, fit: "inside", withoutEnlargement: true })
      .jpeg({ quality: 80 })
      .toBuffer();

    res.setHeader("Content-Type", "image/jpeg");
    res.setHeader("Cache-Control", "private, max-age=3600");
    res.send(buf);
  } catch (e) {
    next(e);
  }
});

// Actions: delete/move/archive (guarded)
app.post("/api/action/delete", async (req, res, next) => {
  try {
    if (!ALLOW_DANGEROUS_ACTIONS) return res.status(403).json({ error: "Dangerous actions disabled." });
    const paths = Array.isArray(req.body.paths) ? req.body.paths : [];
    for (const p of paths) {
      const abs = absFromQuery(p);
      await fsp.rm(abs, { recursive: true, force: true });
    }
    res.json({ ok: true });
  } catch (e) {
    next(e);
  }
});

app.post("/api/action/move", async (req, res, next) => {
  try {
    if (!ALLOW_DANGEROUS_ACTIONS) return res.status(403).json({ error: "Dangerous actions disabled." });
    const paths = Array.isArray(req.body.paths) ? req.body.paths : [];
    const dest = absFromQuery(req.body.destination);
    const dstSt = await statSafe(dest);
    if (!dstSt || !dstSt.isDirectory()) return res.status(400).json({ error: "Destination must be a directory." });

    for (const p of paths) {
      const abs = absFromQuery(p);
      const base = path.basename(abs);
      const target = winNormalize(path.join(dest, base));
      await safeRenameOrCopyDelete(abs, target);
    }
    res.json({ ok: true });
  } catch (e) {
    next(e);
  }
});

app.post("/api/action/archive", async (req, res, next) => {
  try {
    if (!ALLOW_DANGEROUS_ACTIONS) return res.status(403).json({ error: "Dangerous actions disabled." });
    const paths = Array.isArray(req.body.paths) ? req.body.paths : [];
    const date = new Date().toISOString().slice(0, 10);
    const archiveRoot = winNormalize(path.join(ROOT, "_Archive", date));
    await fsp.mkdir(archiveRoot, { recursive: true });

    for (const p of paths) {
      const abs = absFromQuery(p);
      // preserve relative path under ROOT
      const rel = path.relative(ROOT, abs);
      const target = winNormalize(path.join(archiveRoot, rel));
      await safeRenameOrCopyDelete(abs, target);
    }
    res.json({ ok: true, archiveRoot });
  } catch (e) {
    next(e);
  }
});

// Timeline: Get all files sorted by date, grouped by day/month, with pagination
app.get("/api/files/timeline", async (req, res, next) => {
  try {
    // Parameters:
    // - sortBy: 'created' | 'modified' (default: 'modified')
    // - groupBy: 'day' | 'month' (default: 'day')
    // - order: 'desc' | 'asc' (default: 'desc' = newest first)
    // - offset: number (which group to start from, default: 0)
    // - limit: number (how many groups to return, default: 5, max: 20)
    // - filesPerGroup: number (max files per group, default: 50)

    const sortBy = req.query.sortBy === 'created' ? 'created' : 'modified';
    const groupBy = req.query.groupBy === 'month' ? 'month' : 'day';
    const order = req.query.order === 'asc' ? 'asc' : 'desc';
    const offset = Math.max(0, parseInt(req.query.offset || '0', 10) || 0);
    const limit = Math.min(20, Math.max(1, parseInt(req.query.limit || '5', 10) || 5));
    const filesPerGroup = Math.min(100, Math.max(10, parseInt(req.query.filesPerGroup || '50', 10) || 50));

    // Collect all files from scanState
    const allFiles = [];
    for (const [filePath, info] of scanState.fileInfo.entries()) {
      const dateMs = sortBy === 'created'
        ? (info.birthtimeMs || info.ctimeMs || info.mtimeMs)
        : info.mtimeMs;

      allFiles.push({
        path: filePath,
        name: info.name,
        ext: info.ext,
        sizeBytes: info.sizeBytes,
        mtimeMs: info.mtimeMs,
        ctimeMs: info.ctimeMs,
        birthtimeMs: info.birthtimeMs,
        dateMs: dateMs
      });
    }

    // Sort all files by the selected date
    allFiles.sort((a, b) => {
      return order === 'desc'
        ? b.dateMs - a.dateMs
        : a.dateMs - b.dateMs;
    });

    // Group files by day or month
    const groupsMap = new Map();
    for (const file of allFiles) {
      const date = new Date(file.dateMs);
      let key;
      if (groupBy === 'month') {
        key = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
      } else {
        key = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
      }

      if (!groupsMap.has(key)) {
        groupsMap.set(key, []);
      }
      groupsMap.get(key).push(file);
    }

    // Convert to array and sort by key (date)
    let groupsArray = Array.from(groupsMap.entries()).map(([key, files]) => ({
      key,
      label: formatGroupLabel(key, groupBy),
      files: files.slice(0, filesPerGroup),
      totalFiles: files.length,
      hasMore: files.length > filesPerGroup
    }));

    // Sort groups by key
    groupsArray.sort((a, b) => {
      return order === 'desc'
        ? b.key.localeCompare(a.key)
        : a.key.localeCompare(b.key);
    });

    // Apply pagination
    const totalGroups = groupsArray.length;
    const hasMoreGroups = offset + limit < totalGroups;
    const hasPrevGroups = offset > 0;
    groupsArray = groupsArray.slice(offset, offset + limit);

    // Add file metadata (isText, isImage, sizeHuman)
    const indexJson = await readIndex();
    for (const group of groupsArray) {
      group.files = group.files.map(file => {
        const { isText, isImage } = classifyByExt(file.path);
        const meta = getMetaFromIndex(indexJson, file.path);
        return {
          ...file,
          sizeHuman: humanSize(file.sizeBytes),
          mtimeISO: new Date(file.mtimeMs).toISOString(),
          ctimeISO: file.ctimeMs ? new Date(file.ctimeMs).toISOString() : null,
          birthtimeISO: file.birthtimeMs ? new Date(file.birthtimeMs).toISOString() : null,
          isText,
          isImage,
          meta,
          type: 'file'
        };
      });
    }

    res.json({
      ok: true,
      sortBy,
      groupBy,
      order,
      offset,
      limit,
      totalGroups,
      totalFiles: allFiles.length,
      hasMoreGroups,
      hasPrevGroups,
      groups: groupsArray
    });
  } catch (e) {
    next(e);
  }
});

function formatGroupLabel(key, groupBy) {
  if (groupBy === 'month') {
    const [year, month] = key.split('-');
    const date = new Date(parseInt(year), parseInt(month) - 1, 1);
    return date.toLocaleDateString('en-US', { year: 'numeric', month: 'long' });
  } else {
    const [year, month, day] = key.split('-');
    const date = new Date(parseInt(year), parseInt(month) - 1, parseInt(day));
    return date.toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
  }
}

// Error handler
app.use((err, req, res, next) => {
  const status = err.status || 500;
  res.status(status).json({ error: err.message || "Server error" });
});

const PORT = process.env.PORT || 5177;
app.listen(PORT, () => {
  console.log(`Storage Explorer running at http://localhost:${PORT}`);
  console.log(`Root: ${ROOT}`);
  console.log(`Dangerous actions enabled: ${ALLOW_DANGEROUS_ACTIONS}`);
});
