// MultiDownloader · backend
// Cada plataforma es un "proveedor" con esta forma:
//   { id, name, hosts: [...], analyze(url) -> {title, thumbnail, author, duration?, formats[]}, download?(req, res, ctx) }
// Los proveedores incluidos solo leen metadatos públicos (oEmbed / Open Graph).
// La descarga real se conecta en providers/download-hook.js (yt-dlp / Cobalt).
const express = require("express");
const path = require("path");
const fs = require("fs");
const dns = require("dns").promises;
const net = require("net");

const app = express();
app.set("trust proxy", 1);   // detrás del proxy de Render, para ver la IP real de cada visitante
app.use(express.json({ limit: "10kb" }));
app.use(express.static(path.join(__dirname, "public"), {
  setHeaders(res, file) {
    if (file.endsWith(".webmanifest")) res.type("application/manifest+json");
    if (file.endsWith("sw.js")) res.setHeader("Cache-Control", "no-cache");   // que las actualizaciones del service worker lleguen siempre
  }
}));

// CORS: permite que la web esté en otro dominio (p. ej. GitHub Pages) y use este servidor como API.
// Para restringirlo, define ALLOWED_ORIGIN=https://tuusuario.github.io en Render.
app.use("/api", (req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", process.env.ALLOWED_ORIGIN || "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "content-type");
  res.setHeader("Access-Control-Expose-Headers", "Content-Disposition");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

class AppError extends Error {
  constructor(code, message, status = 400) { super(message); this.code = code; this.status = status; }
}

const hostMatches = (host, hosts) => hosts.some(h => host === h || host.endsWith("." + h));

async function getJson(url) {
  const r = await fetch(url, { headers: { "user-agent": "MultiDownloader/1.0" }, signal: AbortSignal.timeout(8000) });
  if (r.status === 401 || r.status === 403) throw new AppError("PRIVATE", "El contenido es privado o la plataforma no permite acceder a él.", 403);
  if (r.status === 404) throw new AppError("NOT_FOUND", "El contenido no está disponible o fue eliminado.", 404);
  if (!r.ok) throw new AppError("PLATFORM", "La plataforma no respondió correctamente.", 502);
  return r.json();
}

const oembed = (endpoint) => async (url) => {
  const d = await getJson(`${endpoint}?url=${encodeURIComponent(url)}&format=json`);
  return { title: d.title, thumbnail: d.thumbnail_url, author: d.author_name, duration: null, formats: [] };
};

const providers = {
  youtube: { name: "YouTube", hosts: ["youtube.com", "youtu.be"], analyze: oembed("https://www.youtube.com/oembed") },
  tiktok: { name: "TikTok", hosts: ["tiktok.com"], analyze: oembed("https://www.tiktok.com/oembed") },
  instagram: {
    name: "Instagram", hosts: ["instagram.com"],
    // La API oEmbed de Meta exige un token de app: META_OEMBED_TOKEN="APP_ID|CLIENT_TOKEN"
    async analyze(url) {
      const token = process.env.META_OEMBED_TOKEN;
      if (!token) throw new AppError("NOT_CONFIGURED", "Instagram requiere un token de la API de Meta (META_OEMBED_TOKEN).", 501);
      const d = await getJson(`https://graph.facebook.com/v19.0/instagram_oembed?url=${encodeURIComponent(url)}&access_token=${encodeURIComponent(token)}`);
      return { title: d.title || "Publicación de Instagram", thumbnail: d.thumbnail_url, author: d.author_name, duration: null, formats: [] };
    }
  },
  // Cualquier otra app: se resuelve con yt-dlp (admite cientos de webs). hosts: null = cualquier dominio público
  otros: {
    name: "Otros", hosts: null,
    async analyze() { throw new AppError("NOT_CONFIGURED", "Los enlaces de otras apps requieren el motor de descarga (yt-dlp).", 501); }
  },
  suno: {
    name: "Suno AI", hosts: ["suno.com", "suno.ai"],
    async analyze(url) {
      const r = await fetch(url, { headers: { "user-agent": "MultiDownloader/1.0" }, signal: AbortSignal.timeout(8000) });
      if (r.status === 404) throw new AppError("NOT_FOUND", "La canción no está disponible.", 404);
      if (!r.ok) throw new AppError("PLATFORM", "Suno no permitió acceder al contenido.", 502);
      const html = await r.text();
      const og = (p) => (html.match(new RegExp(`<meta[^>]+property=["']og:${p}["'][^>]+content=["']([^"']*)["']`, "i")) || [])[1];
      if (!og("title")) throw new AppError("NOT_FOUND", "No se encontró una canción pública en ese enlace.", 404);
      return { title: og("title"), thumbnail: og("image"), author: og("description") || null, duration: null, formats: [] };
    }
  }
};

// Gancho de descarga: si existe providers/download-hook.js, se usa.
// Debe exportar: async function (platform, url, { type, quality }, res)
// y escribir el archivo en `res`. Y debe describir qué formatos ofrece por plataforma con
// una función opcional `formats(platform, url)` que devuelva [{type:"video"|"audio", quality, label}].
const hookPath = path.join(__dirname, "providers", "download-hook.js");
let hook = null;
if (fs.existsSync(hookPath)) {
  try { hook = require(hookPath); }
  catch (e) { console.error("No se pudo cargar providers/download-hook.js:", e.message); }
}
// Que un error suelto no tumbe el servidor
process.on("unhandledRejection", (e) => console.error("unhandledRejection:", e));
process.on("uncaughtException", (e) => console.error("uncaughtException:", e));

const isPrivateIp = (ip) => {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split(".").map(Number);
    return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
  }
  const v = ip.toLowerCase();
  if (v.startsWith("::ffff:")) return isPrivateIp(v.slice(7));
  return v === "::" || v === "::1" || v.startsWith("fc") || v.startsWith("fd") || v.startsWith("fe80");
};

