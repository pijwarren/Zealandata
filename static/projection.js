/*
 * Renders whatever's currently selected/screensaving, texture-mapped onto
 * the calibrated 3D model, as the actual HDMI output for RENDER_BACKEND
 * =webgl (see server.py's module docstring). This page owns no playback
 * decisions itself -- the server's existing screensaver/spinner/idle state
 * machine (unchanged from the mpv backend) decides what should be showing
 * next and writes it to /api/projection/state; this page just polls that,
 * drives a <video> element accordingly, and reports position/pause/ended
 * state back via /api/projection/heartbeat so the server can track
 * progress and detect "this pick finished" exactly like it does by polling
 * mpv's IPC socket in the other backend.
 */
import * as THREE from "/static/vendor/three/three.module.js";
import { OBJLoader } from "/static/vendor/three/loaders/OBJLoader.js";
import { mergeVertices } from "/static/vendor/three/utils/BufferGeometryUtils.js";

// Also the calibration update rate: mapping changes only reach the
// projector on a poll, so at 300ms dragging a slider stepped about three
// times a second and read as choppy no matter how fast the render loop
// was going. The payloads are tiny and the client is on the same box.
const POLL_MS = 100;
const HEARTBEAT_MS = 250;

const canvas = document.getElementById("scene");
const idleImg = document.getElementById("idleImg");
const videoEl = document.getElementById("sourceVideo");

const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(window.devicePixelRatio || 1);
renderer.setSize(window.innerWidth, window.innerHeight);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x000000);

const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.01, 100);

// Everything calibration touches (scale/rotate/offset) hangs off this
// group rather than the mesh or the camera directly, so the mesh's own
// local geometry/UVs never need to change after load.
const rig = new THREE.Group();
scene.add(rig);

// The model's own resting orientation, applied inside the rig so it sits
// *underneath* the calibration rotations rather than competing with them:
// this is what "all sliders at 0" looks like. The OBJ as exported lands
// 90 degrees off from how the physical print actually faces the
// projector, so baking that in here means calibration starts from the
// right orientation instead of everyone having to dial the same 90 back
// in by hand every time it's reset.
const BASE_ORIENTATION_Y_DEG = 90;

// The OBJ's relief comes through inverted (peaks sunken, hollows raised),
// so its height axis is mirrored at load -- see mirrorAlongUpAxis. Baked
// in rather than exposed as a control for the same reason as the base
// orientation above: it's a fixed property of this model file, not
// something that varies with where the projector happens to be.
const INVERT_RELIEF = true;
const baseOrient = new THREE.Group();
baseOrient.rotation.y = THREE.MathUtils.degToRad(BASE_ORIENTATION_Y_DEG);
rig.add(baseOrient);

let modelMesh = null;
let upAxis = "z"; // whichever axis turns out to have the smallest extent
let videoTexture = null;
let flatMaterial = null;
let shadedMaterial = null;
let appliedRenderScale = 1;
let modelVertexCount = null;

// Only ever lights the Lambert (calibration) material -- the unlit
// projection material ignores them entirely, so these can just stay in
// the scene rather than being added/removed as the toggle flips.
// Deliberately oblique rather than straight down the camera axis: a light
// parallel to the view direction flattens relief out again, which is the
// exact problem the toggle exists to solve.
const calibrationKeyLight = new THREE.DirectionalLight(0xffffff, 2.2);
calibrationKeyLight.position.set(-1, 1.6, 1);
scene.add(calibrationKeyLight);
scene.add(new THREE.AmbientLight(0xffffff, 0.55));

