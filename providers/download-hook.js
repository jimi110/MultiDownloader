// MultiDownloader · gancho de descarga
// Motor principal: yt-dlp (binario local) + ffmpeg (paquete ffmpeg-static).
// Motor alternativo: Cobalt (si defines COBALT_API_URL). Orden configurable con DOWNLOAD_ENGINE=ytdlp|cobalt.
//
// Variables de entorno (todas opcionales):
//   YTDLP_PATH         ruta al binario de yt-dlp (por defecto ./bin/yt-dlp o el del PATH)
//   YTDLP_COOKIES_B64  cookies en formato Netscape codificadas en base64 (ayuda con YouTube/Instagram)
//   (alternativa) Secret File de Render llamado cookies.txt -> se detecta solo en /etc/secrets/cookies.txt
//   YTDLP_PROXY        proxy para yt-dlp, p. ej. http://usuario:clave@host:puerto
//   COBALT_API_URL     URL de tu instancia de Cobalt, p. ej. https://cobalt.midominio.com/
//   COBALT_API_KEY     clave de la API de Cobalt (si tu instancia la exige)
//   DOWNLOAD_ENGINE    "ytdlp" (por defecto) o "cobalt"
//   MAX_FILESIZE       tamaño máximo por descarga para yt-dlp (por defecto 500M)
const { spawn } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { Readable } = require("stream");
const { pipeline } = require("stream/promises");

class HookError extends Error {
  constructor(code, message, status = 502) { super(message); this.code = code; this.status = status; }
}

// ---------- utilidades ----------
const isWin = process.platform === "win32";
const localBin = path.join(__dirname, "..", "bin", isWin ? "yt-dlp.exe" : "yt-dlp");
const YTDLP = process.env.YTDLP_PATH || (fs.existsSync(localBin) ? localBin : "yt-dlp");

let FFMPEG = "ffmpeg";
try { FFMPEG = require("ffmpeg-static") || "ffmpeg"; } catch { /* usa ffmpeg del sistema */ }

const COBALT_URL = process.env.COBALT_API_URL || "";
const ENGINE_PREF = (process.env.DOWNLOAD_ENGINE || "ytdlp").toLowerCase();
const MAX_FILESIZE = process.env.MAX_FILESIZE || "500M";

// Cookies (opcional): por variable en base64, o por archivo secreto de Render (/etc/secrets/cookies.txt)
let cookiesFile = null;
try {
  const target = path.join(os.tmpdir(), "md-cookies.txt");   // copia escribible (yt-dlp actualiza las cookies)
  const secret = process.env.YTDLP_COOKIES_FILE || "/etc/secrets/cookies.txt";
  if (process.env.YTDLP_COOKIES_B64) {
    fs.writeFileSync(target, Buffer.from(process.env.YTDLP_COOKIES_B64, "base64"), { mode: 0o600 });
    cookiesFile = target;
  } else if (fs.existsSync(secret)) {
    fs.copyFileSync(secret, target); fs.chmodSync(target, 0o600);
    cookiesFile = target;
  }
} catch (e) { console.error("No se pudieron preparar las cookies:", e.message); cookiesFile = null; }

const baseArgs = () => {
  const a = ["--no-playlist", "--no-warnings", "--no-color", "--socket-timeout", "20", "--ffmpeg-location", FFMPEG];
  if (cookiesFile) a.push("--cookies", cookiesFile);
  if (process.env.YTDLP_PROXY) a.push("--proxy", process.env.YTDLP_PROXY);
  return a;
};

// Limita descargas simultáneas para no ahogar el servidor (plan gratuito = poca RAM/CPU)
const MAX_JOBS = 2;
let running = 0;
const acquire = () => {
  if (running >= MAX_JOBS) throw new HookError("BUSY", "El servidor está ocupado. Inténtalo de nuevo en unos segundos.", 503);
  running++;
  let done = false;
  return () => { if (!done) { done = true; running--; } };
};

function run(cmd, args, { timeout = 60000 } = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    let out = "", err = "";
    const t = setTimeout(() => { p.kill("SIGKILL"); reject(new HookError("TIMEOUT", "La operación tardó demasiado.", 504)); }, timeout);
    p.stdout.on("data", d => { out += d; if (out.length > 20e6) p.kill("SIGKILL"); });
    p.stderr.on("data", d => { err += d; if (err.length > 1e6) err = err.slice(-5e5); });
    p.on("error", e => { clearTimeout(t); reject(e.code === "ENOENT" ? new HookError("NO_YTDLP", "yt-dlp no está instalado en el servidor.", 501) : e); });
    p.on("close", code => { clearTimeout(t); code === 0 ? resolve(out) : reject(Object.assign(new Error(err.trim().split("\n").pop() || "Error de yt-dlp"), { stderr: err })); });
  });
}

