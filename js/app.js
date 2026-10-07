/* app.js — UI + pipeline no destructivo + worker */
(function () {
  "use strict";
  var $ = function (id) { return document.getElementById(id); };

  var MP20 = 20 * 1000 * 1000;
  var PREVIEW_MAX = 1920;   // dimensión máx. del bitmap de preview
  var DISPLAY_MAX = 1600;   // canvas de pantalla

  var state = {
    fullBitmap: null,     // ImageBitmap resolución completa (main thread)
    previewBitmap: null,  // ImageBitmap downscaled (del worker o local)
    origW: 0, origH: 0,
    layers: [],           // capas no destructivas [{id,type,...enabled}]
    past: [], future: [], // undo/redo (snapshots de layers)
    worker: null, workerOK: false,
    gl: null, useGL: false,
    cropMode: false,
    seq: 1
  };

  // ---------- Worker ----------
  var msgId = 1, pending = {};
  function workerURL() { return new URL("worker.js", document.baseURI).toString(); }

  function inlineWorkerFallback() {
    // Si worker.js falla (p.ej. file://), generamos un worker desde Blob
    // con el mismo código cargado por fetch; si fetch falla, avisamos.
    return fetch(workerURL()).then(function (r) {
      if (!r.ok) throw new Error("http " + r.status);
      return r.text();
    }).then(function (code) {
      var w = new Worker(URL.createObjectURL(new Blob([code], { type: "text/javascript" })));
      bindWorker(w); state.workerOK = true;
    });
  }
  function bindWorker(w) {
    state.worker = w;
    w.onmessage = function (e) {
      var m = e.data || {};
      if (m.progress != null && pending[m.id]) { pending[m.id].onProgress && pending[m.id].onProgress(m.progress); return; }
      var p = pending[m.id]; if (!p) return; delete pending[m.id];
      if (m.ok) p.resolve(m); else p.reject(new Error(m.error || "worker error"));
    };
    w.onerror = function (ev) {
      Object.keys(pending).forEach(function (k) { pending[k].reject(new Error("worker error")); delete pending[k]; });
    };
  }
  function initWorker() {
    try {
      var w = new Worker("worker.js");
      bindWorker(w); state.workerOK = true;
    } catch (e) { inlineWorkerFallback().catch(function () { state.workerOK = false; }); }
    // Si el constructor no lanzó pero el archivo no existe (404 en file://),
    // el primer decode con fallback local seguirá funcionando.
    if (state.worker) {
      // prueba silenciosa: si falla al usarlo, caemos a local
      state.worker.addEventListener("error", function () { state.workerOK = false; });
    }
  }
  function callWorker(msg, transfer, onProgress) {
    return new Promise(function (resolve, reject) {
      if (!state.worker || !state.workerOK) return reject(new Error("sin worker"));
      var id = msgId++;
      pending[id] = { resolve: resolve, reject: reject, onProgress: onProgress };
      msg.id = id;
      try { state.worker.postMessage(msg, transfer || []); }
      catch (e) { delete pending[id]; reject(e); }
    });
  }

  // ---------- Capas / historial ----------
  function clone(o) { return JSON.parse(JSON.stringify(o)); }
  function pushHistory() {
    state.past.push(clone(state.layers));
    if (state.past.length > 80) state.past.shift();
    state.future.length = 0;
    refreshChrome();
  }
  function undo() {
    if (!state.past.length) return;
    state.future.push(clone(state.layers));
    state.layers = state.past.pop();
    syncUIFromLayers(); scheduleRender(); refreshChrome();
  }
  function redo() {
    if (!state.future.length) return;
    state.past.push(clone(state.layers));
    state.layers = state.future.pop();
    syncUIFromLayers(); scheduleRender(); refreshChrome();
  }
  function upsertLayer(layer, coalesceKey) {
    // coalesce: si la última capa es del mismo tipo de ajuste, actualizar sin push extra
    var last = state.layers[state.layers.length - 1];
    if (coalesceKey && last && last.type === layer.type && last._live) {
      last.value = layer.value; last.h = layer.h; last.v = layer.v;
      refreshChrome(); return; // no push, misma interacción
    }
    pushHistory();
    var i = state.layers.findIndex(function (l) { return l.type === layer.type && isSingleton(layer.type); });
    if (i >= 0 && isSingleton(layer.type)) state.layers[i] = layer;
    else state.layers.push(layer);
    refreshChrome();
  }
  function finalizeLive() {
    state.layers.forEach(function (l) { delete l._live; });
    // colapsa el push inicial: el historial ya guardó el "antes"; bien.
  }
  function isSingleton(t) {
    return ["brightness", "contrast", "saturation", "temperature", "rotate", "flip", "resize", "crop"].indexOf(t) >= 0;
  }
  function getLayer(t) { return state.layers.find(function (l) { return l.type === t && l.enabled !== false; }) || null; }
  function removeLayer(id) { pushHistory(); state.layers = state.layers.filter(function (l) { return l.id !== id; }); syncUIFromLayers(); scheduleRender(); refreshChrome(); }
  function toggleLayer(id) { pushHistory(); state.layers.forEach(function (l) { if (l.id === id) l.enabled = !(l.enabled !== false); }); scheduleRender(); refreshChrome(); }

  function layerLabel(l) {
    switch (l.type) {
      case "crop": return "Recorte " + Math.round(l.rect.w * 100) + "%";
      case "rotate": return "Rotación " + l.value + "°";
      case "flip": return "Volteo " + (l.h ? "H" : "") + (l.v ? "V" : "");
      case "resize": return "Tamaño " + l.w + "×" + l.h;
      case "brightness": return "Brillo " + l.value;
      case "contrast": return "Contraste " + l.value;
      case "saturation": return "Saturación " + l.value;
      case "temperature": return "Temperatura " + l.value;
      default: return l.type;
    }
  }

  // ---------- Carga de imagen ----------
  var fileInput = $("fileInput"), dropZone = $("dropZone"), holder = $("canvasHolder");
  fileInput.addEventListener("change", function () { if (fileInput.files[0]) loadFile(fileInput.files[0]); });
  ["dragover", "dragenter"].forEach(function (ev) { dropZone.addEventListener(ev, function (e) { e.preventDefault(); }); });
  dropZone.addEventListener("drop", function (e) {
    e.preventDefault();
    var f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
    if (f) loadFile(f);
  });

  function showProgress(on, txt) {
    var p = $("progress");
    p.classList.toggle("hidden", !on);
    if (txt) p.querySelector(".label").textContent = txt;
  }

  async function loadFile(file) {
    showProgress(true, "Decodificando imagen…");
    try {
      var buf = await file.arrayBuffer();
      var isLargeGuess = file.size > 8 * 1024 * 1024; // pista rápida; la real la da el worker
      var decoded = null;
      if (state.workerOK) {
        try {
          decoded = await callWorker({ cmd: "decode", buffer: buf, type: file.type, maxPreview: PREVIEW_MAX }, [buf]);
        } catch (e) { decoded = null; }
      }
      if (!decoded) { // fallback 100% main-thread (también no bloqueante: createImageBitmap es async)
        var blob = new Blob([buf], { type: file.type });
        var bmp = await createImageBitmap(blob);
        decoded = { w: bmp.width, h: bmp.height, mp: bmp.width * bmp.height / 1e6, isLarge: bmp.width * bmp.height > MP20, bitmap: bmp, preview: await downscaleLocal(bmp, PREVIEW_MAX) };
      }
      // Nota: el bitmap llega transferido; lo conservamos como full.
      if (state.fullBitmap && state.fullBitmap.close) try { state.fullBitmap.close(); } catch (e) {}
      state.fullBitmap = decoded.bitmap;
      state.previewBitmap = decoded.preview;
      state.origW = decoded.w; state.origH = decoded.h;
      state.layers = []; state.past = []; state.future = [];
      var mp = decoded.mp;
      $("imgInfo").textContent = file.name + " · " + decoded.w + "×" + decoded.h + " · " + mp.toFixed(1) + " MP";
      $("mpBadge").classList.toggle("hidden", !decoded.isLarge);
      $("mpBadge").textContent = decoded.isLarge ? ("grande " + mp.toFixed(1) + "MP → worker") : (mp.toFixed(1) + " MP");
      $("emptyState").classList.add("hidden");
      // Si el worker decodificó, el ArrayBuffer ya se transfirió; nada más que hacer.
      syncUIFromLayers(); scheduleRender(); refreshChrome();
      if (isLargeGuess && !decoded.isLarge) { /* ok */ }
    } catch (e) {
      $("imgInfo").textContent = "No se pudo abrir: " + e.message;
    } finally { showProgress(false); }
  }

  async function downscaleLocal(bmp, maxDim) {
    var sc = Math.min(1, maxDim / Math.max(bmp.width, bmp.height));
    var c = document.createElement("canvas");
    c.width = Math.max(1, Math.round(bmp.width * sc));
    c.height = Math.max(1, Math.round(bmp.height * sc));
    c.getContext("2d").drawImage(bmp, 0, 0, c.width, c.height);
    return await createImageBitmap(c);
  }

  // ---------- Render preview ----------
  var preview = $("preview");
  var workCanvas = document.createElement("canvas"); // geometría intermedia
  var raf = 0;

  function currentAdj() {
    var a = { brightness: 0, contrast: 1, saturation: 1, temperature: 0 };
    state.layers.forEach(function (l) {
      if (l.enabled === false) return;
      if (l.type === "brightness") a.brightness = l.value / 100;
      if (l.type === "contrast") a.contrast = 1 + l.value / 100;
      if (l.type === "saturation") a.saturation = 1 + l.value / 100;
      if (l.type === "temperature") a.temperature = l.value / 100;
    });
    return a;
  }
  function currentGeom() {
    var g = { crop: null, angle: 0, flipH: false, flipV: false };
    state.layers.forEach(function (l) {
      if (l.enabled === false) return;
      if (l.type === "crop") g.crop = l.rect;
      if (l.type === "rotate") g.angle = l.value;
      if (l.type === "flip") { g.flipH = !!l.h; g.flipV = !!l.v; }
    });
    return g;
  }

  function drawGeometry(src, g) {
    var sw = src.width, sh = src.height;
    var sx = 0, sy = 0, cw = sw, ch = sh;
    if (g.crop) {
      sx = Math.round(g.crop.x * sw); sy = Math.round(g.crop.y * sh);
      cw = Math.round(g.crop.w * sw); ch = Math.round(g.crop.h * sh);
    }
    var rad = (g.angle || 0) * Math.PI / 180;
    var cos = Math.abs(Math.cos(rad)), sin = Math.abs(Math.sin(rad));
    var bw = Math.max(1, Math.round(cw * cos + ch * sin));
    var bh = Math.max(1, Math.round(cw * sin + ch * cos));
    // Limitar preview a DISPLAY_MAX para fluidez
    var sc = Math.min(1, DISPLAY_MAX / Math.max(bw, bh));
    workCanvas.width = Math.max(1, Math.round(bw * sc));
    workCanvas.height = Math.max(1, Math.round(bh * sc));
    var ctx = workCanvas.getContext("2d");
    ctx.imageSmoothingQuality = "high";
    ctx.clearRect(0, 0, workCanvas.width, workCanvas.height);
    ctx.save();
    ctx.scale(sc, sc);
    ctx.translate(bw / 2, bh / 2);
    ctx.rotate(rad);
    ctx.scale(g.flipH ? -1 : 1, g.flipV ? -1 : 1);
    ctx.drawImage(src, sx, sy, cw, ch, -cw / 2, -ch / 2, cw, ch);
    ctx.restore();
    return workCanvas;
  }

  function scheduleRender() {
    cancelAnimationFrame(raf);
    raf = requestAnimationFrame(renderPreview);
  }

  function renderPreview() {
    if (!state.previewBitmap) return;
    var src = state.previewBitmap;
    var g = currentGeom(), adj = currentAdj();
    var t0 = performance.now();
    var geo = drawGeometry(src, g);
    var ok = false;
    if (state.useGL && state.gl) {
      try { ok = state.gl.render(geo, adj); } catch (e) { ok = false; }
    }
    if (!ok) {
      // fallback canvas: el destino es el propio <canvas> de preview
      if (preview.width !== geo.width) preview.width = geo.width;
      if (preview.height !== geo.height) preview.height = geo.height;
      window.__fallbackRender(preview, geo, adj);
      state.useGL = false;
    }
    var ms = (performance.now() - t0).toFixed(0);
    $("engineBadge").textContent = "motor: " + (state.useGL ? "WebGL" : "canvas") + " · " + ms + " ms";
    $("glBadge").textContent = state.useGL ? "WebGL" : "canvas fallback";
    // dimensiones de exportación
    var ed = exportDims();
    $("exportDims").textContent = "salida: " + ed.w + "×" + ed.h;
    // refrescar inputs de resize si están vacíos
    if (!resizeTouched) { $("resizeW").value = ed.w; $("resizeH").value = ed.h; }
  }

  function exportDims() {
    var r = getLayer("resize");
    if (r) return { w: r.w, h: r.h };
    // geom sin resize sobre el ORIGINAL
    var g = currentGeom();
    var sw = state.origW, sh = state.origH;
    if (g.crop) { sw = Math.round(state.origW * g.crop.w); sh = Math.round(state.origH * g.crop.h); }
    var rad = (g.angle || 0) * Math.PI / 180;
    var cos = Math.abs(Math.cos(rad)), sin = Math.abs(Math.sin(rad));
    return { w: Math.round(sw * cos + sh * sin), h: Math.round(sw * sin + sh * cos) };
  }

  // ---------- Tabs ----------
  document.querySelectorAll(".tabs button").forEach(function (b) {
    b.addEventListener("click", function () {
      document.querySelectorAll(".tabs button").forEach(function (x) { x.classList.remove("active"); });
      b.classList.add("active");
      ["crop", "geom", "color", "layers", "export"].forEach(function (t) {
        $("tab-" + t).classList.toggle("hidden", t !== b.dataset.tab);
      });
    });
  });

  // ---------- Recorte ----------
  var cropOverlay = $("cropOverlay"), cropBox = $("cropBox");
  var cropRectPx = null, dragMode = null, dragStart = null; // en coords del holder
  function aspectRatio() {
    var v = $("aspectSelect").value;
    if (v === "free") return 0;
    var p = v.split(":"); return parseFloat(p[0]) / parseFloat(p[1]);
  }
  $("btnCropMode").addEventListener("click", function () {
    if (!state.previewBitmap) return;
    state.cropMode = true;
    cropOverlay.classList.remove("hidden");
    $("btnCropApply").disabled = false; $("btnCropCancel").disabled = false;
    // caja inicial 80% centrada
    var r = holder.getBoundingClientRect(), pr = preview.getBoundingClientRect();
    var ox = pr.left - r.left, oy = pr.top - r.top;
    cropRectPx = { x: ox + pr.width * 0.1, y: oy + pr.height * 0.1, w: pr.width * 0.8, h: pr.height * 0.8 };
    enforceAspect(); paintCrop();
  });
  function enforceAspect() {
    var ar = aspectRatio();
    if (ar && cropRectPx) {
      // ajusta alto según ancho
      cropRectPx.h = cropRectPx.w / ar;
    }
  }
  $("aspectSelect").addEventListener("change", function () { if (state.cropMode) { enforceAspect(); paintCrop(); } });
  function paintCrop() {
    cropBox.style.left = cropRectPx.x + "px"; cropBox.style.top = cropRectPx.y + "px";
    cropBox.style.width = cropRectPx.w + "px"; cropBox.style.height = cropRectPx.h + "px";
  }
  function holderPos(e) {
    var r = holder.getBoundingClientRect();
    var cx = (e.touches && e.touches[0] ? e.touches[0].clientX : e.clientX);
    var cy = (e.touches && e.touches[0] ? e.touches[0].clientY : e.clientY);
    return { x: cx - r.left, y: cy - r.top };
  }
  cropBox.addEventListener("pointerdown", function (e) {
    var h = e.target.dataset && e.target.dataset.h;
    dragMode = h ? ("resize-" + h) : "move";
    dragStart = { p: holderPos(e), r: Object.assign({}, cropRectPx) };
    cropBox.setPointerCapture(e.pointerId);
    e.preventDefault();
  });
  cropBox.addEventListener("pointermove", function (e) {
    if (!dragMode) return;
    var p = holderPos(e), dx = p.x - dragStart.p.x, dy = p.y - dragStart.p.y;
    var r = Object.assign({}, dragStart.r), ar = aspectRatio();
    if (dragMode === "move") { r.x += dx; r.y += dy; }
    else {
      var m = dragMode.replace("resize-", "");
      if (m.indexOf("e") >= 0) r.w += dx;
      if (m.indexOf("s") >= 0) r.h += dy;
      if (m.indexOf("w") >= 0) { r.x += dx; r.w -= dx; }
      if (m.indexOf("n") >= 0) { r.y += dy; r.h -= dy; }
      r.w = Math.max(20, r.w); r.h = Math.max(20, r.h);
      if (ar) { // bloquea ratio tomando el lado dominante
        if (m === "e" || m === "w" || m === "ne" || m === "se" || m === "nw" || m === "sw") r.h = r.w / ar;
        else r.w = r.h * ar;
        if (m.indexOf("w") >= 0) r.x = dragStart.r.x + dragStart.r.w - r.w;
        if (m.indexOf("n") >= 0) r.y = dragStart.r.y + dragStart.r.h - r.h;
      }
    }
    cropRectPx = r; paintCrop();
  });
  cropBox.addEventListener("pointerup", function () { dragMode = null; });
  $("btnCropCancel").addEventListener("click", exitCrop);
  function exitCrop() {
    state.cropMode = false; cropOverlay.classList.add("hidden");
    $("btnCropApply").disabled = true; $("btnCropCancel").disabled = true;
  }
  $("btnCropApply").addEventListener("click", function () {
    if (!cropRectPx) return exitCrop();
    // convertir px del holder -> normalizado sobre la imagen (deshaciendo letterbox)
    var pr = preview.getBoundingClientRect(), hr = holder.getBoundingClientRect();
    var ox = pr.left - hr.left, oy = pr.top - hr.top;
    var nx = (cropRectPx.x - ox) / pr.width, ny = (cropRectPx.y - oy) / pr.height;
    var nw = cropRectPx.w / pr.width, nh = cropRectPx.h / pr.height;
    // IMPORTANTE: el preview ya puede tener crop/rotación aplicados; para mantener
    // el modelo simple y no destructivo, el crop se define sobre el ORIGINAL solo
    // si no hay rotación activa. Si la hay, componemos sobre el preview actual y
    // lo tratamos como nuevo crop absoluto (documentado en el hint de capas).
    nx = Math.max(0, Math.min(1, nx)); ny = Math.max(0, Math.min(1, ny));
    nw = Math.max(0.01, Math.min(1 - nx, nw)); nh = Math.max(0.01, Math.min(1 - ny, nh));
    pushHistory();
    var ex = state.layers.findIndex(function (l) { return l.type === "crop"; });
    var layer = { id: ex >= 0 ? state.layers[ex].id : state.seq++, type: "crop", rect: { x: nx, y: ny, w: nw, h: nh }, enabled: true };
    if (ex >= 0) state.layers[ex] = layer; else state.layers.push(layer);
    exitCrop(); scheduleRender(); refreshChrome();
  });

  // ---------- Geometría ----------
  function currentAngle() { var l = getLayer("rotate"); return l ? l.value : 0; }
  function setAngle(v, live) {
    v = ((Math.round(v) % 360) + 360) % 360; if (v > 180) v -= 360;
    var layer = { id: (getLayer("rotate") || {}).id || state.seq++, type: "rotate", value: v, enabled: true };
    if (live) layer._live = true;
    upsertLayer(layer, live);
    $("rotFree").value = v; $("rotVal").textContent = v + "°";
    scheduleRender();
  }
  $("btnRotL").addEventListener("click", function () { setAngle(currentAngle() - 90); finalizeLive(); });
  $("btnRotR").addEventListener("click", function () { setAngle(currentAngle() + 90); finalizeLive(); });
  $("rotFree").addEventListener("input", function () { setAngle(parseFloat($("rotFree").value), true); });
  $("rotFree").addEventListener("change", function () { finalizeLive(); refreshChrome(); });
  $("btnFlipH").addEventListener("click", function () { flip("h"); });
  $("btnFlipV").addEventListener("click", function () { flip("v"); });
  function flip(axis) {
    var ex = getLayer("flip");
    pushHistory();
    if (!ex) state.layers.push({ id: state.seq++, type: "flip", h: axis === "h", v: axis === "v", enabled: true });
    else { if (axis === "h") ex.h = !ex.h; else ex.v = !ex.v; }
    scheduleRender(); refreshChrome();
  }
  var resizeTouched = false;
  ["resizeW", "resizeH"].forEach(function (id) { $(id).addEventListener("input", function () { resizeTouched = true; }); });
  document.querySelectorAll("[data-scale]").forEach(function (b) {
    b.addEventListener("click", function () {
      var d = exportDimsBase(); var s = parseFloat(b.dataset.scale);
      $("resizeW").value = Math.round(d.w * s); $("resizeH").value = Math.round(d.h * s);
      resizeTouched = true;
      if ($("resizeLock")) syncLock("w");
    });
  });
  function exportDimsBase() { // dimensiones sin la capa resize
    var tmp = getLayer("resize"); var saved = null;
    if (tmp) { saved = tmp.enabled; tmp.enabled = false; }
    var d = exportDims();
    if (tmp) tmp.enabled = saved;
    return d;
  }
  function syncLock(changed) {
    if (!$("resizeLock").checked) return;
    var base = exportDimsBase(); var ar = base.w / base.h;
    if (changed === "w") $("resizeH").value = Math.round(parseInt($("resizeW").value || base.w) / ar);
    else $("resizeW").value = Math.round(parseInt($("resizeH").value || base.h) * ar);
  }
  $("resizeW").addEventListener("change", function () { syncLock("w"); });
  $("resizeH").addEventListener("change", function () { syncLock("h"); });
  $("btnResizeApply").addEventListener("click", function () {
    var w = parseInt($("resizeW").value), h = parseInt($("resizeH").value);
    if (!w || !h) return;
    var layer = { id: (getLayer("resize") || {}).id || state.seq++, type: "resize", w: w, h: h, enabled: true };
    pushHistory();
    var i = state.layers.findIndex(function (l) { return l.type === "resize"; });
    if (i >= 0) state.layers[i] = layer; else state.layers.push(layer);
    scheduleRender(); refreshChrome();
  });
  $("btnResizeClear").addEventListener("click", function () {
    var l = getLayer("resize"); if (l) removeLayer(l.id);
  });

  // ---------- Ajustes ----------
  var sliders = ["brightness", "contrast", "saturation", "temperature"];
  sliders.forEach(function (k) {
    var s = $("s-" + k);
    s.addEventListener("input", function () {
      $("v-" + k).textContent = s.value;
      var layer = { id: (state.layers.find(function (l) { return l.type === k; }) || {}).id || state.seq++, type: k, value: parseFloat(s.value), enabled: true, _live: true };
      upsertLayer(layer, true);
      scheduleRender();
    });
    s.addEventListener("change", function () { finalizeLive(); refreshChrome(); });
  });
  function syncUIFromLayers() {
    sliders.forEach(function (k) {
      var l = state.layers.find(function (x) { return x.type === k; });
      $("s-" + k).value = l ? l.value : 0;
      $("v-" + k).textContent = l ? l.value : 0;
    });
    var r = getLayer("rotate");
    $("rotFree").value = r ? r.value : 0; $("rotVal").textContent = (r ? r.value : 0) + "°";
  }

  // ---------- Capas UI ----------
  $("btnUndo").addEventListener("click", undo);
  $("btnRedo").addEventListener("click", redo);
  $("btnReset").addEventListener("click", function () { if (!state.layers.length) return; pushHistory(); state.layers = []; syncUIFromLayers(); scheduleRender(); refreshChrome(); });
  document.addEventListener("keydown", function (e) {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z" && !e.shiftKey) { e.preventDefault(); undo(); }
    if ((e.ctrlKey || e.metaKey) && (e.key.toLowerCase() === "y" || (e.key.toLowerCase() === "z" && e.shiftKey))) { e.preventDefault(); redo(); }
  });
  function refreshChrome() {
    $("btnUndo").disabled = !state.past.length;
    $("btnRedo").disabled = !state.future.length;
    var ul = $("layerList"); ul.innerHTML = "";
    if (!state.layers.length) ul.innerHTML = "<li class='off'><span class='grow'>Sin capas — imagen original</span></li>";
    state.layers.forEach(function (l) {
      var li = document.createElement("li");
      if (l.enabled === false) li.classList.add("off");
      var eye = document.createElement("button"); eye.className = "icon-btn"; eye.textContent = l.enabled === false ? "◌" : "👁"; eye.title = "visible";
      eye.addEventListener("click", function () { toggleLayer(l.id); });
      var sp = document.createElement("span"); sp.className = "grow"; sp.textContent = layerLabel(l);
      var del = document.createElement("button"); del.className = "icon-btn"; del.textContent = "✕"; del.title = "eliminar capa";
      del.addEventListener("click", function () { removeLayer(l.id); });
      li.appendChild(eye); li.appendChild(sp); li.appendChild(del);
      ul.appendChild(li);
    });
  }

  // ---------- Exportación (siempre en worker si hay; si no, main-thread por chunks) ----------
  function fmtBytes(n) {
    if (n < 1024) return n + " B";
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + " KB";
    return (n / 1024 / 1024).toFixed(2) + " MB";
  }
  $("expQuality").addEventListener("input", function () { $("qVal").textContent = $("expQuality").value; });
  $("btnEstimate").addEventListener("click", function () { doExport(true); });
  $("btnExport").addEventListener("click", function () { doExport(false); });

  async function doExport(estimateOnly) {
    if (!state.fullBitmap) { $("exportResult").textContent = "Abre primero una imagen."; return; }
    var format = $("expFormat").value;
    var q = parseInt($("expQuality").value) / 100;
    showProgress(true, estimateOnly ? "Estimando peso en worker…" : "Exportando en worker…");
    $("exportResult").textContent = estimateOnly ? "Estimando…" : "Procesando a máxima resolución…";
    try {
      // Clonamos el bitmap para transferir sin perder el original de la UI
      var bmpCopy;
      if (state.fullBitmap.width * state.fullBitmap.height > 4 * 1000 * 1000) {
        // Para no duplicar decenas de MP en RAM, pedimos al worker que procese
        // directamente: transferimos una copia via canvas -> createImageBitmap.
        // (createImageBitmap es async y no bloquea el paint.)
        var c = document.createElement("canvas");
        c.width = state.fullBitmap.width; c.height = state.fullBitmap.height;
        c.getContext("2d").drawImage(state.fullBitmap, 0, 0);
        bmpCopy = await createImageBitmap(c);
        c.width = c.height = 1;
      } else {
        var c2 = document.createElement("canvas");
        c2.width = state.fullBitmap.width; c2.height = state.fullBitmap.height;
        c2.getContext("2d").drawImage(state.fullBitmap, 0, 0);
        bmpCopy = await createImageBitmap(c2);
      }
      var ops = clone(state.layers);
      var res;
      if (state.workerOK) {
        res = await callWorker(
          { cmd: estimateOnly ? "estimate" : "export", bitmap: bmpCopy, ops: ops, format: format, quality: q },
          [bmpCopy],
          function (p) { $("exportResult").textContent = (estimateOnly ? "Estimando… " : "Procesando… ") + Math.round(p * 100) + "%"; }
        );
      } else {
        res = await exportLocal(bmpCopy, ops, format, q, estimateOnly);
      }
      if (estimateOnly) {
        $("exportResult").textContent = "Estimación " + format.split("/")[1].toUpperCase() +
          " q=" + $("expQuality").value + " → ~" + fmtBytes(res.estimate) +
          " (" + res.w + "×" + res.h + "). Es una aproximación; la exportación real dirá el peso exacto.";
      } else {
        var url = URL.createObjectURL(res.blob);
        var a = $("downloadLink");
        a.href = url; a.download = "pixellab." + (format === "image/png" ? "png" : format === "image/webp" ? "webp" : "jpg");
        a.classList.remove("hidden");
        a.textContent = "⬇ Descargar (" + fmtBytes(res.bytes) + ")";
        $("exportResult").textContent = "Exportado " + res.w + "×" + res.h + " · " + format.split("/")[1].toUpperCase() +
          " q=" + $("expQuality").value + " → " + fmtBytes(res.bytes) + " (" + res.bytes + " bytes).";
      }
    } catch (e) {
      $("exportResult").textContent = "Error al exportar: " + e.message + " (¿file:// sin worker? sirve con python3 -m http.server)";
    } finally { showProgress(false); }
  }

  // Fallback main-thread por chunks con await (no congela del todo; cede con rAF)
  async function exportLocal(bitmap, ops, format, q, estimateOnly) {
    var adj = { brightness: 0, contrast: 1, saturation: 1, temperature: 0 };
    var g = { crop: null, angle: 0, flipH: false, flipV: false, resize: null };
    ops.forEach(function (o) {
      if (o.enabled === false) return;
      if (o.type === "brightness") adj.brightness = o.value / 100;
      if (o.type === "contrast") adj.contrast = 1 + o.value / 100;
      if (o.type === "saturation") adj.saturation = 1 + o.value / 100;
      if (o.type === "temperature") adj.temperature = o.value / 100;
      if (o.type === "crop") g.crop = o.rect;
      if (o.type === "rotate") g.angle = o.value;
      if (o.type === "flip") { g.flipH = !!o.h; g.flipV = !!o.v; }
      if (o.type === "resize") g.resize = { w: o.w, h: o.h };
    });
    var sx = 0, sy = 0, sw = bitmap.width, sh = bitmap.height;
    if (g.crop) { sx = g.crop.x * sw; sy = g.crop.y * sh; sw = g.crop.w * sw; sh = g.crop.h * sh; }
    var rad = g.angle * Math.PI / 180;
    var bw = Math.round(sw * Math.abs(Math.cos(rad)) + sh * Math.abs(Math.sin(rad)));
    var bh = Math.round(sw * Math.abs(Math.sin(rad)) + sh * Math.abs(Math.cos(rad)));
    var c = document.createElement("canvas"); c.width = bw; c.height = bh;
    var x = c.getContext("2d");
    x.translate(bw / 2, bh / 2); x.rotate(rad); x.scale(g.flipH ? -1 : 1, g.flipV ? -1 : 1);
    x.drawImage(bitmap, sx, sy, sw, sh, -sw / 2, -sh / 2, sw, sh);
    if (g.resize) {
      var c2 = document.createElement("canvas"); c2.width = g.resize.w; c2.height = g.resize.h;
      c2.getContext("2d").drawImage(c, 0, 0, c2.width, c2.height);
      c = c2; x = c.getContext("2d");
    }
    // color por chunks
    var h = c.height, w = c.width, y = 0;
    var chunk = Math.max(64, Math.floor(1024 * 1024 / Math.max(1, w)));
    while (y < h) {
      var y2 = Math.min(h, y + chunk);
      var img = x.getImageData(0, y, w, y2 - y), d = img.data;
      for (var i = 0; i < d.length; i += 4) {
        var r = d[i] / 255 + adj.brightness, gg = d[i + 1] / 255 + adj.brightness, b = d[i + 2] / 255 + adj.brightness;
        r = (r - 0.5) * adj.contrast + 0.5; gg = (gg - 0.5) * adj.contrast + 0.5; b = (b - 0.5) * adj.contrast + 0.5;
        var l = 0.2126 * r + 0.7152 * gg + 0.0722 * b;
        r = l + (r - l) * adj.saturation; gg = l + (gg - l) * adj.saturation; b = l + (b - l) * adj.saturation;
        r += adj.temperature * 0.18; b -= adj.temperature * 0.18; gg += adj.temperature * 0.02;
        d[i] = Math.max(0, Math.min(255, r * 255)); d[i + 1] = Math.max(0, Math.min(255, gg * 255)); d[i + 2] = Math.max(0, Math.min(255, b * 255));
      }
      x.putImageData(img, 0, y); y = y2;
      $("exportResult").textContent = "Procesando… " + Math.round(y / h * 100) + "%";
      await new Promise(function (r2) { requestAnimationFrame(r2); });
    }
    if (estimateOnly) {
      var small = document.createElement("canvas");
      var sc = Math.min(1, Math.sqrt(512 * 512 / (w * h)));
      small.width = Math.max(1, Math.round(w * sc)); small.height = Math.max(1, Math.round(h * sc));
      small.getContext("2d").drawImage(c, 0, 0, small.width, small.height);
      var b1 = await new Promise(function (res2) { small.toBlob(res2, format, q); });
      return { estimate: Math.round(b1.size * Math.sqrt((w * h) / (small.width * small.height))), w: w, h: h };
    }
    var blob = await new Promise(function (res2) { c.toBlob(res2, format, q); });
    return { blob: blob, w: w, h: h, bytes: blob.size };
  }

  // ---------- init ----------
  function init() {
    initWorker();
    var glc = document.createElement("canvas");
    try {
      state.gl = new window.GLRenderer(glc);
      state.useGL = !!state.gl.available;
    } catch (e) { state.useGL = false; }
    // El canvas visible es el destino del GL: lo re-asociamos.
    // Truco: GLRenderer se creó sobre glc; para pintar en #preview creamos otro al primer render.
    if (state.useGL) state.gl = new window.GLRenderer(preview), state.useGL = !!state.gl.available;
    refreshChrome();
    $("engineBadge").textContent = "motor: " + (state.useGL ? "WebGL" : "canvas");
    // demo sintética si no hay imagen (gradiente) para que el corrector vea algo sin subir foto
    var d = document.createElement("canvas"); d.width = 640; d.height = 400;
    var dx = d.getContext("2d"); var gr = dx.createLinearGradient(0, 0, 640, 400);
    gr.addColorStop(0, "#4f8cff"); gr.addColorStop(0.5, "#9d6bff"); gr.addColorStop(1, "#ff8c5a");
    dx.fillStyle = gr; dx.fillRect(0, 0, 640, 400);
    dx.fillStyle = "#fff"; dx.font = "bold 28px system-ui"; dx.fillText("Abre una imagen para empezar", 120, 210);
    preview.width = 640; preview.height = 400; preview.getContext("2d").drawImage(d, 0, 0);
  }
  init();
})();