function fitOrthoCamera(box) {
  const size = new THREE.Vector3();
  box.getSize(size);
  const center = new THREE.Vector3();
  box.getCenter(center);
  const pad = 1.15;
  const aspect = window.innerWidth / window.innerHeight;

  let halfW, halfH;
  if (upAxis === "y") {
    halfW = (Math.max(size.x, size.z * aspect) / 2) * pad;
    halfH = halfW / aspect;
    camera.position.set(center.x, center.y + Math.max(size.x, size.y, size.z) * 2, center.z);
    camera.up.set(0, 0, -1);
  } else {
    halfW = (Math.max(size.x, size.y * aspect) / 2) * pad;
    halfH = halfW / aspect;
    camera.position.set(center.x, center.y, center.z + Math.max(size.x, size.y, size.z) * 2);
    camera.up.set(0, 1, 0);
  }
  camera.left = -halfW;
  camera.right = halfW;
  camera.top = halfH;
  camera.bottom = -halfH;
  camera.lookAt(center);
  camera.near = 0.01;
  camera.far = Math.max(size.x, size.y, size.z) * 10 + 10;
  camera.updateProjectionMatrix();
}

// Mirroring a mesh reverses the winding order of every triangle, which
// would otherwise leave every face pointing the wrong way -- invisible
// with a DoubleSide material, but it inverts the normals, so calibration
// shading would light the relief exactly backwards (peaks reading as
// hollows). Swapping two corners of each triangle puts the winding back.
function reverseWinding(geometry) {
  const index = geometry.getIndex();
  if (index) {
    const arr = index.array;
    for (let i = 0; i < arr.length; i += 3) {
      const tmp = arr[i + 1];
      arr[i + 1] = arr[i + 2];
      arr[i + 2] = tmp;
    }
    index.needsUpdate = true;
    return;
  }
  // Non-indexed (what OBJLoader normally produces): swap the 2nd and 3rd
  // vertex of every triangle across each attribute in lockstep.
  for (const attribute of Object.values(geometry.attributes)) {
    const { array, itemSize } = attribute;
    for (let i = 0; i < array.length; i += itemSize * 3) {
      for (let k = 0; k < itemSize; k++) {
        const a = i + itemSize + k;
        const b = i + itemSize * 2 + k;
        const tmp = array[a];
        array[a] = array[b];
        array[b] = tmp;
      }
    }
    attribute.needsUpdate = true;
  }
}

// The print's relief comes out of the OBJ inverted -- what should stand
// proud sits sunken instead -- so mirror the model's height axis (leaving
// its footprint untouched, unlike a 180-degree flip, which would also
// swap the model end-for-end).
function mirrorAlongUpAxis(geometry, axis) {
  if (axis === "y") geometry.scale(1, -1, 1);
  else if (axis === "z") geometry.scale(1, 1, -1);
  else geometry.scale(-1, 1, 1);
  reverseWinding(geometry);
  // Normals deliberately not computed here -- placeMesh does it once,
  // after the UVs are in place, so a 100k-vertex mesh isn't walked twice
  // at load for no benefit.
}

// How the video needs turning to land the right way up on the print.
// Rotation is clockwise, in degrees, as seen on the projector; the flip
// mirrors top and bottom (i.e. across the horizontal axis) and is applied
// after the rotation.
const VIDEO_ROTATION_CW_DEG = 270;
const VIDEO_FLIP_ACROSS_HORIZONTAL = true;

// Turns a UV coordinate into the one to actually sample. Note this is the
// *inverse* of the transform being described: to make the displayed image
// turn clockwise the sample coordinates have to turn counter-clockwise,
// and an inverse composition applies its steps in reverse order -- hence
// the flip landing before the rotation here even though it's described
// (and applied on screen) after it.
function orientUV(u, v) {
  if (VIDEO_FLIP_ACROSS_HORIZONTAL) v = 1 - v;
  switch (((VIDEO_ROTATION_CW_DEG % 360) + 360) % 360) {
    case 90:
      [u, v] = [1 - v, u];
      break;
    case 180:
      [u, v] = [1 - u, 1 - v];
      break;
    case 270:
      [u, v] = [v, 1 - u];
      break;
  }
  return [u, v];
}

