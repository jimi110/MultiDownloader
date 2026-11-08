# MultiDownloader

## Arrancar
```
npm install
npm start        # http://localhost:3000
```
Requiere Node 18 o superior. Instagram necesita `META_OEMBED_TOKEN="APP_ID|CLIENT_TOKEN"` (API oEmbed de Meta).

## Qué hace hoy
- Valida el enlace (https y dominio de la plataforma).
- Lee metadatos públicos: YouTube y TikTok por oEmbed, Instagram por la API de Meta, Suno por Open Graph.
- Muestra errores claros: enlace no válido, privado, no disponible, plataforma sin acceso.
- No ofrece descargas hasta que conectes un proveedor: no hay botones que finjan hacer algo.

## Conectar una API de descarga
Crea `providers/download-hook.js` (el servidor lo detecta solo al arrancar):

```js
module.exports = {
  // Opcional: formatos reales de ese contenido. El frontend solo muestra lo que devuelvas aquí.
  async formats(platform, url) {
    return [
      { type: "video", quality: "720",  label: "HD (720p)" },
      { type: "video", quality: "1080", label: "Full HD (1080p)" },
      { type: "audio", quality: "best", label: "MP3" }
    ];
  },
  // Escribe el archivo en `res` (cabeceras Content-Disposition y Content-Type incluidas).
  // Los vídeos deben salir con su audio integrado.
  async download(platform, url, { type, quality }, res) { /* tu integración */ }
};
```

## Añadir una plataforma
Añade una entrada a `providers` en `server.js` (id, nombre, hosts, `analyze`) y otra a `PLATFORMS` en `public/index.html`.
