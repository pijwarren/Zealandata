// Client-side mirror of the native projector's render pipeline (see
// projector/projector.c), used by the admin panel's floating preview
// lightbox so an operator can see the effect of the calibration sliders
// without watching the physical print. Deliberately NOT three.js (see the
// project's move away from it) -- this is plain WebGL2, ported line-for-line
// from the C matrix/shader code so the two stay in lock-step.
//
// It never touches the physical projector or its video pipeline: there's no
// video here at all, just the model textured with the same static loading
// image the projector shows when idle, plus the same orientation gizmo.
// Rendering is done on demand (on open, and whenever a mapping value
// changes) rather than in a continuous rAF loop, since nothing here
// animates on its own.

const MODEL_URL = "/api/projection/model";
const TEXTURE_URL = "/api/loading-image";

// Mirrors projector.c's BASE_ORIENTATION_*_DEG / INVERT_RELIEF / video
// orientation constants exactly -- these are fixed properties of this
// model file and the native renderer's fixed camera, not calibration
// knobs, so they're hardcoded here the same way.
const BASE_ORIENTATION_Z_DEG = 90;
const BASE_ORIENTATION_X_DEG = 180;
const VIDEO_ROTATION_CW_DEG = 90;
const VIDEO_FLIP_ACROSS_HORIZONTAL = false;

const GIZMO_SEGMENTS = 64;
const GIZMO_RADIUS = 0.4;

// ---------------------------------------------------------------- shaders

const MODEL_VS = `#version 300 es
layout(location=0) in vec3 aPos;
layout(location=1) in vec3 aNrm;
layout(location=2) in vec2 aUV;
uniform mat4 uMVP;
uniform mat4 uModel;
out vec2 vUV;
out vec3 vNrm;
void main(){
  vUV = aUV;
  vNrm = mat3(uModel) * aNrm;
  gl_Position = uMVP * vec4(aPos, 1.0);
}`;

const MODEL_FS = `#version 300 es
precision mediump float;
in vec2 vUV;
in vec3 vNrm;
uniform sampler2D uTex;
uniform int uShading;
out vec4 oColor;
void main(){
  vec4 c = texture(uTex, vUV);
  if (uShading == 1) {
    vec3 L = normalize(vec3(-1.0, 1.6, 1.0));
    float d = max(dot(normalize(vNrm), L), 0.0);
    c.rgb *= (0.55 + 1.1 * d);
  }
  oColor = vec4(c.rgb, 1.0);
}`;

const WARP_VS = `#version 300 es
layout(location=0) in vec3 aClipPos;
layout(location=1) in vec2 aUV;
out vec2 vUV;
void main(){
  vUV = aUV;
  gl_Position = vec4(aClipPos.xy, 0.0, aClipPos.z);
}`;

const WARP_FS = `#version 300 es
precision mediump float;
in vec2 vUV;
uniform sampler2D uSceneTex;
out vec4 oColor;
void main(){
  oColor = texture(uSceneTex, vUV);
}`;

const GIZMO_VS = `#version 300 es
layout(location=0) in vec3 aPos;
layout(location=1) in vec3 aCol;
uniform mat4 uMVP;
out vec3 vCol;
void main(){
  vCol = aCol;
  gl_Position = uMVP * vec4(aPos, 1.0);
}`;

const GIZMO_FS = `#version 300 es
precision mediump float;
in vec3 vCol;
out vec4 oColor;
void main(){ oColor = vec4(vCol, 1.0); }`;

// ------------------------------------------------------------- mat4 math
// Column-major, matching projector.c's mat4 convention exactly (out = a*b,
// applied to a column vector as m*v) so the composition logic ports 1:1.

