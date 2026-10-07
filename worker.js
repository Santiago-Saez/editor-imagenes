/* worker.js — trabajo pesado fuera del hilo UI.
   Mensajes:
   {id, cmd:'decode', buffer, name, type, maxPreview} -> ImageBitmap original + preview downscaled
   {id, cmd:'export', bitmap, ops, format, quality, maxPixels} -> Blob + w,h,bytes
   Usa OffscreenCanvas + manipulación de píxeles (mismas fórmulas que el shader WebGL).
*/
"use strict";

var MP20 = 20 * 1000 * 1000;

function adjDefaults(ops) {
  var a = { brightness: 0, contrast: 1, saturation: 1, temperature: 0 };
  if (!ops) return a;
  ops.forEach(function (o) {
    if (o.enabled === false) return;
    if (o.type === "brightness") a.brightness = o.value / 100;
    if (o.type === "contrast") a.contrast = 1 + o.value / 100;
    if (o.type === "saturation") a.saturation = 1 + o.value / 100;
    if (o.type === "temperature") a.temperature = o.value / 100;
  });
  // clamp
  a.contrast = Math.min(2, Math.max(0, a.contrast));
  a.saturation = Math.min(2, Math.max(0, a.saturation));
  return a;
}

function geomOf(ops) {
  var g = { crop: null, angle: 0, flipH: false, flipV: false, resize: null };
  (ops || []).forEach(function (o) {
    if (o.enabled === false) return;
    if (o.type === "crop") g.crop = o.rect;
    if (o.type === "rotate") g.angle = o.value;
    if (o.type === "flip") { g.flipH = !!o.h; g.flipV = !!o.v; }
    if (o.type === "resize") g.resize = { w: o.w, h: o.h };
  });
  return g;
}

function applyGeometry(srcW, srcH, bitmap, g) {
  // 1) crop (rect normalizado 0..1 sobre el original)
  var sx = 0, sy = 0, sw = srcW, sh = srcH;
  if (g.crop) {
    sx = Math.round(g.crop.x * srcW); sy = Math.round(g.crop.y * srcH);
    sw = Math.round(g.crop.w * srcW); sh = Math.round(g.crop.h * srcH);
    sx = Math.max(0, Math.min(srcW - 1, sx)); sy = Math.max(0, Math.min(srcH - 1, sy));
    sw = Math.max(1, Math.min(srcW - sx, sw)); sh = Math.max(1, Math.min(srcH - sy, sh));
  }
  // 2) rotate (ángulo libre) + flip -> canvas intermedio
  var rad = (g.angle || 0) * Math.PI / 180;
  var cos = Math.abs(Math.cos(rad)), sin = Math.abs(Math.sin(rad));
  var bw = Math.round(sw * cos + sh * sin), bh = Math.round(sw * sin + sh * cos);
  var c1 = new OffscreenCanvas(bw, bh);
  var x1 = c1.getContext("2d");
  x1.imageSmoothingQuality = "high";
  x1.translate(bw / 2, bh / 2);
  x1.rotate(rad);
  x1.scale(g.flipH ? -1 : 1, g.flipV ? -1 : 1);
  x1.drawImage(bitmap, sx, sy, sw, sh, -sw / 2, -sh / 2, sw, sh);
  // 3) resize de salida
  if (g.resize && g.resize.w > 0 && g.resize.h > 0) {
    var c2 = new OffscreenCanvas(g.resize.w, g.resize.h);
    var x2 = c2.getContext("2d");
    x2.imageSmoothingQuality = "high";
    x2.drawImage(c1, 0, 0, c2.width, c2.height);
    return c2;
  }
  return c1;
}

function applyColor(canvas, adj, onProgress) {
  var ctx = canvas.getContext("2d");
  var w = canvas.width, h = canvas.height;
  var rowsPerChunk = Math.max(64, Math.floor(1024 * 1024 / Math.max(1, w))); // ~1MP por chunk
  var y = 0;
  return new Promise(function (resolve) {
    function step() {
      var y2 = Math.min(h, y + rowsPerChunk);
      var img = ctx.getImageData(0, y, w, y2 - y);
      var d = img.data;
      var b = adj.brightness, c = adj.contrast, s = adj.saturation, t = adj.temperature;
      for (var i = 0; i < d.length; i += 4) {
        var r = d[i] / 255, g = d[i + 1] / 255, bl = d[i + 2] / 255;
        r += b; g += b; bl += b;
        r = (r - 0.5) * c + 0.5; g = (g - 0.5) * c + 0.5; bl = (bl - 0.5) * c + 0.5;
        var l = 0.2126 * r + 0.7152 * g + 0.0722 * bl;
        r = l + (r - l) * s; g = l + (g - l) * s; bl = l + (bl - l) * s;
        r += t * 0.18; bl -= t * 0.18; g += t * 0.02;
        d[i] = Math.max(0, Math.min(255, r * 255));
        d[i + 1] = Math.max(0, Math.min(255, g * 255));
        d[i + 2] = Math.max(0, Math.min(255, bl * 255));
      }
      ctx.putImageData(img, 0, y);
      y = y2;
      if (onProgress) onProgress(y / h);
      if (y < h) setTimeout(step, 0);
      else resolve();
    }
    step();
  });
}