const friendly = (e) => {
  if (e instanceof HookError) return e;
  const s = String(e.stderr || e.message || "");
  if (/sign in to confirm|not a bot|cookies/i.test(s)) return new HookError("BLOCKED", "La plataforma pidió verificación (bloquea IPs de servidores). Configura YTDLP_COOKIES_B64 o un proxy/Cobalt.", 502);
  if (/private|login required|requires login|members-only/i.test(s)) return new HookError("PRIVATE", "El contenido es privado o requiere iniciar sesión.", 403);
  if (/unavailable|not found|404|removed|deleted/i.test(s)) return new HookError("NOT_FOUND", "El contenido no está disponible o fue eliminado.", 404);
  if (/unsupported url/i.test(s)) return new HookError("UNSUPPORTED", "Ese enlace no es compatible.", 400);
  if (/larger than max-filesize|file is larger/i.test(s)) return new HookError("TOO_BIG", "El archivo supera el tamaño máximo permitido.", 413);
  return new HookError("DOWNLOAD", "No se pudo procesar el contenido. Inténtalo más tarde.", 502);
};

// ---------- información (yt-dlp -J) con caché ----------
const cache = new Map();
const TTL = 5 * 60 * 1000;

async function getInfo(url) {
  const hit = cache.get(url);
  if (hit && Date.now() - hit.t < TTL) return hit.v;
  const out = await run(YTDLP, [...baseArgs(), "-J", "--skip-download", "--", url], { timeout: 45000 });
  const v = JSON.parse(out);
  cache.set(url, { t: Date.now(), v });
  if (cache.size > 200) cache.delete(cache.keys().next().value);
  return v;
}

const fmtDuration = (s) => {
  if (!s) return null;
  s = Math.round(s);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  return (h ? `${h}:${String(m).padStart(2, "0")}` : `${m}`) + `:${String(sec).padStart(2, "0")}`;
};

const LABELS = { 2160: "4K (2160p)", 1440: "2K (1440p)", 1080: "Full HD (1080p)", 720: "HD (720p)", 480: "SD (480p)", 360: "360p" };

function formatsFromInfo(info) {
  const list = info.formats || [];
  const vids = list.filter(f => f.vcodec && f.vcodec !== "none");
  const hasAudio = list.some(f => f.acodec && f.acodec !== "none") || Boolean(info.acodec && info.acodec !== "none");
  const out = [];
  if (vids.length) {
    const max = Math.max(0, ...vids.map(f => f.height || 0));
    if (max === 0) out.push({ type: "video", quality: "best", label: "Mejor calidad" });
    else Object.keys(LABELS).map(Number).sort((a, b) => a - b).forEach(h => {
      if (h !== 2160 && h <= max + 8 && vids.some(f => (f.height || 0) >= h - 8)) out.push({ type: "video", quality: String(h), label: LABELS[h] });
    });
    // 4K siempre visible: si el original no llega a 2160p, se descarga la máxima calidad disponible
    out.push({ type: "video", quality: "2160", label: max >= 2160 - 8 ? LABELS[2160] : "4K (máx. disponible)" });
  }
  if (hasAudio || vids.length) out.push({ type: "audio", quality: "best", label: "MP3" });
  return out;
}

// ---------- Cobalt ----------
async function cobaltRequest(url, { type, quality }) {
  const headers = { accept: "application/json", "content-type": "application/json", "user-agent": "MultiDownloader/1.0" };
  if (process.env.COBALT_API_KEY) headers.authorization = `Api-Key ${process.env.COBALT_API_KEY}`;
  const body = { url, downloadMode: type === "audio" ? "audio" : "auto", audioFormat: "mp3", audioBitrate: "320", filenameStyle: "pretty" };
  if (type === "video") body.videoQuality = /^\d+$/.test(quality) ? quality : "max";
  const r = await fetch(COBALT_URL, { method: "POST", headers, body: JSON.stringify(body), signal: AbortSignal.timeout(30000) });
  const j = await r.json().catch(() => ({}));
  if (j.status === "error") throw new HookError("COBALT", `Cobalt: ${j.error?.code || "error"}`, 502);
  if (!["tunnel", "redirect"].includes(j.status) || !j.url) throw new HookError("COBALT", "Cobalt no devolvió un archivo descargable.", 502);
  return j; // { status, url, filename }
}

