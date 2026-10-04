const EXT_TYPES = { ".mp3": "audio/mpeg", ".ogg": "audio/ogg", ".wav": "audio/wav", ".m4a": "audio/mp4" };
const MAX_BYTES = 5 * 1024 * 1024;
const MAX_SOUNDS = 500;
const VIEW_COOLDOWN_MS = 60_000;
const VISIT_COOLDOWN_MS = 30 * 60_000;
const TOKEN_TTL_MS = 12 * 60 * 60_000;
const MAX_FAILS = 5;
const LOCKOUT_MS = 15 * 60_000;
const FILE_KEY = /^[0-9a-f-]{36}\.(mp3|ogg|wav|m4a)$/;

const enc = new TextEncoder();
const json = (data, status = 200) => Response.json(data, { status });
const clientIp = (req) => req.headers.get("cf-connecting-ip") ?? "unknown";

let schemaReady;
function ensureSchema(db) {
  schemaReady ??= db.batch([
    db.prepare("CREATE TABLE IF NOT EXISTS sounds (id TEXT PRIMARY KEY, name TEXT NOT NULL, file TEXT NOT NULL, views INTEGER NOT NULL DEFAULT 0, created INTEGER NOT NULL)"),
    db.prepare("CREATE TABLE IF NOT EXISTS stats (key TEXT PRIMARY KEY, value INTEGER NOT NULL)"),
    db.prepare("CREATE TABLE IF NOT EXISTS cooldowns (key TEXT PRIMARY KEY, ts INTEGER NOT NULL)"),
    db.prepare("CREATE TABLE IF NOT EXISTS login_fails (ip TEXT PRIMARY KEY, count INTEGER NOT NULL, last INTEGER NOT NULL)"),
  ]).catch((err) => {
    schemaReady = undefined;
    throw err;
  });
  return schemaReady;
}

// True if this key wasn't counted within the cooldown, and records it atomically.
async function claim(env, ctx, key, cooldownMs) {
  const now = Date.now();
  const res = await env.DB.prepare(
    "INSERT INTO cooldowns (key, ts) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET ts = ?2 WHERE ts <= ?3"
  ).bind(key, now, now - cooldownMs).run();
  if (Math.random() < 0.02) {
    ctx.waitUntil(env.DB.prepare("DELETE FROM cooldowns WHERE ts < ?").bind(now - VISIT_COOLDOWN_MS).run());
  }
  return res.meta.changes > 0;
}

const toHex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");

async function hmac(secret, message) {
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return toHex(await crypto.subtle.sign("HMAC", key, enc.encode(message)));
}

const safeEqual = (a, b) => a.length === b.length && crypto.subtle.timingSafeEqual(enc.encode(a), enc.encode(b));

async function passwordMatches(env, given) {
  const [a, b] = await Promise.all([
    crypto.subtle.digest("SHA-256", enc.encode(given)),
    crypto.subtle.digest("SHA-256", enc.encode(env.ADMIN_PASSWORD)),
  ]);
  return crypto.subtle.timingSafeEqual(a, b);
}

async function isAdmin(req, env) {
  if (!env.ADMIN_PASSWORD) return false;
  const token = (req.headers.get("authorization") ?? "").replace(/^Bearer /, "");
  const [exp, sig] = token.split(".");
  if (!exp || !sig || !(Number(exp) > Date.now())) return false;
  return safeEqual(sig, await hmac(env.ADMIN_PASSWORD, exp));
}

async function login(req, env) {
  if (!env.ADMIN_PASSWORD) return json({ error: "Admin login is not configured" }, 503);

  const ip = clientIp(req);
  const now = Date.now();
  const rec = await env.DB.prepare("SELECT count, last FROM login_fails WHERE ip = ?").bind(ip).first();
  const recent = rec && now - rec.last < LOCKOUT_MS;
  if (recent && rec.count >= MAX_FAILS) return json({ error: "Too many attempts. Try again later." }, 429);

  let password = "";
  try {
    password = String((await req.json())?.password ?? "");
  } catch {
    // treated as a wrong password
  }

  if (!(await passwordMatches(env, password))) {
    await env.DB.prepare(
      "INSERT INTO login_fails (ip, count, last) VALUES (?1, ?2, ?3) ON CONFLICT(ip) DO UPDATE SET count = ?2, last = ?3"
    ).bind(ip, (recent ? rec.count : 0) + 1, now).run();
    return json({ error: "Wrong password" }, 401);
  }

  await env.DB.prepare("DELETE FROM login_fails WHERE ip = ?").bind(ip).run();
  const exp = String(now + TOKEN_TTL_MS);
  return json({ token: `${exp}.${await hmac(env.ADMIN_PASSWORD, exp)}` });
}

async function listSounds(env) {
  const { results } = await env.DB.prepare("SELECT id, name, file, views FROM sounds ORDER BY created").all();
  return results;
}