// Projects the video onto the mesh top-down (like sunlight) using its
// world-footprint position, not whatever UVs the OBJ export happened to
// carry (raw scan/print exports often have none, or ones meant for a
// physical texture, not a video projected from directly above).
function applyPlanarUVs(geometry, box) {
  const pos = geometry.attributes.position;
  const uv = new Float32Array(pos.count * 2);
  const size = new THREE.Vector3();
  box.getSize(size);
  const min = box.min;
  for (let i = 0; i < pos.count; i++) {
    let u, v;
    if (upAxis === "y") {
      u = size.x > 0 ? (pos.getX(i) - min.x) / size.x : 0.5;
      v = size.z > 0 ? (pos.getZ(i) - min.z) / size.z : 0.5;
    } else {
      u = size.x > 0 ? (pos.getX(i) - min.x) / size.x : 0.5;
      v = size.y > 0 ? (pos.getY(i) - min.y) / size.y : 0.5;
    }
    [u, v] = orientUV(u, v);
    uv[i * 2] = u;
    uv[i * 2 + 1] = v;
  }
  geometry.setAttribute("uv", new THREE.BufferAttribute(uv, 2));
}

function detectUpAxis(box) {
  const size = new THREE.Vector3();
  box.getSize(size);
  if (size.y <= size.x && size.y <= size.z) return "y";
  if (size.z <= size.x && size.z <= size.y) return "z";
  return "y";
}

// Two materials over the same video texture, swapped by the calibration
// shading toggle. Unlit (basic) is the real projection material -- adding
// fake light to what's projected onto a physical object fights the
// object's own real shading. Lambert exists purely so relief is readable
// on screen while lining the model up.
function buildMaterials() {
  videoTexture = new THREE.VideoTexture(videoEl);
  videoTexture.colorSpace = THREE.SRGBColorSpace;
  flatMaterial = new THREE.MeshBasicMaterial({ map: videoTexture, side: THREE.DoubleSide });
  shadedMaterial = new THREE.MeshLambertMaterial({ map: videoTexture, side: THREE.DoubleSide });
  return flatMaterial;
}

// OBJLoader hands back non-indexed geometry -- every triangle carries its
// own three vertices, so a 210k-face model is drawn as ~632k vertices
// even though it only has ~106k distinct ones. Once the render scale
// stopped the GPU being fill-rate bound, that redundant vertex work
// became the next ceiling, so the mesh is indexed here before anything
// else touches it.
//
// Normals and UVs are dropped first on purpose: mergeVertices only
// collapses vertices whose attributes all match, and the per-face normals
// OBJLoader (or computeVertexNormals on non-indexed geometry) produces
// differ between adjacent triangles -- leaving them in place would block
// almost every merge. Both are regenerated below, from the indexed mesh.
function indexGeometry(geometry) {
  geometry.deleteAttribute("normal");
  geometry.deleteAttribute("uv");
  const merged = mergeVertices(geometry);
  if (merged !== geometry) geometry.dispose();
  return merged;
}

function placeMesh(inputGeometry) {
  const geometry = indexGeometry(inputGeometry);
  modelVertexCount = geometry.attributes.position.count;
  geometry.computeBoundingBox();
  upAxis = detectUpAxis(geometry.boundingBox);
  if (INVERT_RELIEF) {
    mirrorAlongUpAxis(geometry, upAxis);
    geometry.computeBoundingBox(); // the mirrored axis' min/max just swapped
  }
  const box = geometry.boundingBox;
  applyPlanarUVs(geometry, box);
  const material = buildMaterials();
  // Lambert shading needs normals, and they have to be built after the
  // merge above -- computing them earlier is what would have prevented it.
  // On indexed geometry this also gives smooth normals across shared
  // edges rather than faceted ones, which reads better on relief.
  geometry.computeVertexNormals();
  modelMesh = new THREE.Mesh(geometry, material);
  // Recenter so calibration scale/rotate pivots around the model's own
  // middle, not wherever the OBJ's own origin happened to be.
  const center = new THREE.Vector3();
  box.getCenter(center);
  modelMesh.position.sub(center);
  baseOrient.add(modelMesh);
  // Measured after baseOrient is applied, so the camera frames the model
  // as it actually rests rather than as the OBJ happened to be exported.
  baseOrient.updateWorldMatrix(true, true);
  const worldBox = new THREE.Box3().setFromObject(modelMesh);
  fitOrthoCamera(worldBox);
}