async function downloadWithCobalt(url, opts, res) {
  const j = await cobaltRequest(url, opts);
  const r = await fetch(j.url, { headers: { "user-agent": "MultiDownloader/1.0" }, signal: AbortSignal.timeout(300000) });
  if (!r.ok || !r.body) throw new HookError("COBALT", "No se pudo obtener el archivo de Cobalt.", 502);
  const name = j.filename || (opts.type === "audio" ? "audio.mp3" : "video.mp4");
  sendHeaders(res, name, r.headers.get("content-type"), r.headers.get("content-length"));
  await pipeline(Readable.fromWeb(r.body), res);
}

// ---------- descarga con yt-dlp ----------
const MIME = { mp4: "video/mp4", webm: "video/webm", mkv: "video/x-matroska", mp3: "audio/mpeg", m4a: "audio/mp4", opus: "audio/ogg", ogg: "audio/ogg" };

function sendHeaders(res, filename, mime, length) {
  const safe = String(filename).replace(/[\r\n"\\/]/g, "_");
  const ascii = safe.replace(/[^\x20-\x7e]/g, "_");
  res.setHeader("Content-Type", mime || MIME[path.extname(safe).slice(1)] || "application/octet-stream");
  res.setHeader("Content-Disposition", `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(safe)}`);
  if (length) res.setHeader("Content-Length", length);
  res.setHeader("Cache-Control", "no-store");
}

async function downloadWithYtdlp(url, { type, quality }, res) {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "md-"));
  const cleanup = () => fs.promises.rm(dir, { recursive: true, force: true }).catch(() => {});
  try {
    const args = [...baseArgs(), "--max-filesize", MAX_FILESIZE, "--windows-filenames", "-o", path.join(dir, "%(title).80B [%(id)s].%(ext)s")];
    if (type === "audio") {
      args.push("-f", "bestaudio/best", "-x", "--audio-format", "mp3", "--audio-quality", "0");
    } else {
      const h = /^\d+$/.test(quality) ? Number(quality) : null;
      const cap = h ? `[height<=${h}]` : "";
      // Preferimos un archivo ya con audio; si no, fusionamos vídeo + audio en MP4 (siempre con sonido)
      args.push("-f", `b${cap}[acodec!=none]/bv*${cap}+ba/b${cap}`, "--merge-output-format", "mp4");
    }
    args.push("--", url);
    await run(YTDLP, args, { timeout: 5 * 60 * 1000 });

    const files = (await fs.promises.readdir(dir)).filter(f => !f.endsWith(".part") && !f.endsWith(".ytdl"));
    if (!files.length) throw new HookError("DOWNLOAD", "No se generó ningún archivo.", 502);
    const file = files[0], full = path.join(dir, file);
    const stat = await fs.promises.stat(full);
    sendHeaders(res, file, null, stat.size);
    res.on("close", cleanup);
    await pipeline(fs.createReadStream(full), res);
  } catch (e) { await cleanup(); throw e; }
}

// ---------- Suno: MP3 directo (sin yt-dlp) ----------
// Las páginas públicas de Suno publican la URL del audio (og:audio, en cdn*.suno.ai). La usamos tal cual.
const sunoCache = new Map();
const SUNO_UA = "Mozilla/5.0 (compatible; MultiDownloader/1.0)";
const okSunoHost = (u) => { try { const x = new URL(u); return x.protocol === "https:" && /(^|\.)suno\.(ai|com)$/.test(x.hostname); } catch { return false; } };
const decodeHtml = (t) => String(t || "").replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">");

function metaContent(html, prop) {
  for (const tag of html.match(/<meta\b[^>]*>/gi) || []) {
    const key = (tag.match(/(?:property|name)=["']([^"']+)["']/i) || [])[1];
    if (key && key.toLowerCase() === prop) return decodeHtml((tag.match(/content=["']([^"']*)["']/i) || [])[1]);
  }
  return null;
}

