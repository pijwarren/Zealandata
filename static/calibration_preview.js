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
// changes) rather than in a continuous rAF loop -- the one exception is the
// breathing keystone-corner marker (see render's tail end), which runs its
// own short-lived rAF loop only while a corner is actually selected.

const MODEL_URL = "/api/projection/model";
const TEXTURE_URL = "/api/loading-image";

// Mirrors projector.c's SCALE_BASELINE exactly -- see its comment.
const SCALE_BASELINE = 1.82;

// The model's own fixed 90-degree-Z/180-degree-X OBJ-axis correction is
// baked directly into the vertex data by parseObj below (mirroring
// projector.c's load_obj -- see its comment there for why this moved out
// of a per-frame matrix). The video's own separate fixed vertical-flip
// orientation correction is baked directly into MODEL_VS below instead
// (see its comment) -- ported from projector.c's VS_SRC the same way.

const GIZMO_SEGMENTS = 64;
const GIZMO_RADIUS = 0.4;

// Which corner of the unit-square UV/keystone parameterisation each named
// corner sits at (bl/br/tr/tl, matching quadHomography's own corner order).
const CORNER_ST = { bl: [0, 0], br: [1, 0], tr: [1, 1], tl: [0, 1] };
// The corner marker is drawn straight into vMarkerUV in MODEL_FS -- i.e.
// baked into the texture-sampled color itself, at a fixed point in the
// model's own raw 0..1 UV space -- rather than as a separate screen-space
// overlay computed from the keystone homography. vMarkerUV specifically,
// not vUV: vUV has the video-orientation controls (rotation/flip) baked
// in, which have nothing to do with the keystone warp's own reference
// frame and, when reused for this, measured as disagreeing with which
// corner the keystone fields actually move on the real output whenever a
// flip was in effect. Baking the marker into (the untouched) vMarkerUV
// means it rides through exactly the same model transform and keystone
// warp the keystone fields themselves are defined against, with nothing
// extra to keep in step: it never draws outside the mapped/warped picture
// by construction (vMarkerUV's domain is always exactly 0..1), not
// something a separate pass has to reason about after the fact.
// Since the chevron's arms always run from MARKER_INSET_FRAC_X/Y inward
// (see MODEL_FS), MARKER_ARM_UV growing the marker never risks pushing it
// past the picture's edge the way a symmetric shape centred on the inset
// point would.
const MARKER_INSET_FRAC_X = 0.04; // how far in from the UV edge on x, i.e. "4% in from the edges"
const MARKER_INSET_FRAC_Y = 0.08; // double MARKER_INSET_FRAC_X -- the marker sat too close to the top/bottom edge otherwise
const MARKER_PERIOD_MS = 2400; // full in-out cycle -- slow enough to read as breathing, not blinking
const MARKER_ALPHA_MIN = 0.35; // breathing dims the halo down to this, never the chevron itself -- see MODEL_FS
const MARKER_ALPHA_MAX = 1.0;
const MARKER_ARM_UV = 0.02; // length of each of the chevron's two arms; fixed, doesn't breathe

// ---------------------------------------------------------------- shaders