// Para dominios arbitrarios ("otros") evitamos que el servidor acceda a direcciones internas
async function assertPublicHost(hostname) {
  const bad = () => new AppError("INVALID_URL", "Ese enlace no es válido o no es público.", 400);
  if (net.isIP(hostname) || hostname === "localhost" || !hostname.includes(".") || /\.(local|internal|localdomain)$/.test(hostname)) throw bad();
  let addrs;
  try { addrs = await dns.lookup(hostname, { all: true }); } catch { throw new AppError("INVALID_URL", "No se pudo encontrar ese dominio.", 400); }
  if (!addrs.length || addrs.some(a => isPrivateIp(a.address))) throw bad();
}

async function resolve(req) {
  const id = req.params.platform;
  const p = providers[id];
  if (!p) throw new AppError("UNKNOWN_PLATFORM", "Plataforma no soportada.", 404);
  let u;
  try { u = new URL(String(req.body?.url ?? req.query.url ?? "").trim()); } catch { throw new AppError("INVALID_URL", "El enlace no es válido.", 400); }
  const host = u.hostname.toLowerCase();
  if (u.protocol !== "https:") throw new AppError("INVALID_URL", "El enlace debe empezar por https://", 400);
  if (p.hosts) {
    if (!hostMatches(host, p.hosts)) throw new AppError("INVALID_URL", `El enlace no pertenece a ${p.name}.`, 400);
  } else await assertPublicHost(host);
  return { id, p, url: u.toString() };
}

// Música libre (Openverse): /api/libre/search y /api/libre/download
try { app.use("/api/libre", require("./providers/free-music")({ express, AppError, assertPublicHost })); }
catch (e) { console.error("No se pudo cargar providers/free-music.js:", e.message); }

app.get("/api/platforms", (_q, res) =>
  res.json(Object.entries(providers).map(([id, p]) => ({ id, name: p.name, downloads: Boolean(hook) }))));

// Diagnóstico: abre /api/health en el navegador para ver el estado del servidor
app.get("/api/health", async (_q, res) => {
  const status = hook?.status ? await hook.status().catch(e => ({ error: e.message })) : null;
  res.json({ ok: true, node: process.version, downloads: Boolean(hook), engine: status });
});

app.post("/api/:platform/analyze", async (req, res, next) => {
  try {
    const { id, p, url } = await resolve(req);
    let meta;
    try { meta = await p.analyze(url); }
    catch (err) {
      // Si el proveedor no puede leer los metadatos (p. ej. Instagram sin token de Meta), probamos con yt-dlp
      if (!hook?.info) throw err;
      try { meta = { formats: [], ...(await hook.info(id, url)) }; } catch (e2) { throw err.code === "NOT_CONFIGURED" ? e2 : err; }
    }
    if (hook?.formats) {
      meta.formats = await hook.formats(id, url);
      if (!meta.duration && hook.info) meta.duration = (await hook.info(id, url).catch(() => ({}))).duration || null;
    }
    res.json({ ...meta, downloads: Boolean(hook) });
  } catch (e) { next(e); }
});

app.get("/api/:platform/download", async (req, res, next) => {
  try {
    const { id, url } = await resolve(req);
    if (!hook) throw new AppError("NOT_CONFIGURED", "La descarga no está configurada en este servidor.", 501);
    const type = req.query.type === "audio" ? "audio" : "video";
    const quality = String(req.query.quality || "");
    await hook.download(id, url, { type, quality }, res);
  } catch (e) { next(e); }
});

app.use("/api", (_q, res) => res.status(404).json({ code: "NOT_FOUND", error: "Ruta de la API no encontrada." }));

app.use((e, _q, res, _n) => {
  if (res.headersSent) return res.end();
  const known = e instanceof AppError || (e && e.code && Number.isInteger(e.status)); // incluye los errores del gancho de descarga
  if (!known) console.error(e);
  res.status(known ? e.status : 500).json({ code: known ? e.code : "SERVER", error: known ? e.message : "Error interno del servidor." });
});

const port = process.env.PORT || 3000;
app.listen(port, "0.0.0.0", () => {
  console.log(`MultiDownloader escuchando en el puerto ${port} (Node ${process.version})`);
  console.log(hook ? "Descargas: activadas (download-hook.js cargado)" : "Descargas: desactivadas (falta providers/download-hook.js)");
  if (hook?.status) hook.status().then(st => console.log("Motor:", JSON.stringify(st))).catch(e => console.log("Motor: error", e.message));
});