function buildFallbackPlane() {
  const geometry = new THREE.PlaneGeometry(2, 1.2, 1, 1);
  geometry.rotateX(-Math.PI / 2); // lie flat, y-up
  placeMesh(geometry);
}

async function loadModel() {
  try {
    const res = await fetch("/api/projection/model");
    if (!res.ok) throw new Error("no model");
    const text = await res.text();
    const obj = new OBJLoader().parse(text);
    const merged = new THREE.Group();
    let geometry = null;
    obj.traverse((child) => {
      if (child.isMesh && !geometry) geometry = child.geometry;
    });
    if (!geometry) throw new Error("model has no mesh geometry");
    placeMesh(geometry);
  } catch (err) {
    console.warn("[projection] falling back to a placeholder plane:", err.message);
    buildFallbackPlane();
  }
}

function applyRenderScale(requested) {
  // Clamped rather than trusted: 0 would produce a zero-sized drawing
  // buffer (a black screen with no obvious cause), and anything above 1
  // supersamples, which is the opposite of what this knob is for.
  const next = Math.min(Math.max(Number(requested) || 1, 0.25), 1);
  if (next === appliedRenderScale) return;
  appliedRenderScale = next;
  renderer.setPixelRatio((window.devicePixelRatio || 1) * next);
  renderer.setSize(window.innerWidth, window.innerHeight);
}

function applyMapping(mapping) {
  if (!mapping) return;
  applyRenderScale(mapping.render_scale);
  const scale = Number(mapping.scale) || 1;
  const rotX = Number(mapping.rotation_x) || 0;
  const rotY = Number(mapping.rotation_y) || 0;
  const rotZ = Number(mapping.rotation_z) || 0;
  const offsetX = Number(mapping.offset_x) || 0;
  const offsetY = Number(mapping.offset_y) || 0;
  rig.scale.setScalar(scale);
  // Independent per-axis rotation (not just spin around the detected
  // up-axis) -- needed to correct for a projector that isn't perfectly
  // perpendicular to the model, not just to turn it. Offset stays in the
  // rig's parent (world) space, so it shifts the whole projected image
  // regardless of how the model itself is currently rotated.
  rig.rotation.set(
    THREE.MathUtils.degToRad(rotX),
    THREE.MathUtils.degToRad(rotY),
    THREE.MathUtils.degToRad(rotZ)
  );
  if (upAxis === "y") {
    rig.position.set(offsetX, 0, offsetY);
  } else {
    rig.position.set(offsetX, offsetY, 0);
  }

  if (modelMesh) {
    const wantShaded = !!mapping.shading;
    const nextMaterial = wantShaded ? shadedMaterial : flatMaterial;
    if (nextMaterial && modelMesh.material !== nextMaterial) {
      modelMesh.material = nextMaterial;
    }
  }
}

// Rolling render rate, reported in the heartbeat. Worth having
// permanently rather than only while chasing a specific problem: this
// page is the HDMI output on a headless box, so there's otherwise no way
// to tell a slow render apart from slow playback without plugging in a
// keyboard and opening devtools on the projector.
let renderedFrames = 0;
let fpsWindowStart = performance.now();
let measuredFps = null;

function render() {
  requestAnimationFrame(render);
  renderer.render(scene, camera);
  renderedFrames++;
  const now = performance.now();
  const elapsed = now - fpsWindowStart;
  if (elapsed >= 1000) {
    measuredFps = Math.round((renderedFrames * 1000) / elapsed);
    renderedFrames = 0;
    fpsWindowStart = now;
  }
}

window.addEventListener("resize", () => {
  renderer.setSize(window.innerWidth, window.innerHeight);
  if (modelMesh) fitOrthoCamera(new THREE.Box3().setFromObject(modelMesh));
});

// --------------------------------------------------- playback state sync ---

let lastLoadSeq = null;
let lastCommandSeq = 0;
let lastAckSeq = 0;
let localIdleActive = true;
let currentFps = 12;

function fullVideoUrl(path) {
  if (!path) return null;
  return path.startsWith("http") ? path : `${window.location.origin}${path}`;
}