async function resolveSuno(url) {
  const hit = sunoCache.get(url);
  if (hit && Date.now() - hit.t < TTL) return hit.v;
  const r = await fetch(url, { headers: { "user-agent": SUNO_UA, "accept-language": "en" }, redirect: "follow", signal: AbortSignal.timeout(15000) });
  if (!r.ok) throw new HookError("NOT_FOUND", "La canción no está disponible.", 404);
  const html = await r.text();
  let audio = metaContent(html, "og:audio") || metaContent(html, "og:audio:url");
  if (!audio || !okSunoHost(audio)) {
    const id = ((r.url || "").match(/\/song\/([0-9a-f-]{36})/i) || html.match(/cdn\d*\.suno\.ai\/([0-9a-f-]{36})\.(?:mp3|m4a)/i) || url.match(/\/song\/([0-9a-f-]{36})/i) || [])[1];
    audio = id ? `https://cdn1.suno.ai/${id}.mp3` : null;
  }
  if (!audio) throw new HookError("NOT_FOUND", "No se encontró el audio público de esta canción.", 404);
  const v = { audio, title: (metaContent(html, "og:title") || "suno").trim() };
  sunoCache.set(url, { t: Date.now(), v });
  if (sunoCache.size > 200) sunoCache.delete(sunoCache.keys().next().value);
  return v;
}

async function downloadSuno(url, res) {
  const { audio, title } = await resolveSuno(url);
  const r = await fetch(audio, { headers: { "user-agent": SUNO_UA }, signal: AbortSignal.timeout(120000) });
  if (!r.ok || !r.body) throw new HookError("NOT_FOUND", "No se pudo obtener el MP3 de Suno.", 502);
  const name = `${title.replace(/[\\/:*?"<>|]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 80) || "suno"}.mp3`;
  sendHeaders(res, name, r.headers.get("content-type") || "audio/mpeg", r.headers.get("content-encoding") ? null : r.headers.get("content-length"));
  await pipeline(Readable.fromWeb(r.body), res);
}

// ---------- API pública del gancho ----------
const useCobaltFirst = () => ENGINE_PREF === "cobalt" && COBALT_URL;

module.exports = {
  // Estado de los motores (lo usa /api/health y el log de arranque)
  async status() {
    const st = { ytdlp: null, ffmpeg: FFMPEG === "ffmpeg" ? "sistema" : fs.existsSync(FFMPEG) ? "ffmpeg-static" : "no encontrado", cobalt: Boolean(COBALT_URL), cookies: Boolean(cookiesFile) };
    try { st.ytdlp = (await run(YTDLP, ["--version"], { timeout: 15000 })).trim(); } catch (e) { st.ytdlp = `no disponible (${e.code || e.message})`; }
    return st;
  },
  // Metadatos para plataformas que no tienen oEmbed (p. ej. Instagram sin token de Meta)
  async info(platform, url) {
    try {
      const i = await getInfo(url);
      return { title: i.title || "Sin título", thumbnail: i.thumbnail || null, author: i.uploader || i.channel || i.creator || null, duration: fmtDuration(i.duration) };
    } catch (e) { throw friendly(e); }
  },

  async formats(platform, url) {
    if (platform === "suno") {
      try { await resolveSuno(url); return [{ type: "audio", quality: "best", label: "MP3" }]; }
      catch (e) { console.error("[suno] directo falló, pruebo yt-dlp:", e.message); }
    }
    if (!useCobaltFirst()) {
      try { return formatsFromInfo(await getInfo(url)); }
      catch (e) { if (!COBALT_URL) throw friendly(e); }
    }
    // Cobalt no lista formatos: ofrecemos los habituales
    return [
      { type: "video", quality: "720", label: LABELS[720] },
      { type: "video", quality: "1080", label: LABELS[1080] },
      { type: "video", quality: "2160", label: LABELS[2160] },
      { type: "audio", quality: "best", label: "MP3" }
    ];
  },

  async download(platform, url, opts, res) {
    const release = acquire();
    try {
      if (platform === "suno" && opts.type === "audio") {
        try { await downloadSuno(url, res); return; }
        catch (e) { if (res.headersSent) throw e; console.error("[suno] directo falló, pruebo yt-dlp:", e.message); }
      }
      const engines = useCobaltFirst() ? ["cobalt", "ytdlp"] : COBALT_URL ? ["ytdlp", "cobalt"] : ["ytdlp"];
      let last;
      for (const eng of engines) {
        try {
          if (eng === "cobalt") await downloadWithCobalt(url, opts, res);
          else await downloadWithYtdlp(url, opts, res);
          return;
        } catch (e) {
          last = e;
          if (res.headersSent) throw e; // ya empezó a enviarse: no se puede reintentar
          console.error(`[${eng}] ${platform}:`, e.message);
        }
      }
      throw friendly(last);
    } finally { release(); }
  }
};