const MODEL_VS = `#version 300 es
layout(location=0) in vec3 aPos;
layout(location=1) in vec3 aNrm;
uniform mat4 uMVP;
uniform mat4 uModel;
// The model's own local footprint extent (X/Y -- Z is elevation, see
// parseObj), for turning aPos into a plain 0-1 UV below. Fixed for the
// life of the loaded model, not per-frame calibration state.
uniform vec2 uModelSize;
// Manual video orientation -- see server.py's MAPPING_NUMERIC/BOOLEAN
// comments on why this is plain user input rather than derived from the
// model/projector geometry. uVidRotation is radians, clockwise as seen on
// the projector.
uniform float uVidRotation;
uniform bool uVidFlipH;
uniform bool uVidFlipV;
out vec2 vUV;
// Raw model-surface UV, before uVidRotation/uVidFlipH/uVidFlipV -- for the
// keystone corner marker (see MODEL_FS's uMarkerUV comment), which needs
// to track the same untouched reference frame the keystone warp itself
// uses, not however the video content happens to be oriented.
out vec2 vMarkerUV;
out vec3 vNrm;
// Eye-space position. uModel has mEye folded into it (see
// buildMatrices), so this is already relative to the projector's own
// eye at the origin -- ported from projector.c's VS_SRC.
out vec3 vPos;
void main(){
  gl_Position = uMVP * vec4(aPos, 1.0);
  // The texture is glued to the model's own surface in its own local
  // space -- a plain top-down drape, exactly like a UV projection done
  // once in Blender against the model file itself -- rather than derived
  // from where each vertex happens to land on screen after calibration.
  // An earlier version instead sampled a clip-space position (the
  // "projective texture mapping" trick shadow/spotlight projection uses),
  // deliberately so a vertex's texture coordinate would shift with
  // elevation as the calibration sliders moved the model around -- but
  // that meant the video's own framing was never actually fixed to the
  // model, only to whatever the live camera/frustum/keystone happened to
  // be doing that frame, verified wrong against a straightforward Blender
  // UV check even at default calibration. gl_Position above already
  // carries the model through that same camera/frustum correctly; the
  // texture just needs to sit on the model's surface first, the same way
  // paint would. Ported from projector.c's VS_SRC -- see its comment.
  vec2 uv = aPos.xy / uModelSize + 0.5;
  vMarkerUV = uv;
  // Manual video orientation -- ported from projector.c's VS_SRC (see its
  // comment for why this is a live control rather than a fixed constant);
  // edit both together if the underlying transform ever needs to change.
  vec2 uvc = uv - 0.5;
  float rc = cos(uVidRotation), rs = sin(uVidRotation);
  uvc = vec2(uvc.x * rc - uvc.y * rs, uvc.x * rs + uvc.y * rc);
  uv = uvc + 0.5;
  if (uVidFlipH) uv.x = 1.0 - uv.x;
  if (uVidFlipV) uv.y = 1.0 - uv.y;
  vUV = uv;
  vNrm = mat3(uModel) * aNrm;
  vPos = (uModel * vec4(aPos, 1.0)).xyz;
}`;