function downscale(bitmap, maxDim) {
  var w = bitmap.width, h = bitmap.height;
  var sc = Math.min(1, maxDim / Math.max(w, h));
  var tw = Math.max(1, Math.round(w * sc)), th = Math.max(1, Math.round(h * sc));
  var c = new OffscreenCanvas(tw, th);
  c.getContext("2d").drawImage(bitmap, 0, 0, tw, th);
  return c.transferToImageBitmap();
}

self.onmessage = async function (e) {
  var m = e.data || {};
  try {
    if (m.cmd === "decode") {
      var blob = new Blob([m.buffer], { type: m.type || "image/*" });
      var bmp = await createImageBitmap(blob);
      var mp = (bmp.width * bmp.height) / 1e6;
      // Preview siempre downscaled para no saturar memoria del hilo principal
      var isLarge = bmp.width * bmp.height > MP20;
      var prevMax = m.maxPreview || 1920;
      var preview = downscale(bmp, prevMax);
      // Transferimos preview; el original se transfiere solo si no es enorme
      // (si es enorme, lo conservamos aquí y avisamos: se pedirá por tiles en export).
      // Simplificación pragmática: transferir también el original (es transferible
      // y no bloquea UI porque el decode ya ocurrió aquí).
      self.postMessage({ id: m.id, ok: true, w: bmp.width, h: bmp.height, mp: mp, isLarge: isLarge, preview: preview, bitmap: bmp },
        [preview, bmp]);
    }
    else if (m.cmd === "export") {
      var ops = m.ops || [];
      var g = geomOf(ops), adj = adjDefaults(ops);
      var src = m.bitmap; // ImageBitmap transferido desde el main
      var geo = applyGeometry(src.width, src.height, src, g);
      await applyColor(geo, adj, function (p) {
        self.postMessage({ id: m.id, progress: p });
      });
      var fmt = m.format || "image/png";
      var q = (m.quality == null ? 0.92 : m.quality);
      var blobOut;
      if (geo.convertToBlob) blobOut = await geo.convertToBlob({ type: fmt, quality: q });
      else {
        // fallback rarísimo en workers modernos; no debería ocurrir
        var c = new OffscreenCanvas(geo.width, geo.height);
        c.getContext("2d").drawImage(geo, 0, 0);
        blobOut = await c.convertToBlob({ type: fmt, quality: q });
      }
      self.postMessage({ id: m.id, ok: true, done: true, blob: blobOut, w: geo.width, h: geo.height, bytes: blobOut.size });
      if (src && src.close) src.close();
    }
    else if (m.cmd === "estimate") {
      // Estimación rápida: render a baja resolución y extrapola peso ~ proporcional a píxeles.
      var ops2 = m.ops || [];
      var g2 = geomOf(ops2), adj2 = adjDefaults(ops2);
      var src2 = m.bitmap;
      var geoFull = applyGeometry(src2.width, src2.height, src2, g2);
      var fullPx = geoFull.width * geoFull.height;
      var sc = Math.min(1, Math.sqrt((512 * 512) / fullPx));
      var tw2 = Math.max(1, Math.round(geoFull.width * sc)), th2 = Math.max(1, Math.round(geoFull.height * sc));
      var small = new OffscreenCanvas(tw2, th2);
      small.getContext("2d").drawImage(geoFull, 0, 0, tw2, th2);
      await applyColor(small, adj2, null);
      var fmt2 = m.format || "image/jpeg", q2 = (m.quality == null ? 0.92 : m.quality);
      var b2 = await small.convertToBlob({ type: fmt2, quality: q2 });
      var ratio = (tw2 * th2) > 0 ? fullPx / (tw2 * th2) : 1;
      var est = Math.round(b2.size * Math.sqrt(ratio)); // heurística conservadora
      self.postMessage({ id: m.id, ok: true, done: true, estimate: est, w: geoFull.width, h: geoFull.height });
      if (src2 && src2.close) src2.close();
    }
  } catch (err) {
    self.postMessage({ id: m.id, ok: false, error: String(err && err.message || err) });
  }
};