async function applyState(state) {
  applyMapping(state.mapping);
  currentFps = state.fps || currentFps;

  const showImage = !!state.is_image;
  idleImg.classList.toggle("hidden", !showImage);
  canvas.classList.toggle("hidden", showImage);

  if (state.load_seq !== lastLoadSeq) {
    lastLoadSeq = state.load_seq;
    localIdleActive = false;
    const url = fullVideoUrl(state.path);
    if (showImage) {
      if (url) idleImg.src = url;
    } else if (url) {
      videoEl.pause();
      videoEl.src = url;
      videoEl.loop = !!state.loop;
      videoEl.muted = !!state.mute;
      videoEl.currentTime = state.start || 0;
      videoEl.play().catch(() => {});
    } else {
      videoEl.pause();
      videoEl.removeAttribute("src");
      videoEl.load();
      localIdleActive = true;
    }
  }

  if (state.command && state.command.seq > lastCommandSeq) {
    lastCommandSeq = state.command.seq;
    executeCommand(state.command);
    lastAckSeq = state.command.seq;
  }
}

function executeCommand(command) {
  switch (command.action) {
    case "toggle_pause":
      if (videoEl.paused) videoEl.play().catch(() => {});
      else videoEl.pause();
      break;
    case "stop":
      videoEl.pause();
      videoEl.removeAttribute("src");
      videoEl.load();
      localIdleActive = true;
      break;
    case "seek":
      if (typeof command.value === "number") videoEl.currentTime = command.value;
      break;
    case "frame_step":
      videoEl.pause();
      videoEl.currentTime += 1 / currentFps;
      break;
    case "frame_back_step":
      videoEl.pause();
      videoEl.currentTime = Math.max(0, videoEl.currentTime - 1 / currentFps);
      break;
    case "toggle_loop":
      videoEl.loop = !videoEl.loop;
      break;
    case "volume":
      videoEl.volume = Math.min(1, Math.max(0, videoEl.volume + command.value / 100));
      break;
  }
}

videoEl.addEventListener("ended", () => {
  // keep_open="yes" (a deliberate selection) pauses on the last frame
  // rather than going idle -- mirrors mpv's own keep-open property.
  if (videoEl.dataset.keepOpen === "no") {
    localIdleActive = true;
  }
});

let stateInitialized = false;

async function pollState() {
  try {
    const res = await fetch("/api/projection/state");
    const state = await res.json();
    if (!stateInitialized) {
      // A command already sitting in server state at page-load time (e.g.
      // whatever was last issued before a kiosk browser reload/crash) is
      // history, not a new instruction -- there's no IPC socket here to
      // "just not have missed it" the way a fresh mpv connection wouldn't
      // replay old commands either, so skip straight to whatever's current
      // rather than re-executing it against freshly-loaded content.
      lastCommandSeq = state.command_seq || 0;
      lastAckSeq = lastCommandSeq;
      stateInitialized = true;
    }
    videoEl.dataset.keepOpen = state.keep_open || "yes";
    await applyState(state);
  } catch (err) {
    console.warn("[projection] state poll failed:", err);
  } finally {
    setTimeout(pollState, POLL_MS);
  }
}

async function sendHeartbeat() {
  const fps = currentFps || 12;
  const body = {
    load_seq: lastLoadSeq,
    position: videoEl.currentTime || 0,
    duration: videoEl.duration || null,
    paused: videoEl.paused,
    idle_active: localIdleActive,
    looping: videoEl.loop,
    frame_number: Math.round((videoEl.currentTime || 0) * fps),
    ack_seq: lastAckSeq,
    renderer_fps: measuredFps,
    model_vertices: modelVertexCount,
  };
  try {
    await fetch("/api/projection/heartbeat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch (err) {
    // Pi's kiosk browser and the Flask server are on the same host, so this
    // should basically never happen -- if it does, the next tick tries again.
  }
  setTimeout(sendHeartbeat, HEARTBEAT_MS);
}

loadModel().then(() => {
  render();
  pollState();
  sendHeartbeat();
});