function matIdentity() {
  const m = new Float32Array(16);
  m[0] = m[5] = m[10] = m[15] = 1;
  return m;
}
function matMul(a, b) {
  const t = new Float32Array(16);
  for (let c = 0; c < 4; c++) {
    for (let r = 0; r < 4; r++) {
      let s = 0;
      for (let k = 0; k < 4; k++) s += a[k * 4 + r] * b[c * 4 + k];
      t[c * 4 + r] = s;
    }
  }
  return t;
}
function matRotX(rad) {
  const m = matIdentity();
  m[5] = Math.cos(rad); m[6] = Math.sin(rad); m[9] = -Math.sin(rad); m[10] = Math.cos(rad);
  return m;
}
function matRotY(rad) {
  const m = matIdentity();
  m[0] = Math.cos(rad); m[2] = -Math.sin(rad); m[8] = Math.sin(rad); m[10] = Math.cos(rad);
  return m;
}
function matRotZ(rad) {
  const m = matIdentity();
  m[0] = Math.cos(rad); m[1] = Math.sin(rad); m[4] = -Math.sin(rad); m[5] = Math.cos(rad);
  return m;
}
function matTranslate(x, y, z) {
  const m = matIdentity();
  m[12] = x; m[13] = y; m[14] = z;
  return m;
}
function matScale(s) {
  const m = matIdentity();
  m[0] = m[5] = m[10] = s;
  return m;
}
function matOrtho(l, r, b, t, n, f) {
  const m = matIdentity();
  m[0] = 2 / (r - l); m[5] = 2 / (t - b); m[10] = -2 / (f - n);
  m[12] = -(r + l) / (r - l); m[13] = -(t + b) / (t - b); m[14] = -(f + n) / (f - n);
  return m;
}

// Unit-square-to-quad projective mapping, ported from projector.c's
// quad_homography() -- see its comment there for why this (rather than a
// plain 2-triangle affine quad) is needed for a seamless keystone warp.
function quadHomography(x0, y0, x1, y1, x2, y2, x3, y3) {
  const dx1 = x1 - x2, dx2 = x3 - x2, dx3 = x0 - x1 + x2 - x3;
  const dy1 = y1 - y2, dy2 = y3 - y2, dy3 = y0 - y1 + y2 - y3;
  let a, b, c, d, e, f, g, h;
  if (Math.abs(dx3) < 1e-6 && Math.abs(dy3) < 1e-6) {
    a = x1 - x0; b = x2 - x1; c = x0;
    d = y1 - y0; e = y2 - y1; f = y0;
    g = 0; h = 0;
  } else {
    const denom = dx1 * dy2 - dx2 * dy1;
    g = (dx3 * dy2 - dx2 * dy3) / denom;
    h = (dx1 * dy3 - dx3 * dy1) / denom;
    a = x1 - x0 + g * x1; b = x3 - x0 + h * x3; c = x0;
    d = y1 - y0 + g * y1; e = y3 - y0 + h * y3; f = y0;
  }
  return [a, b, c, d, e, f, g, h, 1];
}
function homographyApply(H, s, t) {
  const x = H[0] * s + H[1] * t + H[2];
  const y = H[3] * s + H[4] * t + H[5];
  const w = H[6] * s + H[7] * t + H[8];
  return [x, y, w];
}

function projectNdc(mvp, x, y, z) {
  const cx = mvp[0] * x + mvp[4] * y + mvp[8] * z + mvp[12];
  const cy = mvp[1] * x + mvp[5] * y + mvp[9] * z + mvp[13];
  const cw = mvp[3] * x + mvp[7] * y + mvp[11] * z + mvp[15] || 1;
  return [cx / cw, cy / cw];
}

// ----------------------------------------------------------------- shaders

function compileShader(gl, type, src) {
  const s = gl.createShader(type);
  gl.shaderSource(s, src);
  gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(s);
    gl.deleteShader(s);
    throw new Error("shader compile failed: " + log);
  }
  return s;
}
function linkProgram(gl, vsSrc, fsSrc) {
  const prog = gl.createProgram();
  gl.attachShader(prog, compileShader(gl, gl.VERTEX_SHADER, vsSrc));
  gl.attachShader(prog, compileShader(gl, gl.FRAGMENT_SHADER, fsSrc));
  gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
    throw new Error("program link failed: " + gl.getProgramInfoLog(prog));
  }
  return prog;
}

