// Descarga el binario autónomo de yt-dlp a ./bin (se ejecuta en `npm install`).
// Si falla, no rompe la instalación: el servidor seguirá funcionando sin descargas.
const fs = require("fs");
const path = require("path");

const assets = {
  "linux-x64": "yt-dlp_linux",
  "linux-arm64": "yt-dlp_linux_aarch64",
  "darwin-x64": "yt-dlp_macos",
  "darwin-arm64": "yt-dlp_macos",
  "win32-x64": "yt-dlp.exe"
};
const asset = assets[`${process.platform}-${process.arch}`];
const dest = path.join(__dirname, "bin", process.platform === "win32" ? "yt-dlp.exe" : "yt-dlp");

(async () => {
  if (process.env.YTDLP_PATH) return console.log("[yt-dlp] YTDLP_PATH definido, se omite la descarga.");
  if (!asset) return console.warn(`[yt-dlp] Plataforma ${process.platform}-${process.arch} sin binario oficial; instala yt-dlp manualmente.`);
  try {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    const r = await fetch(`https://github.com/yt-dlp/yt-dlp/releases/latest/download/${asset}`, { redirect: "follow", signal: AbortSignal.timeout(120000) });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    fs.writeFileSync(dest, Buffer.from(await r.arrayBuffer()), { mode: 0o755 });
    fs.chmodSync(dest, 0o755);
    console.log("[yt-dlp] Instalado en", dest);
  } catch (e) {
    console.warn("[yt-dlp] No se pudo descargar:", e.message);
  }
})();
