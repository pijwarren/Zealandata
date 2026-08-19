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

const POLL_MS = 300;
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

let modelMesh = null;
let upAxis = "z"; // whichever axis turns out to have the smallest extent
let videoTexture = null;

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

function buildMaterial() {
  videoTexture = new THREE.VideoTexture(videoEl);
  videoTexture.colorSpace = THREE.SRGBColorSpace;
  return new THREE.MeshBasicMaterial({ map: videoTexture, side: THREE.DoubleSide });
}

function placeMesh(geometry) {
  geometry.computeBoundingBox();
  const box = geometry.boundingBox;
  upAxis = detectUpAxis(box);
  applyPlanarUVs(geometry, box);
  const material = buildMaterial();
  modelMesh = new THREE.Mesh(geometry, material);
  // Recenter so calibration scale/rotate pivots around the model's own
  // middle, not wherever the OBJ's own origin happened to be.
  const center = new THREE.Vector3();
  box.getCenter(center);
  modelMesh.position.sub(center);
  rig.add(modelMesh);
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

function applyMapping(mapping) {
  if (!mapping) return;
  const scale = Number(mapping.scale) || 1;
  const rotationDeg = Number(mapping.rotation) || 0;
  const offsetX = Number(mapping.offset_x) || 0;
  const offsetY = Number(mapping.offset_y) || 0;
  rig.scale.setScalar(scale);
  if (upAxis === "y") {
    rig.rotation.y = THREE.MathUtils.degToRad(rotationDeg);
    rig.position.set(offsetX, 0, offsetY);
  } else {
    rig.rotation.z = THREE.MathUtils.degToRad(rotationDeg);
    rig.position.set(offsetX, offsetY, 0);
  }
}

function render() {
  requestAnimationFrame(render);
  renderer.render(scene, camera);
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