// -------------------------------------------------------------- OBJ / model
// Mirrors projector.c's load_obj(): fan-triangulated indexed geometry, the
// same up-axis heuristic and remap, the same planar top-down UV projection
// (with the same fixed video-orientation constants), and the same
// area-weighted smooth normals. INVERT_RELIEF is left out entirely since
// the native renderer's own INVERT_RELIEF is false.

function orientUv(u, v) {
  if (VIDEO_FLIP_ACROSS_HORIZONTAL) v = 1 - v;
  switch (((VIDEO_ROTATION_CW_DEG % 360) + 360) % 360) {
    case 90: return [1 - v, u];
    case 180: return [1 - u, 1 - v];
    case 270: return [v, 1 - u];
    default: return [u, v];
  }
}

function parseObj(text) {
  const positions = [];
  const indices = [];
  const lines = text.split("\n");
  for (let li = 0; li < lines.length; li++) {
    const line = lines[li];
    if (line.charCodeAt(0) === 118 /* 'v' */ && line[1] === " ") {
      const parts = line.slice(2).trim().split(/\s+/);
      positions.push(parseFloat(parts[0]), parseFloat(parts[1]), parseFloat(parts[2]));
    } else if (line.charCodeAt(0) === 102 /* 'f' */ && line[1] === " ") {
      const toks = line.slice(2).trim().split(/\s+/);
      const verts = toks.map((tok) => {
        const val = parseInt(tok, 10); // first int before any /vt/vn
        const nvert = positions.length / 3;
        return val > 0 ? val - 1 : nvert + val;
      });
      for (let k = 2; k < verts.length; k++) {
        indices.push(verts[0], verts[k - 1], verts[k]);
      }
    }
  }

  const nvert = positions.length / 3;
  const pos = new Float32Array(positions);

  const bbox = () => {
    let minX = pos[0], maxX = pos[0], minY = pos[1], maxY = pos[1], minZ = pos[2], maxZ = pos[2];
    for (let i = 0; i < nvert; i++) {
      const x = pos[i * 3], y = pos[i * 3 + 1], z = pos[i * 3 + 2];
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (y < minY) minY = y; if (y > maxY) maxY = y;
      if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
    }
    return { minX, maxX, minY, maxY, minZ, maxZ };
  };

  let b = bbox();
  let sizeX = b.maxX - b.minX, sizeY = b.maxY - b.minY, sizeZ = b.maxZ - b.minZ;
  let up = (sizeY <= sizeX && sizeY <= sizeZ) ? "y" : (sizeZ <= sizeX && sizeZ <= sizeY) ? "z" : "y";

  if (up === "y") {
    // Rotate -90deg about X: swap height into depth, matching load_obj.
    for (let i = 0; i < nvert; i++) {
      const y = pos[i * 3 + 1], z = pos[i * 3 + 2];
      pos[i * 3 + 1] = z;
      pos[i * 3 + 2] = -y;
    }
    b = bbox();
    sizeX = b.maxX - b.minX; sizeY = b.maxY - b.minY; sizeZ = b.maxZ - b.minZ;
    up = "z";
  }

  const ctrX = (b.minX + b.maxX) / 2, ctrY = (b.minY + b.maxY) / 2, ctrZ = (b.minZ + b.maxZ) / 2;
  const ext = Math.max(sizeX, sizeY, sizeZ);
  const norm = ext > 0 ? 2 / ext : 1;
  for (let i = 0; i < nvert; i++) {
    pos[i * 3] = (pos[i * 3] - ctrX) * norm;
    pos[i * 3 + 1] = (pos[i * 3 + 1] - ctrY) * norm;
    pos[i * 3 + 2] = (pos[i * 3 + 2] - ctrZ) * norm;
  }
  sizeX *= norm; sizeY *= norm; sizeZ *= norm;

  const uv = new Float32Array(nvert * 2);
  for (let i = 0; i < nvert; i++) {
    let u = sizeX > 0 ? (pos[i * 3] + sizeX / 2) / sizeX : 0.5;
    let v = sizeY > 0 ? (pos[i * 3 + 1] + sizeY / 2) / sizeY : 0.5;
    [u, v] = orientUv(u, v);
    uv[i * 2] = u; uv[i * 2 + 1] = v;
  }

  const idx = new Uint32Array(indices);
  const nrm = new Float32Array(nvert * 3);
  for (let i = 0; i + 2 < idx.length; i += 3) {
    const ia = idx[i], ib = idx[i + 1], ic = idx[i + 2];
    const ax = pos[ia * 3], ay = pos[ia * 3 + 1], az = pos[ia * 3 + 2];
    const bx = pos[ib * 3], by = pos[ib * 3 + 1], bz = pos[ib * 3 + 2];
    const cx = pos[ic * 3], cy = pos[ic * 3 + 1], cz = pos[ic * 3 + 2];
    const e1x = bx - ax, e1y = by - ay, e1z = bz - az;
    const e2x = cx - ax, e2y = cy - ay, e2z = cz - az;
    const nx = e1y * e2z - e1z * e2y;
    const ny = e1z * e2x - e1x * e2z;
    const nz = e1x * e2y - e1y * e2x;
    nrm[ia * 3] += nx; nrm[ia * 3 + 1] += ny; nrm[ia * 3 + 2] += nz;
    nrm[ib * 3] += nx; nrm[ib * 3 + 1] += ny; nrm[ib * 3 + 2] += nz;
    nrm[ic * 3] += nx; nrm[ic * 3 + 1] += ny; nrm[ic * 3 + 2] += nz;
  }
  for (let i = 0; i < nvert; i++) {
    const x = nrm[i * 3], y = nrm[i * 3 + 1], z = nrm[i * 3 + 2];
    const l = Math.sqrt(x * x + y * y + z * z);
    if (l > 0) { nrm[i * 3] = x / l; nrm[i * 3 + 1] = y / l; nrm[i * 3 + 2] = z / l; }
  }

  return { pos, nrm, uv, idx };
}

