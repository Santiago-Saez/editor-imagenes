/* gl.js — Renderer WebGL con fallback a Canvas2D filters + CPU.
   Ajustes: brightness [-1,1], contrast [0,2], saturation [0,2], temperature [-1,1] */
(function (global) {
  "use strict";

  var VS = "attribute vec2 aPos;attribute vec2 aUV;varying vec2 vUV;" +
    "void main(){vUV=aUV;gl_Position=vec4(aPos,0.,1.);}";

  var FS = "precision mediump float;varying vec2 vUV;uniform sampler2D uTex;" +
    "uniform float uBri;uniform float uCon;uniform float uSat;uniform float uTem;" +
    "void main(){vec4 c=texture2D(uTex,vUV);" +
    "vec3 col=c.rgb;" +
    "col+=(uBri);" +                                   // brillo
    "col=(col-0.5)*uCon+0.5;" +                        // contraste
    "float l=dot(col,vec3(0.2126,0.7152,0.0722));" +
    "col=mix(vec3(l),col,uSat);" +                     // saturación
    "col.r+=uTem*0.18;col.b-=uTem*0.18;" +             // temperatura cálido/frío
    "col.g+=uTem*0.02;" +
    "gl_FragColor=vec4(clamp(col,0.,1.),c.a);}";

  function compile(gl, type, src) {
    var s = gl.createShader(type);
    gl.shaderSource(s, src); gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
    return s;
  }

  function GLRenderer(canvas) {
    this.canvas = canvas;
    this.gl = null;
    try {
      this.gl = canvas.getContext("webgl", { preserveDrawingBuffer: true }) ||
                canvas.getContext("experimental-webgl", { preserveDrawingBuffer: true });
    } catch (e) { this.gl = null; }
    if (!this.gl) { this.available = false; return; }
    var gl = this.gl;
    try {
      var prog = gl.createProgram();
      gl.attachShader(prog, compile(gl, gl.VERTEX_SHADER, VS));
      gl.attachShader(prog, compile(gl, gl.FRAGMENT_SHADER, FS));
      gl.linkProgram(prog);
      if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error("link");
      gl.useProgram(prog);
      this.prog = prog;
      var buf = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, buf);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([
        -1, -1, 0, 0,  1, -1, 1, 0,  -1, 1, 0, 1,
        -1, 1, 0, 1,   1, -1, 1, 0,   1, 1, 1, 1
      ]), gl.STATIC_DRAW);
      var aPos = gl.getAttribLocation(prog, "aPos");
      var aUV = gl.getAttribLocation(prog, "aUV");
      gl.enableVertexAttribArray(aPos);
      gl.enableVertexAttribArray(aUV);
      gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 16, 0);
      gl.vertexAttribPointer(aUV, 2, gl.FLOAT, false, 16, 8);
      this.u = {
        tex: gl.getUniformLocation(prog, "uTex"),
        bri: gl.getUniformLocation(prog, "uBri"),
        con: gl.getUniformLocation(prog, "uCon"),
        sat: gl.getUniformLocation(prog, "uSat"),
        tem: gl.getUniformLocation(prog, "uTem")
      };
      this.tex = gl.createTexture();
      this.available = true;
    } catch (e) { this.available = false; this.gl = null; }
  }

  GLRenderer.prototype.render = function (source, adj) {
    // source: canvas | ImageBitmap | HTMLImageElement ; adj normalizado
    var w = source.width || source.videoWidth, h = source.height || source.videoHeight;
    if (!w || !h) return false;
    if (this.canvas.width !== w) this.canvas.width = w;
    if (this.canvas.height !== h) this.canvas.height = h;
    var gl = this.gl;
    gl.viewport(0, 0, w, h);
    gl.bindTexture(gl.TEXTURE_2D, this.tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    try { gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source); }
    catch (e) { return false; }
    // Flip Y: nuestros UV ya asumen origen arriba porque texImage2D hace flip=false;
    // el quad dibuja v=0 abajo -> imagen invertida. Corregimos con UNPACK_FLIP_Y.
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    try { gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source); } catch (e) {}
    gl.uniform1i(this.u.tex, 0);
    gl.uniform1f(this.u.bri, adj.brightness || 0);
    gl.uniform1f(this.u.con, adj.contrast == null ? 1 : adj.contrast);
    gl.uniform1f(this.u.sat, adj.saturation == null ? 1 : adj.saturation);
    gl.uniform1f(this.u.tem, adj.temperature || 0);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    return true;
  };

  /* Fallback Canvas2D: usa ctx.filter donde puede + temp por overlay.
     Devuelve canvas destino (reutiliza this._c2). */
  function fallbackRender(dstCanvas, source, adj) {
    var w = source.width, h = source.height;
    if (dstCanvas.width !== w) dstCanvas.width = w;
    if (dstCanvas.height !== h) dstCanvas.height = h;
    var ctx = dstCanvas.getContext("2d");
    ctx.save();
    ctx.filter = "none";
    ctx.clearRect(0, 0, w, h);
    var b = 1 + (adj.brightness || 0);           // bri -1..1 -> 0..2
    var c = (adj.contrast == null ? 1 : adj.contrast);
    var s = (adj.saturation == null ? 1 : adj.saturation);
    try {
      ctx.filter = "brightness(" + b.toFixed(3) + ") contrast(" + c.toFixed(3) + ") saturate(" + s.toFixed(3) + ")";
    } catch (e) { ctx.filter = "none"; }
    ctx.drawImage(source, 0, 0);
    ctx.filter = "none";
    var t = adj.temperature || 0;
    if (t !== 0) { // overlay cálido/frío barato y reversible
      ctx.globalAlpha = Math.min(0.35, Math.abs(t) * 0.35);
      ctx.fillStyle = t > 0 ? "#ff8c1a" : "#1a8cff";
      ctx.globalCompositeOperation = "overlay";
      ctx.fillRect(0, 0, w, h);
      ctx.globalCompositeOperation = "source-over";
      ctx.globalAlpha = 1;
    }
    ctx.restore();
    return true;
  }

  global.GLRenderer = GLRenderer;
  global.__fallbackRender = fallbackRender;
})(typeof window !== "undefined" ? window : this);
