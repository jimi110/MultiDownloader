// MultiDownloader · Música libre
// Busca pistas con licencia Creative Commons (CC0, dominio público y CC BY) en Openverse (que reúne Jamendo,
// Wikimedia Commons y otras fuentes) y las descarga a través del servidor.
// Opcional (gratis, en openverse.org): OPENVERSE_CLIENT_ID y OPENVERSE_CLIENT_SECRET suben mucho el límite de búsquedas.
const { Readable } = require("stream");
const { pipeline } = require("stream/promises");

const BASE = "https://api.openverse.org/v1";
const UA = "MultiDownloader/1.0 (musica libre)";
const LICENSES = { libre: "cc0,pdm", credito: "cc0,pdm,by" };   // nada de NC (no comercial) ni ND (sin derivadas): sirven para un videoclip
const CATEGORIES = new Set(["music", "sound_effect"]);
const PAGE_SIZE = 20;
const MAX_PAGES = 12;                    // Openverse solo da los primeros 240 resultados sin cuenta
const MAX_BYTES = 120 * 1024 * 1024;
const CACHE_TTL = 10 * 60 * 1000;

module.exports = function createRouter({ express, AppError, assertPublicHost }) {
  const router = express.Router();

  // ---------- límite sencillo por IP ----------
  const hits = new Map();
  function limit(req, kind, max) {
    const key = kind + ":" + (req.ip || "x"), now = Date.now();
    let h = hits.get(key);
    if (!h || now > h.reset) h = { n: 0, reset: now + 60000 };
    h.n++; hits.set(key, h);
    if (hits.size > 5000) hits.clear();
    if (h.n > max) throw new AppError("RATE", "Demasiadas peticiones seguidas. Espera un minuto.", 429);
  }

  // ---------- Openverse ----------
  let token = null, tokenExp = 0, tokenBadUntil = 0;
  async function getToken() {
    const id = process.env.OPENVERSE_CLIENT_ID, secret = process.env.OPENVERSE_CLIENT_SECRET;
    if (!id || !secret || Date.now() < tokenBadUntil) return null;
    if (token && Date.now() < tokenExp - 60000) return token;
    const r = await fetch(`${BASE}/auth_tokens/token/`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", "user-agent": UA },
      body: new URLSearchParams({ grant_type: "client_credentials", client_id: id, client_secret: secret }),
      signal: AbortSignal.timeout(15000)
    });
    if (!r.ok) { tokenBadUntil = Date.now() + 10 * 60 * 1000; return null; }
    const j = await r.json();
    token = j.access_token; tokenExp = Date.now() + (j.expires_in || 36000) * 1000;
    return token;
  }

  async function ov(pathname, params = {}, retried = false) {
    const url = new URL(BASE + pathname);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));
    const headers = { accept: "application/json", "user-agent": UA };
    const t = await getToken().catch(() => null);
    if (t) headers.authorization = `Bearer ${t}`;
    const r = await fetch(url, { headers, signal: AbortSignal.timeout(20000) });
    if ((r.status === 401 || r.status === 403) && t && !retried) { token = null; tokenBadUntil = Date.now() + 10 * 60 * 1000; return ov(pathname, params, true); }
    if (r.status === 429) throw new AppError("RATE", "Se alcanzó el límite de búsquedas gratuitas. Inténtalo de nuevo en un rato.", 429);
    if (r.status === 404) throw new AppError("NOT_FOUND", "Esa pista ya no está disponible.", 404);
    if (!r.ok) throw new AppError("PLATFORM", "El buscador de música libre no respondió bien. Inténtalo más tarde.", 502);
    return r.json();
  }

  const licenseLabel = (l, v) => l === "cc0" ? "CC0" : l === "pdm" ? "Dominio público" : `CC ${String(l || "").toUpperCase()}${v ? " " + v : ""}`;
  const mapTrack = (a) => ({
    id: a.id,
    title: a.title || "Sin título",
    creator: a.creator || null,
    license: licenseLabel(a.license, a.license_version),
    needsCredit: a.license === "by",
    licenseUrl: a.license_url || null,
    attribution: a.attribution || null,
    landing: a.foreign_landing_url || null,
    thumbnail: a.thumbnail || null,
    duration: a.duration || null,
    source: a.source || a.provider || null,
    preview: typeof a.url === "string" && a.url.startsWith("https://") ? a.url : null
  });

  // ---------- búsqueda ----------
  const cache = new Map();
  router.get("/search", async (req, res, next) => {
    try {
      limit(req, "s", 20);
      const q = String(req.query.q || "").trim().slice(0, 80);
      if (q.length < 2) throw new AppError("BAD_QUERY", "Escribe al menos 2 letras para buscar.", 400);
      const page = Math.min(MAX_PAGES, Math.max(1, parseInt(req.query.page, 10) || 1));
      const lic = LICENSES[req.query.lic] ? String(req.query.lic) : "credito";
      const category = CATEGORIES.has(req.query.category) ? String(req.query.category) : "music";
      const key = [q.toLowerCase(), page, lic, category].join("|");
      const hit = cache.get(key);
      if (hit && Date.now() - hit.t < CACHE_TTL) return res.json(hit.v);

      const d = await ov("/audio/", { q, page, page_size: PAGE_SIZE, license: LICENSES[lic], category });
      const v = {
        page,
        pageCount: Math.min(MAX_PAGES, d.page_count || 1),
        total: d.result_count || 0,
        results: (d.results || []).filter(a => a && a.id).map(mapTrack)
      };
      cache.set(key, { t: Date.now(), v });
      if (cache.size > 300) cache.delete(cache.keys().next().value);
      res.json(v);
    } catch (e) { next(e); }
  });

  // ---------- descarga (el servidor hace de intermediario y pone el nombre del archivo) ----------
  async function fetchPublic(u, hops = 0) {
    const x = new URL(u);
    if (x.protocol !== "https:" && x.protocol !== "http:") throw new AppError("BAD_FILE", "Archivo no válido.", 502);
    await assertPublicHost(x.hostname.toLowerCase());
    const r = await fetch(x, { redirect: "manual", headers: { "user-agent": UA }, signal: AbortSignal.timeout(120000) });
    if ([301, 302, 303, 307, 308].includes(r.status)) {
      const loc = r.headers.get("location");
      if (!loc || hops >= 3) throw new AppError("BAD_FILE", "La fuente redirige demasiadas veces.", 502);
      return fetchPublic(new URL(loc, x).toString(), hops + 1);
    }
    return r;
  }

  const sendHeaders = (res, filename, mime, length) => {
    const safe = String(filename).replace(/[\r\n"\\/:*?<>|]+/g, " ").replace(/\s+/g, " ").trim();
    const ascii = safe.replace(/[^\x20-\x7e]/g, "_");
    res.setHeader("Content-Type", mime || "audio/mpeg");
    res.setHeader("Content-Disposition", `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(safe)}`);
    if (length) res.setHeader("Content-Length", length);
    res.setHeader("Cache-Control", "no-store");
  };

  router.get("/download", async (req, res, next) => {
    try {
      limit(req, "d", 30);
      const id = String(req.query.id || "");
      if (!/^[0-9a-f-]{36}$/i.test(id)) throw new AppError("BAD_ID", "Identificador no válido.", 400);
      const a = await ov(`/audio/${id}/`);
      if (!a.url) throw new AppError("NOT_FOUND", "Esa pista no tiene archivo disponible.", 404);

      const r = await fetchPublic(a.url);
      if (!r.ok || !r.body) throw new AppError("NOT_FOUND", "La fuente ya no tiene ese archivo.", 502);
      const type = (r.headers.get("content-type") || "").toLowerCase();
      if (!/^(audio\/|application\/(ogg|octet-stream)|video\/ogg|binary\/octet-stream)/.test(type))
        throw new AppError("BAD_FILE", "La fuente no devolvió un archivo de audio.", 502);
      const len = Number(r.headers.get("content-length")) || 0;
      if (len > MAX_BYTES) throw new AppError("TOO_BIG", "El archivo es demasiado grande.", 413);

      let ext = String(a.filetype || "").toLowerCase().replace(/[^a-z0-9]/g, "");
      if (!ext) { try { ext = (new URL(a.url).pathname.match(/\.([a-z0-9]{2,4})$/i) || [])[1] || ""; } catch {} }
      ext = (ext || "mp3").slice(0, 4);
      const name = `${(a.title || "pista").slice(0, 80)}${a.creator ? " - " + String(a.creator).slice(0, 40) : ""}.${ext}`;

      sendHeaders(res, name, type.split(";")[0] || "audio/mpeg", r.headers.get("content-encoding") ? null : len || null);
      const src = Readable.fromWeb(r.body);
      let n = 0;
      src.on("data", c => { n += c.length; if (n > MAX_BYTES) src.destroy(new Error("Archivo demasiado grande")); });
      await pipeline(src, res);
    } catch (e) { next(e); }
  });

  return router;
};