// -------------------------------------------------------------- gizmo geo

function buildGizmoRings() {
  const verts = new Float32Array(3 * GIZMO_SEGMENTS * 6); // x,y,z,r,g,b
  const colors = [[1, 0.25, 0.25], [0.25, 1, 0.25], [0.35, 0.55, 1]];
  for (let ring = 0; ring < 3; ring++) {
    for (let s = 0; s < GIZMO_SEGMENTS; s++) {
      const a = (2 * Math.PI * s) / GIZMO_SEGMENTS;
      const c = Math.cos(a), sn = Math.sin(a);
      let x = 0, y = 0, z = 0;
      if (ring === 0) { y = c * GIZMO_RADIUS; z = sn * GIZMO_RADIUS; }
      else if (ring === 1) { x = c * GIZMO_RADIUS; z = -sn * GIZMO_RADIUS; }
      else { x = c * GIZMO_RADIUS; y = sn * GIZMO_RADIUS; }
      const base = (ring * GIZMO_SEGMENTS + s) * 6;
      verts[base] = x; verts[base + 1] = y; verts[base + 2] = z;
      verts[base + 3] = colors[ring][0]; verts[base + 4] = colors[ring][1]; verts[base + 5] = colors[ring][2];
    }
  }
  return verts;
}

// ------------------------------------------------------------------ module

let gl = null;
let canvas = null;
let ready = false;
let loading = false;
let model = null; // { pos, nrm, uv, idx }
let texture = null;
let modelProg, warpProg, gizmoProg;
let modelVao, sceneFbo, sceneTex, sceneDepth;
let warpVao, warpVbo;
let gizmoVao;
let sceneW = 640, sceneH = 360;
let labelEls = null;
let statusEl = null;
let lastMapping = null;
let resizeObserver = null;

// The lightbox itself is CSS-resizable (see style.css's .preview-lightbox)
// and the canvas fills whatever space that leaves it, so its *drawing
// buffer* has to track the box's on-screen size -- otherwise it'd stay
// rendered at its initial 640x360 and just get blurrily upscaled/clipped
// by the browser as the box grows. Devicepixelratio-aware so it stays
// sharp on hi-DPI displays too.
function resizeCanvasToDisplaySize() {
  if (!canvas) return;
  const dpr = window.devicePixelRatio || 1;
  const w = Math.max(16, Math.round(canvas.clientWidth * dpr));
  const h = Math.max(16, Math.round(canvas.clientHeight * dpr));
  if (canvas.width === w && canvas.height === h) return;
  canvas.width = w;
  canvas.height = h;
  if (ready && lastMapping) requestRender(lastMapping);
}

