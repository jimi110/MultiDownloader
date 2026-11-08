// MultiDownloader · backend
// Cada plataforma es un "proveedor" con esta forma:
//   { id, name, hosts: [...], analyze(url) -> {title, thumbnail, author, duration?, formats[]}, download?(req, res, ctx) }
// Los proveedores incluidos solo leen metadatos públicos (oEmbed / Open Graph).
// La descarga real queda en blanco a propósito: se conecta en providers/download-hook.js.
const express = require("express");
const path = require("path");
const fs = require("fs");

const app = express();
app.use(express.json({ limit: "10kb" }));
app.use(express.static(path.join(__dirname, "public")));

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
const hook = fs.existsSync(hookPath) ? require(hookPath) : null;

function resolve(req) {
  const id = req.params.platform;
  const p = providers[id];
  if (!p) throw new AppError("UNKNOWN_PLATFORM", "Plataforma no soportada.", 404);
  let u;
  try { u = new URL(String(req.body?.url ?? req.query.url ?? "").trim()); } catch { throw new AppError("INVALID_URL", "El enlace no es válido.", 400); }
  if (u.protocol !== "https:" || !hostMatches(u.hostname.toLowerCase(), p.hosts))
    throw new AppError("INVALID_URL", `El enlace no pertenece a ${p.name}.`, 400);
  return { id, p, url: u.toString() };
}

app.get("/api/platforms", (_q, res) =>
  res.json(Object.entries(providers).map(([id, p]) => ({ id, name: p.name, downloads: Boolean(hook) }))));

app.post("/api/:platform/analyze", async (req, res, next) => {
  try {
    const { id, p, url } = resolve(req);
    const meta = await p.analyze(url);
    if (hook?.formats) meta.formats = await hook.formats(id, url);
    res.json({ ...meta, downloads: Boolean(hook) });
  } catch (e) { next(e); }
});

app.get("/api/:platform/download", async (req, res, next) => {
  try {
    const { id, url } = resolve(req);
    if (!hook) throw new AppError("NOT_CONFIGURED", "La descarga no está configurada en este servidor.", 501);
    const type = req.query.type === "audio" ? "audio" : "video";
    const quality = String(req.query.quality || "");
    await hook.download(id, url, { type, quality }, res);
  } catch (e) { next(e); }
});

app.use((e, _q, res, _n) => {
  if (res.headersSent) return res.end();
  const known = e instanceof AppError;
  if (!known) console.error(e);
  res.status(known ? e.status : 500).json({ code: known ? e.code : "SERVER", error: known ? e.message : "Error interno del servidor." });
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`MultiDownloader en http://localhost:${port}`));