const MODEL_FS = `#version 300 es
precision mediump float;
in vec2 vUV;
in vec2 vMarkerUV;
in vec3 vNrm;
in vec3 vPos;
uniform sampler2D uTex;
uniform int uShading;
// Keystone corner marker -- see CORNER_ST/MARKER_* comments in JS. Checked
// against vMarkerUV, NOT vUV -- vUV has uVidRotation/uVidFlipH/uVidFlipV
// baked in (see MODEL_VS), which orient the *video content* and have
// nothing to do with the keystone warp's own reference frame; matching
// against it made the marker disagree with which corner the keystone
// fields actually move whenever a flip was in effect. uMarkerArm <= 0.0
// means "no corner selected, don't draw it".
uniform vec2 uMarkerUV;
uniform float uMarkerArm;
uniform float uMarkerAlpha;
out vec4 oColor;
void main(){
  vec4 c = texture(uTex, vUV);
  if (uShading == 1) {
    // Square area light centred on the virtual camera, solved
    // analytically rather than by sampling the square -- ported from
    // projector.c's FS_SRC, which carries the full explanation of why
    // (sampling it measured more than twice the frame cost on the Pi,
    // and affordable sample counts banded at the terminator). Edit both
    // together: this preview only stays honest while the two match.
    const float AREA_LIGHT_HALF = 0.45;
    vec3 N = normalize(vNrm);
    float dist = max(length(vPos), 1e-4);
    float ndl = dot(N, -vPos / dist);
    float w = max(AREA_LIGHT_HALF / dist, 1e-4);
    float d = (ndl >= w) ? ndl
            : ((ndl <= -w) ? 0.0 : (ndl + w) * (ndl + w) / (4.0 * w));
    c.rgb *= (0.2 + 1.1 * d);
  }
  // Blended in after shading (so it always reads full-brightness white,
  // never dimmed by the area light above), straight onto the texture-
  // sampled color -- see uMarkerUV's comment for why this rides through
  // the model transform and keystone warp for free instead of needing its
  // own pass.
  if (uMarkerArm > 0.0) {
    // The model's raw UV space isn't square, so an x/y-symmetric shape
    // came out visibly stretched on the actual print/mirror. Shrinking the
    // y half of the offset before it's used for anything below
    // un-stretches it -- ported line-for-line into projector.c's FS_SRC,
    // keep the two in sync.
    const float MARKER_ASPECT_Y = 2.0;
    vec2 delta = vMarkerUV - uMarkerUV;
    delta.y /= MARKER_ASPECT_Y;
    // A right-angle chevron: two arms, each a straight line segment
    // running from the marker position (the tip, i.e. delta's origin) out
    // to length uMarkerArm, one horizontal and one vertical -- so together
    // they trace the two picture edges that meet at the selected corner.
    // The tip sits at uMarkerUV, same inset-from-the-corner position the
    // marker always used, and each arm runs inward from there -- away from
    // its own nearest edge -- so the shape only ever grows toward the
    // picture's interior and can't bleed off either edge near the corner.
    // Which way each arm runs falls out of which side of the picture
    // uMarkerUV is already on (its raw, un-inset x/y each land either side
    // of 0.5), so there's no need for a separate per-corner uniform just
    // to carry that.
    float armDirX = uMarkerUV.x < 0.5 ? 1.0 : -1.0;
    float armDirY = uMarkerUV.y < 0.5 ? 1.0 : -1.0;
    vec2 armX = vec2(armDirX * uMarkerArm, 0.0);
    vec2 armY = vec2(0.0, armDirY * uMarkerArm);
    float hx = clamp(dot(delta, armX) / dot(armX, armX), 0.0, 1.0);
    float hy = clamp(dot(delta, armY) / dot(armY, armY), 0.0, 1.0);
    float distArm = min(length(delta - armX * hx), length(delta - armY * hy));
    // Same hard-edge-plus-slight-halo treatment the old disk used, just
    // measured against distArm (distance to the nearer arm) instead of
    // distance to a center point. MARKER_THICKNESS_FRAC is the stroke's
    // own half-width, as a fraction of the arm length; MARKER_GLOW_FRAC is
    // how far past that edge the halo bleeds, same as before.
    const float MARKER_THICKNESS_FRAC = 0.25;
    const float MARKER_GLOW_FRAC = 0.25;
    float d = distArm / (uMarkerArm * MARKER_THICKNESS_FRAC);
    if (d < 1.0 + MARKER_GLOW_FRAC) {
      float stroke = 1.0 - smoothstep(0.9, 1.0, d);
      float halo = smoothstep(1.0 + MARKER_GLOW_FRAC, 1.0, d) * 0.5;
      // uMarkerAlpha (the breathing pulse) only scales the halo now -- the
      // chevron itself stays a steady, fully-opaque marker of exactly
      // where the corner is, and only the glow around it pulses.
      float g = max(stroke, halo * uMarkerAlpha);
      c.rgb = mix(c.rgb, vec3(1.0), g);
    }
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
// Standard OpenGL perspective frustum (l,r,b,t given at the near plane).
// Ported from projector.c's mat_frustum -- see its comment for why this
// replaced an orthographic projection here too.
// Parallel projection for the calibration gizmo only -- ported from
// projector.c's mat_ortho, which carries the reasoning: perspective turns
// the gizmo's rings into eccentric ellipses that read as a rotation the
// model hasn't got.
function matOrtho(l, r, b, t, n, f) {
  const m = new Float32Array(16);
  m[0] = 2 / (r - l);
  m[5] = 2 / (t - b);
  m[10] = -2 / (f - n);
  m[12] = -(r + l) / (r - l);
  m[13] = -(t + b) / (t - b);
  m[14] = -(f + n) / (f - n);
  m[15] = 1;
  return m;
}
function matFrustum(l, r, b, t, n, f) {
  const m = new Float32Array(16);
  m[0] = 2 * n / (r - l);
  m[5] = 2 * n / (t - b);
  m[8] = (r + l) / (r - l);
  m[9] = (t + b) / (t - b);
  m[10] = -(f + n) / (f - n);
  m[11] = -1;
  m[14] = -(2 * f * n) / (f - n);
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
// same up-axis heuristic and remap, and the same area-weighted smooth
// normals. INVERT_RELIEF is left out entirely since the native renderer's
// own INVERT_RELIEF is false. No per-vertex UV here any more -- see
// MODEL_VS's comment on why that's now derived from the live clip-space
// position instead.

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

  // This particular OBJ export's raw axes need a further fixed 90-degree
  // Z then 180-degree X turn on top of the up-axis remap above, matching
  // projector.c's load_obj exactly (see its comment there for the full
  // reasoning) -- equivalent to rot_z(90) * rot_x(180) applied to each
  // vertex, worked out as (x,y,z) -> (y,x,-z).
  for (let i = 0; i < nvert; i++) {
    const x = pos[i * 3], y = pos[i * 3 + 1], z = pos[i * 3 + 2];
    pos[i * 3] = y;
    pos[i * 3 + 1] = x;
    pos[i * 3 + 2] = -z;
  }
  { const t = sizeX; sizeX = sizeY; sizeY = t; }

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

  return { pos, nrm, idx, sizeX, sizeY, sizeZ };
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
let model = null; // { pos, nrm, idx }
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

// The canvas is sized by CSS (it fills its page's stage), so its *drawing
// buffer* has to track whatever on-screen size that works out to --
// otherwise it'd stay rendered at its initial size and just get blurrily
// upscaled or clipped by the browser as the window resizes.
// Devicepixelratio-aware so it stays sharp on hi-DPI displays too.
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

// Ported from projector.c's render loop: rotation_z applied innermost,
// then y, then x -- see that file's comment on why z has to be innermost --
// then scale, then offset.
function buildMatrices(mapping) {
  // No base-orientation matrix here -- the model's fixed OBJ-axis quirk is
  // baked into the parsed vertex data now (see parseObj), matching
  // projector.c's load_obj.
  const mRx = matRotX((Number(mapping.rotation_x) * Math.PI) / 180);
  const mRy = matRotY((Number(mapping.rotation_y) * Math.PI) / 180);
  const mRz = matRotZ((Number(mapping.rotation_z) * Math.PI) / 180);
  const mS = matScale((Number(mapping.scale) || 1) * SCALE_BASELINE);
  const mT = matTranslate(Number(mapping.offset_x) || 0, Number(mapping.offset_y) || 0, 0);

  let tmp = matMul(mRy, mRz);
  tmp = matMul(mRx, tmp);
  tmp = matMul(mS, tmp);
  const modelM = matMul(mT, tmp);

  const half = 1.15;
  const aspect = sceneW / sceneH;
  // Point-source perspective, not parallel "sunlight" -- see projector.c's
  // matching render-loop comment for why. near/far and the (near/throwDist)
  // scaling keep this identical in framing to the old ortho as throwDist
  // grows large, so it's a no-op until actually dialled in.
  const throwDist = Math.max(0.3, Number(mapping.throw_distance) || 0.6);
  const near = 0.05, far = throwDist + 20;
  const halfY = half;
  const halfX = half * aspect;
  const ratio = near / throwDist;
  // Lateral projector position needs BOTH halves of a proper off-axis
  // ("lens-shift") projection together -- see projector.c's matching
  // render-loop comment for the full derivation of why either alone
  // reproduces the same "shifts instead of shearing" symptom.
  const throwOffX = Number(mapping.throw_offset_x) || 0;
  const throwOffY = Number(mapping.throw_offset_y) || 0;
  const proj = matFrustum(
    ratio * (-halfX - throwOffX), ratio * (halfX - throwOffX),
    ratio * (-halfY - throwOffY), ratio * (halfY - throwOffY),
    near, far,
  );
  const mEye = matTranslate(-throwOffX, -throwOffY, -throwDist);
  const modelEye = matMul(mEye, modelM);
  const mvp = matMul(proj, modelEye);
  // Same model/eye matrix, projected in parallel over the bounds the
  // frustum spans at the model's reference depth -- so the gizmo lands
  // where it always did, just unskewed. Ported from projector.c.
  const gizmoProj = matOrtho(
    -halfX - throwOffX, halfX - throwOffX,
    -halfY - throwOffY, halfY - throwOffY,
    near, far,
  );
  const gizmoMvp = matMul(gizmoProj, modelEye);

  return { modelM: modelEye, mvp, gizmoMvp };
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
  gl.uniform2f(gl.getUniformLocation(modelProg, "uModelSize"), model.sizeX, model.sizeY);
  gl.uniform1f(
    gl.getUniformLocation(modelProg, "uVidRotation"),
    ((Number(mapping.video_rotation) || 0) * Math.PI) / 180,
  );
  gl.uniform1i(gl.getUniformLocation(modelProg, "uVidFlipH"), mapping.video_flip_h ? 1 : 0);
  gl.uniform1i(gl.getUniformLocation(modelProg, "uVidFlipV"), mapping.video_flip_v ? 1 : 0);
  // Unlike the native renderer, this preview always shades and always
  // shows the gizmo -- it's a calibration aid, not the real projected
  // picture, so there's no case where the relief/orientation cues showing
  // here should depend on whether "calibration shading" happens to be
  // toggled on for the actual projector right now.
  gl.uniform1i(gl.getUniformLocation(modelProg, "uShading"), 1);
  // Keystone corner marker -- see CORNER_ST/MARKER_* comments above and
  // MODEL_FS's own comment: baked straight into the texture-sampled color
  // at a fixed point in the model's own UV space, so it's carried through
  // this same draw call rather than needing a separate pass afterward.
  const cornerSt = CORNER_ST[mapping.keystone_corner];
  if (cornerSt) {
    const u = cornerSt[0] === 0 ? MARKER_INSET_FRAC_X : 1 - MARKER_INSET_FRAC_X;
    const v = cornerSt[1] === 0 ? MARKER_INSET_FRAC_Y : 1 - MARKER_INSET_FRAC_Y;
    const phase = (performance.now() % MARKER_PERIOD_MS) / MARKER_PERIOD_MS;
    const breathe = 0.5 - 0.5 * Math.cos(phase * Math.PI * 2); // eases 0 -> 1 -> 0
    gl.uniform2f(gl.getUniformLocation(modelProg, "uMarkerUV"), u, v);
    gl.uniform1f(gl.getUniformLocation(modelProg, "uMarkerArm"), MARKER_ARM_UV);
    gl.uniform1f(
      gl.getUniformLocation(modelProg, "uMarkerAlpha"),
      MARKER_ALPHA_MIN + (MARKER_ALPHA_MAX - MARKER_ALPHA_MIN) * breathe,
    );
  } else {
    gl.uniform1f(gl.getUniformLocation(modelProg, "uMarkerArm"), -1);
  }
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
  // field the native renderer reads, so the toggle affects both. Uses the
  // its own orthographic mvp (see buildMatrices) -- now that the model's fixed OBJ-axis
  // quirk is baked into the vertex data rather than a separate runtime
  // matrix (see parseObj), there's no longer a second "mBase-free"
  // transform for the rings to need. ----
  const showGizmo = !!mapping.gizmo;
  if (showGizmo) {
    gl.useProgram(gizmoProg);
    setUniformMatrix4(gizmoProg, "uMVP", gizmoMvp);
    gl.bindVertexArray(gizmoVao);
    for (let ring = 0; ring < 3; ring++) gl.drawArrays(gl.LINE_LOOP, ring * GIZMO_SEGMENTS, GIZMO_SEGMENTS);
  }
  positionLabels(gizmoMvp, showGizmo);

  // The breathing pulse needs to keep animating even while nothing about
  // the mapping itself is changing, which is the one case this module's
  // otherwise-on-demand rendering (see requestRender) doesn't cover on its
  // own -- so run a rAF loop for exactly as long as a corner is actually
  // selected, and no longer.
  if (cornerSt && !pulseRaf) {
    pulseRaf = requestAnimationFrame(pulseTick);
  } else if (!cornerSt && pulseRaf) {
    cancelAnimationFrame(pulseRaf);
    pulseRaf = null;
  }
}

let pulseRaf = null;
function pulseTick() {
  pulseRaf = requestAnimationFrame(pulseTick);
  if (lastMapping) render(lastMapping);
}

// Labels are plain HTML overlaid on the canvas (positioned from the same
// mvp the rings use) rather than hand-drawn glyphs like the native
// renderer's -- simpler, crisper, and this preview never needs to survive
// without a DOM the way the native binary's raw-GL text does.
function positionLabels(mvp, visible) {
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
    const [ndcX, ndcY] = projectNdc(mvp, p[0], p[1], p[2]);
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