async function ensureInit(canvasEl, labels, status) {
  canvas = canvasEl;
  labelEls = labels;
  statusEl = status;
  if (!resizeObserver && typeof ResizeObserver !== "undefined") {
    resizeObserver = new ResizeObserver(() => resizeCanvasToDisplaySize());
    resizeObserver.observe(canvas);
  }
  if (ready || loading) return;
  loading = true;
  setStatus("Loading model…");
  try {
    gl = canvas.getContext("webgl2", { antialias: true, preserveDrawingBuffer: false });
    if (!gl) throw new Error("WebGL2 unavailable in this browser");

    const [objText, img] = await Promise.all([
      fetch(MODEL_URL).then((r) => {
        if (!r.ok) throw new Error("no projection model configured");
        return r.text();
      }),
      loadImage(TEXTURE_URL),
    ]);
    model = parseObj(objText);

    modelProg = linkProgram(gl, MODEL_VS, MODEL_FS);
    warpProg = linkProgram(gl, WARP_VS, WARP_FS);
    gizmoProg = linkProgram(gl, GIZMO_VS, GIZMO_FS);

    modelVao = gl.createVertexArray();
    gl.bindVertexArray(modelVao);
    bindAttribBuffer(0, 3, model.pos);
    bindAttribBuffer(1, 3, model.nrm);
    bindAttribBuffer(2, 2, model.uv);
    const ibo = gl.createBuffer();
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ibo);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, model.idx, gl.STATIC_DRAW);

    texture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, img);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

    sceneFbo = gl.createFramebuffer();
    sceneTex = gl.createTexture();
    sceneDepth = gl.createRenderbuffer();
    resizeSceneTarget();

    warpVao = gl.createVertexArray();
    gl.bindVertexArray(warpVao);
    warpVbo = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, warpVbo);
    gl.bufferData(gl.ARRAY_BUFFER, 4 * 5 * 4, gl.DYNAMIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 5 * 4, 0);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 2, gl.FLOAT, false, 5 * 4, 3 * 4);
    const warpIbo = gl.createBuffer();
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, warpIbo);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, new Uint16Array([0, 1, 2, 0, 2, 3]), gl.STATIC_DRAW);

    gizmoVao = gl.createVertexArray();
    gl.bindVertexArray(gizmoVao);
    bindAttribBuffer6(buildGizmoRings());

    ready = true;
    setStatus(null);
  } catch (err) {
    setStatus("Preview unavailable: " + err.message);
    console.error("[calibration-preview]", err);
  } finally {
    loading = false;
  }
}

function loadImage(url) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("no loading image configured"));
    img.src = url + "?t=" + Date.now();
  });
}

function bindAttribBuffer(location, size, data) {
  const buf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
  gl.enableVertexAttribArray(location);
  gl.vertexAttribPointer(location, size, gl.FLOAT, false, 0, 0);
}
function bindAttribBuffer6(data) {
  const buf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 6 * 4, 0);
  gl.enableVertexAttribArray(1);
  gl.vertexAttribPointer(1, 3, gl.FLOAT, false, 6 * 4, 3 * 4);
}

function resizeSceneTarget() {
  sceneW = canvas.width;
  sceneH = canvas.height;
  gl.bindTexture(gl.TEXTURE_2D, sceneTex);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, sceneW, sceneH, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.bindRenderbuffer(gl.RENDERBUFFER, sceneDepth);
  gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH_COMPONENT16, sceneW, sceneH);
  gl.bindFramebuffer(gl.FRAMEBUFFER, sceneFbo);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, sceneTex, 0);
  gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, sceneDepth);
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
}

function setStatus(msg) {
  if (!statusEl) return;
  if (msg) { statusEl.textContent = msg; statusEl.classList.remove("hidden"); }
  else { statusEl.classList.add("hidden"); }
}