async function uploadSound(req, env) {
  if (Number(req.headers.get("content-length") ?? 0) > MAX_BYTES + 64 * 1024) {
    return json({ error: "File is too large (5 MB max)" }, 413);
  }

  let form;
  try {
    form = await req.formData();
  } catch {
    return json({ error: "Invalid upload" }, 400);
  }

  const file = form.get("file");
  if (!(file instanceof File)) return json({ error: "Choose a sound file" }, 400);

  const name = String(form.get("name") ?? "").trim().slice(0, 60);
  if (!name) return json({ error: "Give the sound a name" }, 400);

  const ext = (file.name.match(/\.[^.]+$/)?.[0] ?? "").toLowerCase();
  if (!(ext in EXT_TYPES) || !file.type.startsWith("audio/")) {
    return json({ error: "Only mp3, ogg, wav or m4a audio files are allowed" }, 400);
  }
  if (file.size > MAX_BYTES) return json({ error: "File is too large (5 MB max)" }, 413);

  const { n } = await env.DB.prepare("SELECT COUNT(*) AS n FROM sounds").first();
  if (n >= MAX_SOUNDS) return json({ error: "Sound limit reached" }, 507);

  const id = crypto.randomUUID();
  const key = id + ext;
  await env.SOUNDS_BUCKET.put(key, file.stream(), { httpMetadata: { contentType: EXT_TYPES[ext] } });
  await env.DB.prepare("INSERT INTO sounds (id, name, file, views, created) VALUES (?, ?, ?, 0, ?)")
    .bind(id, name, key, Date.now()).run();

  return json({ id, name, file: key, views: 0 }, 201);
}

async function serveUpload(req, env, key) {
  if (!FILE_KEY.test(key)) return new Response("Not found", { status: 404 });

  const obj = await env.SOUNDS_BUCKET.get(key, { range: req.headers });
  if (!obj) return new Response("Not found", { status: 404 });

  const headers = new Headers();
  obj.writeHttpMetadata(headers);
  headers.set("etag", obj.httpEtag);
  headers.set("accept-ranges", "bytes");
  headers.set("x-content-type-options", "nosniff");
  headers.set("cache-control", "public, max-age=31536000, immutable");

  if (obj.range && req.headers.has("range")) {
    const offset = obj.range.offset ?? obj.size - obj.range.suffix;
    const length = obj.range.length ?? obj.size - offset;
    headers.set("content-range", `bytes ${offset}-${offset + length - 1}/${obj.size}`);
    return new Response(obj.body, { status: 206, headers });
  }
  return new Response(obj.body, { headers });
}

async function route(req, env, ctx) {
  const { pathname } = new URL(req.url);
  const { method } = req;

  if (pathname.startsWith("/uploads/") && method === "GET") {
    return serveUpload(req, env, decodeURIComponent(pathname.slice("/uploads/".length)));
  }

  await ensureSchema(env.DB);

  if (pathname === "/api/sounds" && method === "GET") return json(await listSounds(env));
  if (pathname === "/api/sounds" && method === "POST") return uploadSound(req, env);

  if (pathname === "/api/visit" && method === "POST") {
    if (await claim(env, ctx, `visit:${clientIp(req)}`, VISIT_COOLDOWN_MS)) {
      await env.DB.prepare(
        "INSERT INTO stats (key, value) VALUES ('visits', 1) ON CONFLICT(key) DO UPDATE SET value = value + 1"
      ).run();
    }
    const row = await env.DB.prepare("SELECT value FROM stats WHERE key = 'visits'").first();
    return json({ visits: row?.value ?? 0 });
  }

  const view = pathname.match(/^\/api\/sounds\/([0-9a-f-]{36})\/view$/);
  if (view && method === "POST") {
    const id = view[1];
    const exists = await env.DB.prepare("SELECT 1 FROM sounds WHERE id = ?").bind(id).first();
    if (!exists) return json({ error: "Not found" }, 404);
    if (await claim(env, ctx, `view:${clientIp(req)}:${id}`, VIEW_COOLDOWN_MS)) {
      await env.DB.prepare("UPDATE sounds SET views = views + 1 WHERE id = ?").bind(id).run();
    }
    const row = await env.DB.prepare("SELECT views FROM sounds WHERE id = ?").bind(id).first();
    return json({ views: row.views });
  }

  if (pathname === "/api/admin/login" && method === "POST") return login(req, env);

  if (pathname.startsWith("/api/admin/")) {
    if (!(await isAdmin(req, env))) return json({ error: "Unauthorized" }, 401);

    if (pathname === "/api/admin/stats" && method === "GET") {
      const row = await env.DB.prepare("SELECT value FROM stats WHERE key = 'visits'").first();
      return json({ visits: row?.value ?? 0, sounds: await listSounds(env) });
    }

    const del = pathname.match(/^\/api\/admin\/sounds\/([0-9a-f-]{36})$/);
    if (del && method === "DELETE") {
      const sound = await env.DB.prepare("SELECT file FROM sounds WHERE id = ?").bind(del[1]).first();
      if (!sound) return json({ error: "Not found" }, 404);
      await env.DB.prepare("DELETE FROM sounds WHERE id = ?").bind(del[1]).run();
      await env.SOUNDS_BUCKET.delete(sound.file);
      return json({ ok: true });
    }
  }

  if (pathname.startsWith("/api/")) return json({ error: "Not found" }, 404);
  return env.ASSETS.fetch(req);
}

export default {
  async fetch(req, env, ctx) {
    try {
      return await route(req, env, ctx);
    } catch (err) {
      console.error(err);
      return json({ error: "Server error" }, 500);
    }
  },
};
