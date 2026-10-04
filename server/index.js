import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import multer from "multer";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const uploadDir = path.join(root, "data", "uploads");
const dbFile = path.join(root, "data", "sounds.json");
const distDir = path.join(root, "dist");

const EXTENSIONS = new Set([".mp3", ".ogg", ".wav", ".m4a"]);
const MAX_BYTES = 5 * 1024 * 1024;
const MAX_SOUNDS = 500;
const PORT = process.env.PORT || 3001;

fs.mkdirSync(uploadDir, { recursive: true });

const readDb = () => {
  try {
    return JSON.parse(fs.readFileSync(dbFile, "utf8")).map((s) => ({ views: 0, ...s }));
  } catch {
    return [];
  }
};
const sounds = readDb();

const statsFile = path.join(root, "data", "stats.json");
const stats = (() => {
  try {
    return { visits: 0, ...JSON.parse(fs.readFileSync(statsFile, "utf8")) };
  } catch {
    return { visits: 0 };
  }
})();

let saveTimer;
const flush = () => {
  fs.writeFileSync(dbFile, JSON.stringify(sounds, null, 2));
  fs.writeFileSync(statsFile, JSON.stringify(stats));
};
const save = () => {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(flush, 1000);
};
for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => {
    flush();
    process.exit(0);
  });
}

// One counted view per client per sound per minute, so a held-down button can't inflate counts.
const VIEW_COOLDOWN_MS = 60_000;
const VISIT_COOLDOWN_MS = 30 * 60_000;
const lastView = new Map();
setInterval(() => {
  const cutoff = Date.now() - VISIT_COOLDOWN_MS;
  for (const [k, t] of lastView) if (t < cutoff) lastView.delete(k);
}, VIEW_COOLDOWN_MS).unref();

const upload = multer({
  storage: multer.diskStorage({
    destination: uploadDir,
    filename: (_req, file, cb) =>
      cb(null, crypto.randomUUID() + path.extname(file.originalname).toLowerCase()),
  }),
  limits: { fileSize: MAX_BYTES, files: 10 },
  fileFilter: (_req, file, cb) => {
    const ok = EXTENSIONS.has(path.extname(file.originalname).toLowerCase()) && file.mimetype.startsWith("audio/");
    cb(ok ? null : new Error("Only mp3, ogg, wav or m4a audio files are allowed"), ok);
  },
});

const app = express();

app.get("/api/sounds", (_req, res) => res.json(sounds));

// Counts one site visit per client every 30 minutes.
app.post("/api/visit", (req, res) => {
  const key = `visit:${req.ip}`;
  const now = Date.now();
  if (now - (lastView.get(key) ?? 0) >= VISIT_COOLDOWN_MS) {
    lastView.set(key, now);
    stats.visits++;
    save();
  }
  res.json({ visits: stats.visits });
});

app.post("/api/sounds/:id/view", (req, res) => {
  const sound = sounds.find((s) => s.id === req.params.id);
  if (!sound) return res.status(404).json({ error: "Not found" });

  const key = `${req.ip}:${sound.id}`;
  const now = Date.now();
  if (now - (lastView.get(key) ?? 0) >= VIEW_COOLDOWN_MS) {
    lastView.set(key, now);
    sound.views++;
    save();
  }
  res.json({ views: sound.views });
});

app.post("/api/sounds", (req, res) => {
  upload.single("file")(req, res, (err) => {
    if (err) return res.status(400).json({ error: err.message });
    if (!req.file) return res.status(400).json({ error: "Choose a sound file" });

    const reject = (status, error) => {
      fs.rmSync(req.file.path, { force: true });
      return res.status(status).json({ error });
    };

    const name = String(req.body.name ?? "").trim().slice(0, 60);
    if (!name) return reject(400, "Give the sound a name");
    if (sounds.length >= MAX_SOUNDS) return reject(507, "Sound limit reached");

    const added = { id: path.parse(req.file.filename).name, name, file: req.file.filename, views: 0 };
    sounds.push(added);
    save();
    res.status(201).json(added);
  });
});

app.use("/uploads", express.static(uploadDir, { setHeaders: (res) => res.set("X-Content-Type-Options", "nosniff") }));

// Password comes from ADMIN_PASSWORD or an untracked admin-password.txt; never committed.
const sha = (s) => crypto.createHash("sha256").update(s).digest();
const adminPassword = (() => {
  if (process.env.ADMIN_PASSWORD) return process.env.ADMIN_PASSWORD;
  try {
    return fs.readFileSync(path.join(root, "admin-password.txt"), "utf8").trim();
  } catch {
    return "";
  }
})();
if (!adminPassword) console.warn("No admin password set (ADMIN_PASSWORD or admin-password.txt); admin login is disabled.");
const ADMIN_HASH = sha(adminPassword);
const TOKEN_TTL_MS = 12 * 60 * 60_000;
const MAX_FAILS = 5;
const LOCKOUT_MS = 15 * 60_000;
const tokens = new Map();
const fails = new Map();

app.post("/api/admin/login", express.json({ limit: "1kb" }), (req, res) => {
  if (!adminPassword) return res.status(503).json({ error: "Admin login is not configured" });
  const now = Date.now();
  const rec = fails.get(req.ip);
  if (rec && rec.count >= MAX_FAILS && now - rec.last < LOCKOUT_MS) {
    return res.status(429).json({ error: "Too many attempts. Try again later." });
  }

  const given = sha(String(req.body?.password ?? ""));
  if (!crypto.timingSafeEqual(given, ADMIN_HASH)) {
    fails.set(req.ip, { count: (rec && now - rec.last < LOCKOUT_MS ? rec.count : 0) + 1, last: now });
    return res.status(401).json({ error: "Wrong password" });
  }

  fails.delete(req.ip);
  const token = crypto.randomBytes(32).toString("hex");
  tokens.set(token, now + TOKEN_TTL_MS);
  res.json({ token });
});

const requireAdmin = (req, res, next) => {
  const token = (req.get("authorization") ?? "").replace(/^Bearer /, "");
  const exp = tokens.get(token);
  if (!exp || exp < Date.now()) {
    tokens.delete(token);
    return res.status(401).json({ error: "Unauthorized" });
  }
  next();
};

app.get("/api/admin/stats", requireAdmin, (_req, res) => res.json({ visits: stats.visits, sounds }));

app.delete("/api/admin/sounds/:id", requireAdmin, (req, res) => {
  const i = sounds.findIndex((s) => s.id === req.params.id);
  if (i === -1) return res.status(404).json({ error: "Not found" });

  const [removed] = sounds.splice(i, 1);
  fs.rmSync(path.join(uploadDir, path.basename(removed.file)), { force: true });
  save();
  res.json({ ok: true });
});

if (fs.existsSync(distDir)) {
  app.use(express.static(distDir));
  app.get("/admin123", (_req, res) => res.sendFile(path.join(distDir, "index.html")));
}

app.listen(PORT, () => console.log(`GoozHub server on http://localhost:${PORT}`));