// Ported from projector.c's render loop: base orientation underneath the
// live calibration rotations (rotation_z applied right above it, then
// y, then x -- see that file's comment on why z has to be innermost), then
// scale, then offset. gizmoModel is the same stack minus the base
// orientation, exactly mirroring the native gizmo fix.
function buildMatrices(mapping) {
  const mBaseZ = matRotZ((BASE_ORIENTATION_Z_DEG * Math.PI) / 180);
  const mBaseX = matRotX((BASE_ORIENTATION_X_DEG * Math.PI) / 180);
  const mBase = matMul(mBaseZ, mBaseX);
  const mRx = matRotX((Number(mapping.rotation_x) * Math.PI) / 180);
  const mRy = matRotY((Number(mapping.rotation_y) * Math.PI) / 180);
  const mRz = matRotZ((Number(mapping.rotation_z) * Math.PI) / 180);
  const mS = matScale(Number(mapping.scale) || 1);
  const mT = matTranslate(Number(mapping.offset_x) || 0, Number(mapping.offset_y) || 0, 0);

  let tmp = matMul(mRz, mBase);
  tmp = matMul(mRy, tmp);
  tmp = matMul(mRx, tmp);
  tmp = matMul(mS, tmp);
  const modelM = matMul(mT, tmp);

  let gtmp = matMul(mRy, mRz);
  gtmp = matMul(mRx, gtmp);
  gtmp = matMul(mS, gtmp);
  const gizmoModel = matMul(mT, gtmp);

  const half = 1.15;
  const aspect = sceneW / sceneH;
  const proj = matOrtho(-half * aspect, half * aspect, -half, half, -100, 100);
  const mvp = matMul(proj, modelM);
  const gizmoMvp = matMul(proj, gizmoModel);
  return { modelM, mvp, gizmoMvp };
}

function setUniformMatrix4(prog, name, m) {
  gl.uniformMatrix4fv(gl.getUniformLocation(prog, name), false, m);
}

function render(mapping) {
  if (!ready || !gl) return;
  lastMapping = mapping;
  if (canvas.width !== sceneW || canvas.height !== sceneH) resizeSceneTarget();

  const { modelM, mvp, gizmoMvp } = buildMatrices(mapping);

  // ---- scene pass: model textured with the static loading image ----
  gl.bindFramebuffer(gl.FRAMEBUFFER, sceneFbo);
  gl.viewport(0, 0, sceneW, sceneH);
  gl.clearColor(0, 0, 0, 1);
  gl.enable(gl.DEPTH_TEST);
  gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
  gl.useProgram(modelProg);
  setUniformMatrix4(modelProg, "uMVP", mvp);
  setUniformMatrix4(modelProg, "uModel", modelM);
  // Unlike the native renderer, this preview always shades and always
  // shows the gizmo -- it's a calibration aid, not the real projected
  // picture, so there's no case where the relief/orientation cues showing
  // here should depend on whether "calibration shading" happens to be
  // toggled on for the actual projector right now.
  gl.uniform1i(gl.getUniformLocation(modelProg, "uShading"), 1);
  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.uniform1i(gl.getUniformLocation(modelProg, "uTex"), 0);
  gl.bindVertexArray(modelVao);
  gl.drawElements(gl.TRIANGLES, model.idx.length, gl.UNSIGNED_INT, 0);

  // ---- keystone warp pass: scene texture onto a homography-warped quad ----
  const H = quadHomography(
    -1 + Number(mapping.keystone_bl_x), -1 + Number(mapping.keystone_bl_y),
     1 + Number(mapping.keystone_br_x), -1 + Number(mapping.keystone_br_y),
     1 + Number(mapping.keystone_tr_x),  1 + Number(mapping.keystone_tr_y),
    -1 + Number(mapping.keystone_tl_x),  1 + Number(mapping.keystone_tl_y),
  );
  const corners = [[0, 0], [1, 0], [1, 1], [0, 1]];
  const warpVerts = new Float32Array(4 * 5);
  corners.forEach(([s, t], i) => {
    const [x, y, w] = homographyApply(H, s, t);
    warpVerts.set([x, y, w, s, t], i * 5);
  });

  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  gl.viewport(0, 0, canvas.width, canvas.height);
  gl.clearColor(0, 0, 0, 1);
  gl.clear(gl.COLOR_BUFFER_BIT);
  gl.disable(gl.DEPTH_TEST);
  gl.useProgram(warpProg);
  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D, sceneTex);
  gl.uniform1i(gl.getUniformLocation(warpProg, "uSceneTex"), 0);
  gl.bindVertexArray(warpVao);
  gl.bindBuffer(gl.ARRAY_BUFFER, warpVbo);
  gl.bufferSubData(gl.ARRAY_BUFFER, 0, warpVerts);
  gl.drawElements(gl.TRIANGLES, 6, gl.UNSIGNED_SHORT, 0);

  // ---- gizmo: drawn after the warp, deliberately bypassing it -- keystone
  // corrects for the projector's own off-axis mounting, which has nothing
  // to do with reading the gizmo, and warping it would turn the circles
  // into skewed ellipses. Independent of shading (which stays permanently
  // on here, unlike the native renderer -- see the uShading comment
  // above): gated on mapping.gizmo instead, same persisted mapping.json
  // field the native renderer reads, so the toggle affects both. ----
  const showGizmo = !!mapping.gizmo;
  if (showGizmo) {
    gl.useProgram(gizmoProg);
    setUniformMatrix4(gizmoProg, "uMVP", gizmoMvp);
    gl.bindVertexArray(gizmoVao);
    for (let ring = 0; ring < 3; ring++) gl.drawArrays(gl.LINE_LOOP, ring * GIZMO_SEGMENTS, GIZMO_SEGMENTS);
  }
  positionLabels(gizmoMvp, showGizmo);
}

// Labels are plain HTML overlaid on the canvas (positioned from the same
// gizmoMvp the rings use) rather than hand-drawn glyphs like the native
// renderer's -- simpler, crisper, and this preview never needs to survive
// without a DOM the way the native binary's raw-GL text does.
function positionLabels(gizmoMvp, visible) {
  if (!labelEls) return;
  const anchors = [
    { el: labelEls.x, p: [0, GIZMO_RADIUS * 1.3 * 0.7071068, GIZMO_RADIUS * 1.3 * 0.7071068] },
    { el: labelEls.y, p: [GIZMO_RADIUS * 1.3 * 0.7071068, 0, -GIZMO_RADIUS * 1.3 * 0.7071068] },
    { el: labelEls.z, p: [GIZMO_RADIUS * 1.3 * 0.7071068, GIZMO_RADIUS * 1.3 * 0.7071068, 0] },
  ];
  const cw = canvas.clientWidth || canvas.width;
  const ch = canvas.clientHeight || canvas.height;
  // Labels are positioned against the stage (canvas's offsetParent), not
  // the canvas itself, so the stage's own padding has to be folded back in
  // -- canvas.offsetLeft/Top is exactly that padding, since canvas has no
  // margin of its own.
  const ox = canvas.offsetLeft, oy = canvas.offsetTop;
  for (const { el, p } of anchors) {
    if (!visible) { el.style.opacity = "0"; continue; }
    const [ndcX, ndcY] = projectNdc(gizmoMvp, p[0], p[1], p[2]);
    el.style.left = (ox + ((ndcX + 1) / 2) * cw) + "px";
    el.style.top = (oy + ((1 - ndcY) / 2) * ch) + "px";
    el.style.opacity = "1";
  }
}

let pendingMapping = null;
let pendingRaf = null;
export function requestRender(mapping) {
  pendingMapping = mapping;
  if (pendingRaf) return;
  pendingRaf = requestAnimationFrame(() => {
    pendingRaf = null;
    if (pendingMapping) render(pendingMapping);
  });
}

export async function init(canvasEl, labels, statusEl2, mapping) {
  await ensureInit(canvasEl, labels, statusEl2);
  if (ready) requestRender(mapping);
}

export function isReady() {
  return ready;
}
