/*
 * Zealandata projector
 * ====================
 * Owns the HDMI output directly and draws the current video texture-mapped
 * onto the 3D-printed model, for projection mapping onto the physical print.
 *
 * This replaces the earlier approach of running the same scene as WebGL in a
 * Chromium kiosk. That worked, but measured ~11fps at 1080p on a Pi 4 against
 * a 30fps source, while the identical mesh and texture load drawn natively
 * measures ~71fps -- the gap was almost entirely browser overhead rather than
 * the GPU, which is what justifies the native path.
 *
 * Display  : DRM/KMS + GBM + EGL + GLES3, the same route mpv's --vo=gpu
 *            --gpu-context=drm takes. No compositor involved.
 * Video    : GStreamer's v4l2h264dec decodes on the Pi's V4L2 H.264 hardware
 *            block straight into a DMA-BUF, imported as a GL texture we
 *            sample directly -- no libmpv, no CPU copy. This replaces an
 *            earlier libmpv render-API path that measured ~20-23fps because
 *            this build's mpv/ffmpeg had no working hwdec route to the same
 *            decoder (see git history for that investigation).
 * Control  : a small IPC socket server here speaks a compatible subset of
 *            mpv's own JSON-line protocol (get_property/set_property/
 *            loadfile/seek/cycle/...), so server.py drives this exactly as
 *            it drove a standalone mpv -- screensaver, resume and progress
 *            all keep working untouched. Run the server with
 *            ZEALANDATA_MPV_EXTERNAL=1 so it talks to this socket instead of
 *            spawning an mpv of its own.
 * Calibration: mapping.json is polled and applied live, matching the admin
 *            panel's sliders.
 */
#define _GNU_SOURCE
#define GST_USE_UNSTABLE_API
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <strings.h>
#include <stdbool.h>
#include <math.h>
#include <time.h>
#include <errno.h>
#include <fcntl.h>
#include <unistd.h>
#include <signal.h>
#include <pthread.h>
#include <sys/stat.h>
#include <sys/socket.h>
#include <sys/un.h>

#include <xf86drm.h>
#include <xf86drmMode.h>
#include <gbm.h>
#include <EGL/egl.h>
#include <EGL/eglext.h>
#include <GLES3/gl3.h>

#include <gst/gst.h>
#include <gst/app/gstappsink.h>
#include <gst/video/video.h>
#include <gst/gl/gl.h>
#include <gst/gl/egl/gstgldisplay_egl.h>

#define CHECK(cond, msg) do { if (!(cond)) { fprintf(stderr, "fatal: %s (%s)\n", msg, strerror(errno)); exit(1); } } while (0)

static volatile sig_atomic_t running = 1;
static void on_signal(int s) { (void)s; running = 0; }

static double now_sec(void) {
    struct timespec ts;
    clock_gettime(CLOCK_MONOTONIC, &ts);
    return ts.tv_sec + ts.tv_nsec / 1e9;
}

/* ================================================== calibration state === */

/* Mirrors mapping.json, which the admin panel writes. Defaults match
   DEFAULT_MAPPING in server.py so a missing file behaves identically to a
   freshly-reset one. */
/* The "scale" calibration value is a multiplier on top of this, not an
   absolute size -- so the slider reads as "1.0 = however the model was
   last actually sized against the physical print", not some arbitrary
   fixed unit. Recalibrated 2026-09-09 against the physical setup at the
   time (scale=1.82) so operators nudge from a round 1.0 instead of that
   number; if the model or print changes enough that even that no longer
   reads as roughly right, fold whatever "scale" ends up at back into this
   constant and reset the mapping value to 1.0 again. */
static const float SCALE_BASELINE = 1.82f;

struct mapping {
    float scale, rot_x, rot_y, rot_z, off_x, off_y, render_scale;
    /* Distance from the model to the virtual projector -- see server.py's
       MAPPING_NUMERIC comment on "throw_distance" for why a real point-
       source projector needs this at all, where the old purely-orthographic
       render didn't. Large values approximate that old behaviour. */
    float throw_dist;
    /* Lateral projector position -- see server.py's MAPPING_NUMERIC
       comment on "throw_offset_x/y" for why this is separate from
       off_x/off_y above despite ending up composed with them. */
    float throw_off_x, throw_off_y;
    bool shading;
    /* Independent of shading -- either can be toggled without the other,
       matching server.py's MAPPING_BOOLEAN. */
    bool gizmo;
    /* On-screen frame-rate readout, toggled from the admin panel. Also
       independent of the two above -- see server.py's MAPPING_BOOLEAN. */
    bool fps_overlay;
    /* Keystone: how far each corner of the final rendered picture is
       nudged from its default position, in NDC units (+-1 spans the full
       display) -- corrects for the projector itself sitting off-axis from
       the projection surface, on top of (not instead of) the scale/
       rotation/offset calibration above, which corrects the 3D model's own
       pose. See the warp pass in the render loop for how these turn into
       an actual perspective-correct quad warp. */
    float ks_tl_x, ks_tl_y, ks_tr_x, ks_tr_y, ks_bl_x, ks_bl_y, ks_br_x, ks_br_y;
    /* Video edge stretch: where each edge of the display samples the
       video, in its own UV space (0-1 = untouched). Independent of the
       model pose above -- moving one edge stretches the video in from
       that side while the opposite edge stays put. See the fragment
       shader's uv remap for how these turn into the actual sample. */
    float vid_left, vid_right, vid_top, vid_bottom;
    /* Manual video orientation -- there's no way to derive these
       automatically (they depend on how a given video file happened to be
       authored), so unlike everything else above this is plain user input,
       not something computed from the model/projector geometry. Applied
       in VS_SRC after the box-fit re-mapping: rotate (degrees clockwise as
       seen on the projector) about the video's own center, then flip --
       see server.py's MAPPING_NUMERIC/BOOLEAN comments. */
    float vid_rotation;
    bool vid_flip_h, vid_flip_v;
};
/* Designated rather than positional: these defaults used to be a bare list
   in struct order, which meant inserting a field anywhere but the end
   silently shifted every value after it onto the wrong member. Naming them
   makes the order irrelevant, and anything left out is zero-initialised.
   Mostly a safety net either way -- mapping_reload overwrites all of these
   from mapping.json at startup -- but it is what a partial or missing
   mapping file falls back to. */
static struct mapping map_cur = {
    .scale = 1, .rot_x = 0, .rot_y = 0, .rot_z = 0, .off_x = 0, .off_y = 0,
    .render_scale = 1, .throw_dist = 0.6f, .throw_off_x = 0, .throw_off_y = 0,
    .shading = false, .gizmo = false, .fps_overlay = false,
    .ks_tl_x = 0, .ks_tl_y = 0, .ks_tr_x = 0, .ks_tr_y = 0,
    .ks_bl_x = 0, .ks_bl_y = 0, .ks_br_x = 0, .ks_br_y = 0,
    .vid_left = 0, .vid_right = 1, .vid_top = 0, .vid_bottom = 1,
    .vid_rotation = 0, .vid_flip_h = false, .vid_flip_v = true,
};
static const char *mapping_path = "/home/pj/zealandata/mapping.json";
/* Sub-second resolution matters here: st_mtime alone is whole seconds, so
   several slider-drag writes landing in the same wall-clock second would
   collapse into a single detected change and stall updates for up to a
   second. */
static struct timespec mapping_mtim;

/* Deliberately not a real JSON parser: the file is written by one known
   producer with a flat numeric/boolean schema, so scanning for each key is
   enough and avoids taking on a dependency for it. */
static bool json_num(const char *buf, const char *key, float *out) {
    char pat[64];
    snprintf(pat, sizeof pat, "\"%s\"", key);
    const char *p = strstr(buf, pat);
    if (!p) return false;
    p = strchr(p + strlen(pat), ':');
    if (!p) return false;
    *out = strtof(p + 1, NULL);
    return true;
}

static bool json_bool(const char *buf, const char *key, bool *out) {
    char pat[64];
    snprintf(pat, sizeof pat, "\"%s\"", key);
    const char *p = strstr(buf, pat);
    if (!p) return false;
    p = strchr(p + strlen(pat), ':');
    if (!p) return false;
    while (*++p == ' ') {}
    *out = (strncmp(p, "true", 4) == 0);
    return true;
}

static void mapping_reload(void) {
    struct stat st;
    if (stat(mapping_path, &st) != 0) return;
    if (st.st_mtim.tv_sec == mapping_mtim.tv_sec && st.st_mtim.tv_nsec == mapping_mtim.tv_nsec) return;
    mapping_mtim = st.st_mtim;

    FILE *f = fopen(mapping_path, "r");
    if (!f) return;
    char buf[2048];
    size_t n = fread(buf, 1, sizeof buf - 1, f);
    buf[n] = 0;
    fclose(f);

    json_num(buf, "scale", &map_cur.scale);
    json_num(buf, "rotation_x", &map_cur.rot_x);
    json_num(buf, "rotation_y", &map_cur.rot_y);
    json_num(buf, "rotation_z", &map_cur.rot_z);
    json_num(buf, "offset_x", &map_cur.off_x);
    json_num(buf, "offset_y", &map_cur.off_y);
    json_num(buf, "render_scale", &map_cur.render_scale);
    json_num(buf, "throw_distance", &map_cur.throw_dist);
    json_num(buf, "throw_offset_x", &map_cur.throw_off_x);
    json_num(buf, "throw_offset_y", &map_cur.throw_off_y);
    json_bool(buf, "shading", &map_cur.shading);
    json_bool(buf, "gizmo", &map_cur.gizmo);
    json_bool(buf, "fps", &map_cur.fps_overlay);
    json_num(buf, "keystone_tl_x", &map_cur.ks_tl_x);
    json_num(buf, "keystone_tl_y", &map_cur.ks_tl_y);
    json_num(buf, "keystone_tr_x", &map_cur.ks_tr_x);
    json_num(buf, "keystone_tr_y", &map_cur.ks_tr_y);
    json_num(buf, "keystone_bl_x", &map_cur.ks_bl_x);
    json_num(buf, "keystone_bl_y", &map_cur.ks_bl_y);
    json_num(buf, "keystone_br_x", &map_cur.ks_br_x);
    json_num(buf, "keystone_br_y", &map_cur.ks_br_y);
    json_num(buf, "video_left", &map_cur.vid_left);
    json_num(buf, "video_right", &map_cur.vid_right);
    json_num(buf, "video_top", &map_cur.vid_top);
    json_num(buf, "video_bottom", &map_cur.vid_bottom);
    json_num(buf, "video_rotation", &map_cur.vid_rotation);
    json_bool(buf, "video_flip_h", &map_cur.vid_flip_h);
    json_bool(buf, "video_flip_v", &map_cur.vid_flip_v);
    if (map_cur.render_scale < 0.25f) map_cur.render_scale = 0.25f;
    if (map_cur.render_scale > 1.0f) map_cur.render_scale = 1.0f;
    /* Below this the near plane (see the render loop's frustum setup)
       starts crowding the model itself. */
    if (map_cur.throw_dist < 0.3f) map_cur.throw_dist = 0.3f;
    printf("[cal] scale=%.2f rot=(%.0f,%.0f,%.0f) off=(%.2f,%.2f) rs=%.2f throw=%.2f throw_off=(%.2f,%.2f) shading=%d gizmo=%d fps=%d "
           "ks_tl=(%.2f,%.2f) ks_tr=(%.2f,%.2f) ks_bl=(%.2f,%.2f) ks_br=(%.2f,%.2f) "
           "video_edges=(%.3f,%.3f,%.3f,%.3f) video_rotation=%.0f video_flip=(%d,%d)\n",
           map_cur.scale, map_cur.rot_x, map_cur.rot_y, map_cur.rot_z,
           map_cur.off_x, map_cur.off_y, map_cur.render_scale, map_cur.throw_dist,
           map_cur.throw_off_x, map_cur.throw_off_y,
           map_cur.shading, map_cur.gizmo, map_cur.fps_overlay,
           map_cur.ks_tl_x, map_cur.ks_tl_y, map_cur.ks_tr_x, map_cur.ks_tr_y,
           map_cur.ks_bl_x, map_cur.ks_bl_y, map_cur.ks_br_x, map_cur.ks_br_y,
           map_cur.vid_left, map_cur.vid_right, map_cur.vid_top, map_cur.vid_bottom,
           map_cur.vid_rotation, map_cur.vid_flip_h, map_cur.vid_flip_v);
}

/* ============================================================ DRM / KMS == */

struct drm_state {
    int fd;
    uint32_t connector_id;
    uint32_t crtc_id;
    drmModeModeInfo mode;
    drmModeCrtc *saved_crtc;
};
static struct drm_state drm;

static int drm_init(const char *card) {
    drm.fd = open(card, O_RDWR | O_CLOEXEC);
    if (drm.fd < 0) { fprintf(stderr, "open %s: %s\n", card, strerror(errno)); return 0; }

    drmModeRes *res = drmModeGetResources(drm.fd);
    if (!res) { fprintf(stderr, "drmModeGetResources failed (is this a KMS node?)\n"); return 0; }

    drmModeConnector *conn = NULL;
    for (int i = 0; i < res->count_connectors; i++) {
        drmModeConnector *c = drmModeGetConnector(drm.fd, res->connectors[i]);
        if (c && c->connection == DRM_MODE_CONNECTED && c->count_modes > 0) { conn = c; break; }
        if (c) drmModeFreeConnector(c);
    }
    if (!conn) { fprintf(stderr, "no connected display\n"); drmModeFreeResources(res); return 0; }

    drm.mode = conn->modes[0];
    for (int i = 0; i < conn->count_modes; i++)
        if (conn->modes[i].type & DRM_MODE_TYPE_PREFERRED) { drm.mode = conn->modes[i]; break; }
    drm.connector_id = conn->connector_id;

    drmModeEncoder *enc = NULL;
    if (conn->encoder_id) enc = drmModeGetEncoder(drm.fd, conn->encoder_id);
    if (enc) { drm.crtc_id = enc->crtc_id; drmModeFreeEncoder(enc); }
    if (!drm.crtc_id) {
        for (int i = 0; i < conn->count_encoders && !drm.crtc_id; i++) {
            drmModeEncoder *e = drmModeGetEncoder(drm.fd, conn->encoders[i]);
            if (!e) continue;
            for (int c = 0; c < res->count_crtcs; c++)
                if (e->possible_crtcs & (1 << c)) { drm.crtc_id = res->crtcs[c]; break; }
            drmModeFreeEncoder(e);
        }
    }
    CHECK(drm.crtc_id, "no usable CRTC");

    drm.saved_crtc = drmModeGetCrtc(drm.fd, drm.crtc_id);
    printf("[drm] %s: %dx%d@%d connector=%u crtc=%u\n", card,
           drm.mode.hdisplay, drm.mode.vdisplay, drm.mode.vrefresh,
           drm.connector_id, drm.crtc_id);

    drmModeFreeConnector(conn);
    drmModeFreeResources(res);
    return 1;
}

static void drm_restore(void) {
    if (drm.saved_crtc) {
        drmModeSetCrtc(drm.fd, drm.saved_crtc->crtc_id, drm.saved_crtc->buffer_id,
                       drm.saved_crtc->x, drm.saved_crtc->y,
                       &drm.connector_id, 1, &drm.saved_crtc->mode);
        drmModeFreeCrtc(drm.saved_crtc);
        drm.saved_crtc = NULL;
    }
}

/* ============================================================ GBM / EGL == */

static struct gbm_device *gbm_dev;
static struct gbm_surface *gbm_surf;
static EGLDisplay egl_dpy;
static EGLContext egl_ctx;
static EGLSurface egl_surf;

static int egl_init(void) {
    gbm_dev = gbm_create_device(drm.fd);
    CHECK(gbm_dev, "gbm_create_device");
    gbm_surf = gbm_surface_create(gbm_dev, drm.mode.hdisplay, drm.mode.vdisplay,
                                  GBM_FORMAT_XRGB8888,
                                  GBM_BO_USE_SCANOUT | GBM_BO_USE_RENDERING);
    CHECK(gbm_surf, "gbm_surface_create");

    PFNEGLGETPLATFORMDISPLAYEXTPROC getPlatformDisplay =
        (PFNEGLGETPLATFORMDISPLAYEXTPROC)eglGetProcAddress("eglGetPlatformDisplayEXT");
    egl_dpy = getPlatformDisplay ? getPlatformDisplay(EGL_PLATFORM_GBM_KHR, gbm_dev, NULL)
                                 : eglGetDisplay((EGLNativeDisplayType)gbm_dev);
    CHECK(egl_dpy != EGL_NO_DISPLAY, "eglGetDisplay");
    CHECK(eglInitialize(egl_dpy, NULL, NULL), "eglInitialize");
    CHECK(eglBindAPI(EGL_OPENGL_ES_API), "eglBindAPI");

    /* The config's native visual has to match the GBM surface's format or
       eglCreateWindowSurface fails with BAD_MATCH, so filter on it rather
       than trusting eglChooseConfig's ordering. */
    EGLint attr[] = { EGL_SURFACE_TYPE, EGL_WINDOW_BIT,
                      EGL_RENDERABLE_TYPE, EGL_OPENGL_ES3_BIT,
                      EGL_RED_SIZE, 8, EGL_GREEN_SIZE, 8, EGL_BLUE_SIZE, 8,
                      EGL_DEPTH_SIZE, 16, EGL_NONE };
    EGLint n = 0;
    EGLConfig configs[64], config = NULL;
    CHECK(eglChooseConfig(egl_dpy, attr, configs, 64, &n) && n > 0, "eglChooseConfig");
    for (EGLint i = 0; i < n; i++) {
        EGLint id;
        if (eglGetConfigAttrib(egl_dpy, configs[i], EGL_NATIVE_VISUAL_ID, &id) &&
            id == GBM_FORMAT_XRGB8888) { config = configs[i]; break; }
    }
    if (!config) config = configs[0];

    EGLint ctxattr[] = { EGL_CONTEXT_CLIENT_VERSION, 3, EGL_NONE };
    egl_ctx = eglCreateContext(egl_dpy, config, EGL_NO_CONTEXT, ctxattr);
    CHECK(egl_ctx != EGL_NO_CONTEXT, "eglCreateContext");
    egl_surf = eglCreateWindowSurface(egl_dpy, config, (EGLNativeWindowType)gbm_surf, NULL);
    CHECK(egl_surf != EGL_NO_SURFACE, "eglCreateWindowSurface");
    CHECK(eglMakeCurrent(egl_dpy, egl_surf, egl_surf, egl_ctx), "eglMakeCurrent");

    printf("[gl ] %s | %s\n", glGetString(GL_RENDERER), glGetString(GL_VERSION));
    return 1;
}

struct fb_wrap { struct gbm_bo *bo; uint32_t fb_id; };

static void fb_destroy(struct gbm_bo *bo, void *data) {
    struct fb_wrap *fb = data;
    if (fb && fb->fb_id) drmModeRmFB(drm.fd, fb->fb_id);
    free(fb);
    (void)bo;
}

static uint32_t fb_for_bo(struct gbm_bo *bo) {
    struct fb_wrap *fb = gbm_bo_get_user_data(bo);
    if (fb) return fb->fb_id;
    fb = calloc(1, sizeof *fb);
    fb->bo = bo;
    uint32_t handles[4] = { gbm_bo_get_handle(bo).u32 };
    uint32_t strides[4] = { gbm_bo_get_stride(bo) };
    uint32_t offsets[4] = { 0 };
    if (drmModeAddFB2(drm.fd, gbm_bo_get_width(bo), gbm_bo_get_height(bo),
                      GBM_FORMAT_XRGB8888, handles, strides, offsets, &fb->fb_id, 0)) {
        fprintf(stderr, "drmModeAddFB2: %s\n", strerror(errno));
        free(fb);
        return 0;
    }
    gbm_bo_set_user_data(bo, fb, fb_destroy);
    return fb->fb_id;
}

static struct gbm_bo *current_bo;
static bool crtc_set;

static void page_flip_handler(int fd, unsigned frame, unsigned sec, unsigned usec, void *data) {
    (void)fd; (void)frame; (void)sec; (void)usec;
    *(bool *)data = false;
}

static void present(void) {
    CHECK(eglSwapBuffers(egl_dpy, egl_surf), "eglSwapBuffers");
    struct gbm_bo *next = gbm_surface_lock_front_buffer(gbm_surf);
    CHECK(next, "gbm_surface_lock_front_buffer");
    uint32_t fb = fb_for_bo(next);

    if (!crtc_set) {
        CHECK(!drmModeSetCrtc(drm.fd, drm.crtc_id, fb, 0, 0, &drm.connector_id, 1, &drm.mode),
              "drmModeSetCrtc");
        crtc_set = true;
    } else {
        bool waiting = true;
        if (drmModePageFlip(drm.fd, drm.crtc_id, fb, DRM_MODE_PAGE_FLIP_EVENT, &waiting)) {
            /* Fall back to a blocking modeset rather than dropping the frame
               entirely -- rare, but leaves the picture correct if it happens. */
            drmModeSetCrtc(drm.fd, drm.crtc_id, fb, 0, 0, &drm.connector_id, 1, &drm.mode);
        } else {
            drmEventContext ev = { .version = 2, .page_flip_handler = page_flip_handler };
            while (waiting && running) drmHandleEvent(drm.fd, &ev);
        }
    }
    if (current_bo) gbm_surface_release_buffer(gbm_surf, current_bo);
    current_bo = next;
}

/* ============================================================== matrices = */

typedef float mat4[16];

static void mat_identity(mat4 m) {
    memset(m, 0, sizeof(mat4));
    m[0] = m[5] = m[10] = m[15] = 1.f;
}

/* column-major, out = a * b */
static void mat_mul(mat4 out, const mat4 a, const mat4 b) {
    mat4 t;
    for (int c = 0; c < 4; c++)
        for (int r = 0; r < 4; r++) {
            float s = 0;
            for (int k = 0; k < 4; k++) s += a[k * 4 + r] * b[c * 4 + k];
            t[c * 4 + r] = s;
        }
    memcpy(out, t, sizeof t);
}

static void mat_rot_x(mat4 m, float rad) {
    mat_identity(m);
    m[5] = cosf(rad); m[6] = sinf(rad); m[9] = -sinf(rad); m[10] = cosf(rad);
}
static void mat_rot_y(mat4 m, float rad) {
    mat_identity(m);
    m[0] = cosf(rad); m[2] = -sinf(rad); m[8] = sinf(rad); m[10] = cosf(rad);
}
static void mat_rot_z(mat4 m, float rad) {
    mat_identity(m);
    m[0] = cosf(rad); m[1] = sinf(rad); m[4] = -sinf(rad); m[5] = cosf(rad);
}
static void mat_translate(mat4 m, float x, float y, float z) {
    mat_identity(m); m[12] = x; m[13] = y; m[14] = z;
}
static void mat_scale(mat4 m, float s) {
    mat_identity(m); m[0] = m[5] = m[10] = s;
}
/* Standard OpenGL perspective frustum (l,r,b,t given at the near plane).
   Replaced an orthographic projection here -- a parallel-rays "sunlight"
   assumption that had no notion of distance, which is exactly why it got
   the model's elevation wrong for a real point-source projector. This
   needs the model actually pushed out in front of the origin along -Z
   first -- see its call site. */
static void mat_frustum(mat4 m, float l, float r, float b, float t, float n, float f) {
    for (int i = 0; i < 16; i++) m[i] = 0;
    m[0] = 2 * n / (r - l);
    m[5] = 2 * n / (t - b);
    m[8] = (r + l) / (r - l);
    m[9] = (t + b) / (t - b);
    m[10] = -(f + n) / (f - n);
    m[11] = -1;
    m[14] = -(2 * f * n) / (f - n);
}

/* Maps the unit square (s,t in [0,1]) onto an arbitrary quad given by its
   four corners -- the classical "unit square to quad" projective mapping
   (Heckbert, "Fundamentals of Texture Mapping and Image Warping", 1989).
   Used for keystone: a plain 2-triangle quad with independently-moved
   corners would show a visible seam along the diagonal for anything but
   tiny corrections, since linear interpolation across each triangle isn't
   the same as a true perspective warp. Feeding this homography's (x,y,w)
   straight into gl_Position instead (see the warp shader) makes the GPU's
   own perspective-correct rasterization do the actual warping, which is
   exactly what real projectors' geometry correction does. Corners are
   ordered (0,0),(1,0),(1,1),(0,1) matching the source parameterization. */
static void quad_homography(float x0, float y0, float x1, float y1,
                             float x2, float y2, float x3, float y3,
                             float H[9]) {
    float dx1 = x1 - x2, dx2 = x3 - x2, dx3 = x0 - x1 + x2 - x3;
    float dy1 = y1 - y2, dy2 = y3 - y2, dy3 = y0 - y1 + y2 - y3;
    float a, b, c, d, e, f, g, h;
    if (fabsf(dx3) < 1e-6f && fabsf(dy3) < 1e-6f) {
        /* Degenerates to a plain affine (parallelogram) map. */
        a = x1 - x0; b = x2 - x1; c = x0;
        d = y1 - y0; e = y2 - y1; f = y0;
        g = 0.f; h = 0.f;
    } else {
        float denom = dx1 * dy2 - dx2 * dy1;
        g = (dx3 * dy2 - dx2 * dy3) / denom;
        h = (dx1 * dy3 - dx3 * dy1) / denom;
        a = x1 - x0 + g * x1; b = x3 - x0 + h * x3; c = x0;
        d = y1 - y0 + g * y1; e = y3 - y0 + h * y3; f = y0;
    }
    H[0] = a; H[1] = b; H[2] = c;
    H[3] = d; H[4] = e; H[5] = f;
    H[6] = g; H[7] = h; H[8] = 1.f;
}

static void homography_apply(const float H[9], float s, float t, float *x, float *y, float *w) {
    *x = H[0] * s + H[1] * t + H[2];
    *y = H[3] * s + H[4] * t + H[5];
    *w = H[6] * s + H[7] * t + H[8];
}

/* ================================================================= mesh == */

typedef struct { float x, y, z; } vec3;

static vec3 *m_pos = NULL;
static vec3 *m_nrm = NULL;
static unsigned *m_idx = NULL;
static size_t m_nvert = 0, m_nidx = 0;
/* Full (not half) extent of the normalised, centred mesh -- set once at
   the end of load_obj. Used every frame as uModelSize, for mapping the
   video onto exactly the model's own local footprint -- see VS_SRC's
   comment. */
static vec3 m_size;

/* The relief comes out of the OBJ inverted -- what should stand proud sits
   sunken -- so the height axis is mirrored. Kept as constants rather than
   controls: these are fixed properties of this model file, not things that
   vary with where the projector happens to be. */
static const bool INVERT_RELIEF = false;
/* The fixed camera looks down -Z, so once the up-axis remap above has
   folded height into depth, an "as seen on screen" spin lives on the Z
   axis, not Y -- rotating a positive angle about Z is counter-clockwise
   from the camera's side (standard GL convention), so clockwise needs a
   negative value here. This particular OBJ's own fixed 90/180-degree
   correction is baked directly into the stored vertex data at the end of
   load_obj now (see that comment) rather than kept as a separate runtime
   matrix -- these two constants used to drive it there. */

/* How the video needs turning to land the right way up on the print --
   confirmed live against it: just a vertical flip, no rotation and no
   horizontal flip on top of that (clip-space Y and a texture's V both run
   opposite the screen's downward row order, which is what this corrects
   for once uMVP carries the model's full real orientation -- see its own
   comment). Fixed to the physical print, not a calibration slider, so
   it's baked directly into VS_SRC's vUV computation below rather than a C
   constant here -- this used to feed a CPU-side orient_uv() step instead,
   back when vUV came from a static per-vertex attribute; now that it's
   computed from the live clip-space position every frame, the equivalent
   correction has to happen in the shader too. Unrelated to the OBJ's own
   axis correction above -- this is purely about which edge of the video
   frame the print calls "up". If this ever needs to change, edit the
   GLSL directly. */

/* OBJ face indices already reference a shared vertex list, so unlike the
   browser path -- where OBJLoader de-indexed the mesh and it had to be
   merged back -- the data arrives indexed and is used as-is. */
static int load_obj(const char *path) {
    FILE *f = fopen(path, "r");
    if (!f) { fprintf(stderr, "open %s: %s\n", path, strerror(errno)); return 0; }

    size_t cap_v = 1024, cap_i = 4096;
    m_pos = malloc(cap_v * sizeof(vec3));
    m_idx = malloc(cap_i * sizeof(unsigned));

    char line[512];
    while (fgets(line, sizeof line, f)) {
        if (line[0] == 'v' && line[1] == ' ') {
            if (m_nvert == cap_v) { cap_v *= 2; m_pos = realloc(m_pos, cap_v * sizeof(vec3)); }
            float x, y, z;
            if (sscanf(line + 2, "%f %f %f", &x, &y, &z) == 3)
                m_pos[m_nvert++] = (vec3){ x, y, z };
        } else if (line[0] == 'f' && line[1] == ' ') {
            unsigned v[8]; int n = 0;
            char *p = line + 2;
            while (n < 8) {
                while (*p == ' ') p++;
                if (!*p || *p == '\n') break;
                char *end;
                long val = strtol(p, &end, 10);
                if (end == p) break;
                p = end;
                while (*p && *p != ' ' && *p != '\n') p++;   /* skip /vt/vn */
                v[n++] = (unsigned)(val > 0 ? val - 1 : (long)m_nvert + val);
            }
            for (int k = 2; k < n; k++) {                    /* fan-triangulate */
                if (m_nidx + 3 > cap_i) { cap_i *= 2; m_idx = realloc(m_idx, cap_i * sizeof(unsigned)); }
                m_idx[m_nidx++] = v[0];
                m_idx[m_nidx++] = v[k - 1];
                m_idx[m_nidx++] = v[k];
            }
        }
    }
    fclose(f);
    if (!m_nvert || !m_nidx) { fprintf(stderr, "%s: no geometry\n", path); return 0; }

    /* bounds */
    vec3 mn = m_pos[0], mx = m_pos[0];
    for (size_t i = 1; i < m_nvert; i++) {
        if (m_pos[i].x < mn.x) mn.x = m_pos[i].x;
        if (m_pos[i].x > mx.x) mx.x = m_pos[i].x;
        if (m_pos[i].y < mn.y) mn.y = m_pos[i].y;
        if (m_pos[i].y > mx.y) mx.y = m_pos[i].y;
        if (m_pos[i].z < mn.z) mn.z = m_pos[i].z;
        if (m_pos[i].z > mx.z) mx.z = m_pos[i].z;
    }
    vec3 size = { mx.x - mn.x, mx.y - mn.y, mx.z - mn.z };

    /* Up axis is whichever has the smallest extent -- for a relief print
       that's the height. Confirmed by hard data on 3dPrint_210kFaces.obj:
       height extent (y) is ~10-20x smaller than the footprint (x, z). */
    int up_detected = (size.y <= size.x && size.y <= size.z) ? 1
                     : (size.z <= size.x && size.z <= size.y) ? 2 : 1;
    printf("[obj] extents x=%.3f y=%.3f z=%.3f (heuristic picked %c)\n",
           size.x, size.y, size.z, up_detected == 1 ? 'y' : up_detected == 2 ? 'z' : 'x');
    int up = up_detected;

    /* The renderer's camera is fixed: it always looks down -Z, with (X,Y)
       as the visible plane and Z as depth (the standard GL convention).
       For a y-up model that means rendering as-is would show it *side-on*
       -- height correctly reads as screen-up, but the actual footprint
       (X and Z) gets flattened into one visible axis (X) plus the hidden
       depth axis (Z), instead of both footprint axes being visible from
       above. Rotating -90 degrees about X swaps height into depth (where
       a top-down view expects it) and brings both footprint axes onto
       the screen. This is a proper rotation (determinant +1), not a
       reflection, so it needs no winding fix, unlike the mirror below. */
    if (up == 1) {
        for (size_t i = 0; i < m_nvert; i++) {
            float y = m_pos[i].y, z = m_pos[i].z;
            m_pos[i].y = z;
            m_pos[i].z = -y;
        }
        mn = m_pos[0]; mx = m_pos[0];
        for (size_t i = 1; i < m_nvert; i++) {
            if (m_pos[i].x < mn.x) mn.x = m_pos[i].x;
            if (m_pos[i].x > mx.x) mx.x = m_pos[i].x;
            if (m_pos[i].y < mn.y) mn.y = m_pos[i].y;
            if (m_pos[i].y > mx.y) mx.y = m_pos[i].y;
            if (m_pos[i].z < mn.z) mn.z = m_pos[i].z;
            if (m_pos[i].z > mx.z) mx.z = m_pos[i].z;
        }
        size = (vec3){ mx.x - mn.x, mx.y - mn.y, mx.z - mn.z };
        up = 2;   /* the data is now genuinely z-up */
    }

    if (INVERT_RELIEF) {
        for (size_t i = 0; i < m_nvert; i++) {
            float *c = up == 1 ? &m_pos[i].y : up == 2 ? &m_pos[i].z : &m_pos[i].x;
            *c = (up == 1 ? (mn.y + mx.y) : up == 2 ? (mn.z + mx.z) : (mn.x + mx.x)) - *c;
        }
        /* Mirroring reverses every triangle's winding, which would leave the
           normals pointing inward and light the relief exactly backwards --
           peaks reading as hollows. Swapping two corners puts it back. */
        for (size_t i = 0; i + 2 < m_nidx; i += 3) {
            unsigned t = m_idx[i + 1]; m_idx[i + 1] = m_idx[i + 2]; m_idx[i + 2] = t;
        }
    }

    /* Centre so calibration pivots around the model's middle, and normalise
       to roughly unit extent so the orthographic bounds below are in fixed
       units -- otherwise framing would depend on whatever units the OBJ was
       exported in, and a scale of 1.0 would mean something different for
       every model. */
    vec3 ctr = { (mn.x + mx.x) / 2, (mn.y + mx.y) / 2, (mn.z + mx.z) / 2 };
    float ext = fmaxf(size.x, fmaxf(size.y, size.z));
    float norm = ext > 0 ? 2.f / ext : 1.f;
    for (size_t i = 0; i < m_nvert; i++) {
        m_pos[i].x = (m_pos[i].x - ctr.x) * norm;
        m_pos[i].y = (m_pos[i].y - ctr.y) * norm;
        m_pos[i].z = (m_pos[i].z - ctr.z) * norm;
    }
    size.x *= norm; size.y *= norm; size.z *= norm;

    /* This particular OBJ export's raw axes need a further fixed 90-degree
       Z then 180-degree X turn on top of the up-axis remap above to sit
       the way the physical print actually sits under the (fixed) camera.
       Used to be applied at render time instead, as a separate "mBase"
       matrix baked underneath the live rotation sliders -- but that meant
       the mesh's real render transform (mBase included) and the video's
       projective-UV source transform (mBase deliberately excluded, so the
       calibration gizmo's rings track their own same-named slider)
       disagreed about the model's own pose by exactly this rotation. Under
       a true point-source perspective that disagreement isn't a fixed 2-D
       screen-space offset -- it warps differently as rot_x/y/z, scale and
       offset move the model around in the projector's view, which is
       exactly the "texture crawls relative to the geometry as calibration
       changes" bug this fixes. Baking it into the stored vertex data
       instead makes it the mesh's actual resting orientation: there is no
       longer a second, disagreeing transform for the render and the UV to
       diverge from. Equivalent to rot_z(90) * rot_x(180) applied to each
       vertex, worked out directly as (x,y,z) -> (y,x,-z). */
    for (size_t i = 0; i < m_nvert; i++) {
        float x = m_pos[i].x, y = m_pos[i].y, z = m_pos[i].z;
        m_pos[i].x = y;
        m_pos[i].y = x;
        m_pos[i].z = -z;
    }
    { float t = size.x; size.x = size.y; size.y = t; }
    m_size = size;

    /* Smooth normals, area-weighted by the cross product's magnitude. Only
       the calibration shading uses them; the projection material is unlit. */
    m_nrm = calloc(m_nvert, sizeof(vec3));
    for (size_t i = 0; i + 2 < m_nidx; i += 3) {
        vec3 a = m_pos[m_idx[i]], b = m_pos[m_idx[i + 1]], c = m_pos[m_idx[i + 2]];
        vec3 e1 = { b.x - a.x, b.y - a.y, b.z - a.z };
        vec3 e2 = { c.x - a.x, c.y - a.y, c.z - a.z };
        vec3 nn = { e1.y * e2.z - e1.z * e2.y,
                    e1.z * e2.x - e1.x * e2.z,
                    e1.x * e2.y - e1.y * e2.x };
        for (int k = 0; k < 3; k++) {
            m_nrm[m_idx[i + k]].x += nn.x;
            m_nrm[m_idx[i + k]].y += nn.y;
            m_nrm[m_idx[i + k]].z += nn.z;
        }
    }
    for (size_t i = 0; i < m_nvert; i++) {
        float l = sqrtf(m_nrm[i].x * m_nrm[i].x + m_nrm[i].y * m_nrm[i].y + m_nrm[i].z * m_nrm[i].z);
        if (l > 0) { m_nrm[i].x /= l; m_nrm[i].y /= l; m_nrm[i].z /= l; }
    }

    printf("[obj] %s: %zu verts, %zu tris, up-axis=%c\n", path, m_nvert, m_nidx / 3,
           up == 1 ? 'y' : up == 2 ? 'z' : 'x');
    return 1;
}

/* ============================================================== shaders == */

static const char *VS_SRC =
    "#version 300 es\n"
    "layout(location=0) in vec3 aPos;\n"
    "layout(location=1) in vec3 aNrm;\n"
    "uniform mat4 uMVP;\n"
    "uniform mat4 uModel;\n"
    /* The model's own local footprint extent (X/Y -- Z is elevation, see
       load_obj), for turning aPos into a plain 0-1 UV below. Fixed for the
       life of the loaded model, not per-frame calibration state. */
    "uniform vec2 uModelSize;\n"
    /* Manual video orientation -- see server.py's MAPPING_NUMERIC/BOOLEAN
       comments on why this is plain user input rather than something
       derived from the model/projector geometry like everything else
       here. uVidRotation is radians, clockwise as seen on the projector. */
    "uniform float uVidRotation;\n"
    "uniform bool uVidFlipH;\n"
    "uniform bool uVidFlipV;\n"
    "out vec2 vUV;\n"
    "out vec3 vNrm;\n"
    /* Eye-space position. uModel has mEye folded into it at the call
       site, so this is already relative to the projector's own eye at
       the origin -- which is what lets the shading below sit exactly on
       the virtual camera without needing the eye passed in separately. */
    "out vec3 vPos;\n"
    "void main(){\n"
    "  gl_Position = uMVP * vec4(aPos,1.0);\n"
    /* The texture is glued to the model's own surface in its own local
       space -- a plain top-down drape, exactly like a UV projection done
       once in Blender against the model file itself -- rather than derived
       from where each vertex happens to land on screen after calibration.
       An earlier version instead sampled a clip-space position (the
       "projective texture mapping" trick shadow/spotlight projection
       uses), deliberately so a vertex's texture coordinate would shift
       with elevation as the calibration sliders moved the model around --
       but that meant the video's own framing was never actually fixed to
       the model, only to whatever the live camera/frustum/keystone
       ("projection warping") happened to be doing that frame, verified
       wrong against a straightforward Blender UV check even at default
       calibration. gl_Position above already carries the model through
       that same camera/frustum correctly; the texture just needs to sit
       on the model's surface first, the same way paint would. */
    "  vec2 uv = aPos.xy / uModelSize + 0.5;\n"
    /* Manual video orientation: how a given video file needs turning to
       land the right way up on this print isn't something derivable from
       the model/projector geometry -- it depends on how that file happened
       to be authored/exported -- so this is plain operator-facing
       calibration (the "Video rotation/flip" admin controls), not a fixed
       shader constant like earlier versions had. Rotate about the video's
       own center first, then flip, so the two controls stay visually
       independent (e.g. flipping doesn't also require re-finding the
       rotation angle). */
    "  vec2 uvc = uv - 0.5;\n"
    "  float rc = cos(uVidRotation), rs = sin(uVidRotation);\n"
    "  uvc = vec2(uvc.x * rc - uvc.y * rs, uvc.x * rs + uvc.y * rc);\n"
    "  uv = uvc + 0.5;\n"
    "  if (uVidFlipH) uv.x = 1.0 - uv.x;\n"
    "  if (uVidFlipV) uv.y = 1.0 - uv.y;\n"
    "  vUV = uv;\n"
    "  vNrm = mat3(uModel) * aNrm;\n"
    "  vPos = (uModel * vec4(aPos,1.0)).xyz;\n"
    "}\n";

static const char *FS_SRC =
    "#version 300 es\n"
    "precision mediump float;\n"
    "in vec2 vUV;\n"
    "in vec3 vNrm;\n"
    "in vec3 vPos;\n"
    "uniform sampler2D uTex;\n"
    "uniform int uShading;\n"
    "uniform vec2 uVideoEdgeLT;\n"
    "uniform vec2 uVideoEdgeRB;\n"
    "out vec4 oColor;\n"
    "void main(){\n"
    "  vec2 uv = uVideoEdgeLT + vUV * (uVideoEdgeRB - uVideoEdgeLT);\n"
    "  vec4 c = texture(uTex, uv);\n"
    "  if (uShading == 1) {\n"
    /* A square area light centred on the virtual camera, rather than a
       point at it. The eye is the origin in the eye space vPos is
       expressed in, so the light is a square in the z=0 plane there,
       facing the model down the view axis.

       Solved analytically rather than by sampling the square. What
       actually softens an area light is its angular size from the
       surface point: the terminator smears over the band where the
       light is partly below the horizon, roughly |N.L| < w for a light
       of angular half-size w. So this softens the clamp on N.L over
       exactly that band, instead of averaging discrete samples across
       it. A 4x4 sampled version measured 48ms/frame against 21ms for
       this on the Pi's V3D, and any sample count cheap enough to
       afford banded visibly at the terminator -- the smooth curve is
       both faster and cleaner.

       The quadratic is the C1-continuous soft clamp of max(ndl,0): it
       meets ndl exactly at ndl=w and 0 at ndl=-w with no kink at
       either join, so the shading shows no seam where it takes over.
       Dividing the half-size by distance is what makes the softness
       fall off with range the way a real light does -- further away is
       a smaller angular size, hence a harder edge.

       AREA_LIGHT_HALF is in the same units as the normalised mesh (see
       load_obj), so ~0.45 is a light about as wide as the model at the
       default throw_distance of 1.0. Larger = softer, smaller = back
       towards a hard point source. Deliberately a constant, not a
       mapping parameter: it changes how the calibration aid reads, not
       how the projection itself lands. */
    "    const float AREA_LIGHT_HALF = 0.45;\n"
    "    vec3 N = normalize(vNrm);\n"
    "    float dist = max(length(vPos), 1e-4);\n"
    "    float ndl = dot(N, -vPos / dist);\n"
    "    float w = max(AREA_LIGHT_HALF / dist, 1e-4);\n"
    "    float d = (ndl >= w) ? ndl\n"
    "            : ((ndl <= -w) ? 0.0 : (ndl + w) * (ndl + w) / (4.0 * w));\n"
    /* Ambient floor: what a surface facing fully away from the light
       still gets. Low on purpose so the relief reads with real contrast
       -- the area light above already lifts the shadow terminator, and
       a high floor on top of that washed the shape out. */
    "    c.rgb *= (0.2 + 1.1 * d);\n"
    "  }\n"
    "  oColor = vec4(c.rgb, 1.0);\n"
    "}\n";

/* Keystone warp pass: draws the fully-rendered scene (as a texture) onto a
   quad whose 4 corners are independently positioned per keystone_reload's
   homography, correcting for the projector itself sitting off-axis from
   the projection surface. aClipPos.xy/z carry the (x,y,w) the CPU already
   computed via quad_homography() -- feeding w through to gl_Position.w
   directly, rather than pre-dividing by it, is what makes the GPU's own
   rasterizer perspective-correct both the position and the UV
   interpolation across the quad, avoiding the diagonal seam a naive
   2-triangle affine warp would show. */
static const char *WARP_VS_SRC =
    "#version 300 es\n"
    "layout(location=0) in vec3 aClipPos;\n"
    "layout(location=1) in vec2 aUV;\n"
    "out vec2 vUV;\n"
    "void main(){\n"
    "  vUV = aUV;\n"
    "  gl_Position = vec4(aClipPos.xy, 0.0, aClipPos.z);\n"
    "}\n";

static const char *WARP_FS_SRC =
    "#version 300 es\n"
    "precision mediump float;\n"
    "in vec2 vUV;\n"
    "uniform sampler2D uSceneTex;\n"
    "out vec4 oColor;\n"
    "void main(){\n"
    "  oColor = texture(uSceneTex, vUV);\n"
    "}\n";

/* ================================================ calibration gizmo === *
 * Three colored rings -- one per rotation axis, red/green/blue for X/Y/Z
 * -- plus a hand-drawn letter beside each, so an operator can see which
 * physical rotation each slider drives without doing it by trial and
 * error. Drawn in its own pass straight to the default framebuffer
 * *after* the keystone warp blit in the render loop, reusing the same
 * MVP the model itself used but never touching the warp step: keystone
 * corrects for the projector sitting off-axis from the print, which has
 * nothing to do with reading the gizmo, and running these circles through
 * that same perspective warp would turn them into skewed ellipses/quads
 * -- exactly the confusion a reference gizmo exists to avoid. Gated on
 * the existing calibration-shading toggle rather than a new mapping
 * field, since that flag already means "actively lining things up, never
 * during real projection" -- the same moment this is useful. */
static const char *GIZMO_VS_SRC =
    "#version 300 es\n"
    "layout(location=0) in vec3 aPos;\n"
    "layout(location=1) in vec3 aCol;\n"
    "uniform mat4 uMVP;\n"
    "out vec3 vCol;\n"
    "void main(){\n"
    "  vCol = aCol;\n"
    "  gl_Position = uMVP * vec4(aPos, 1.0);\n"
    "}\n";

static const char *GIZMO_FS_SRC =
    "#version 300 es\n"
    "precision mediump float;\n"
    "in vec3 vCol;\n"
    "out vec4 oColor;\n"
    "void main(){ oColor = vec4(vCol, 1.0); }\n";

/* Labels are plain NDC positions (not run through uMVP): each letter's
   center is computed once per frame on the CPU by projecting its ring
   anchor through the same MVP the rings use, then offset by a fixed
   on-screen size -- so the letters stay upright and equally legible
   regardless of the model's current rotation, rather than tumbling with
   the ring they sit next to. */
static const char *GIZMO_LABEL_VS_SRC =
    "#version 300 es\n"
    "layout(location=0) in vec2 aPos;\n"
    "layout(location=1) in vec3 aCol;\n"
    "out vec3 vCol;\n"
    "void main(){\n"
    "  vCol = aCol;\n"
    "  gl_Position = vec4(aPos, 0.0, 1.0);\n"
    "}\n";

#define GIZMO_SEGMENTS 64
#define GIZMO_RADIUS 0.4f
#define GIZMO_LABEL_MAX_VERTS 32   /* 3 letters, at most 3 segments (6 verts) each */

typedef struct { float x, y, z, r, g, b; } gizmo_vert;
typedef struct { float x, y, r, g, b; } label_vert;
typedef struct { float x0, y0, x1, y1; } glyph_seg;

/* Hand-drawn strokes for X/Y/Z, in a unit square (0,0)-(1,1), y-up --
   simplest way to get legible labels without pulling in a font/glyph
   dependency for three letters. */
static const glyph_seg GLYPH_X[] = { { 0, 0, 1, 1 }, { 0, 1, 1, 0 } };
static const glyph_seg GLYPH_Y[] = {
    { 0, 1, 0.5f, 0.5f }, { 1, 1, 0.5f, 0.5f }, { 0.5f, 0.5f, 0.5f, 0 }
};
static const glyph_seg GLYPH_Z[] = { { 0, 1, 1, 1 }, { 1, 1, 0, 0 }, { 0, 0, 1, 0 } };

/* Seven-segment digits for the frame-rate readout, in the same unit
   square and y-up convention as the X/Y/Z strokes above, and drawn by the
   same line-segment path -- a calculator-style font is the cheapest way
   to get digits without a font dependency, and the segments happen to be
   exactly what this renderer can already draw. Kept as explicit stroke
   lists rather than a segment bitmask so they read the way the letters
   above do. */
#define SEG_TOP    { 0.f, 1.f, 1.f, 1.f }
#define SEG_TL     { 0.f, 0.5f, 0.f, 1.f }
#define SEG_TR     { 1.f, 0.5f, 1.f, 1.f }
#define SEG_MID    { 0.f, 0.5f, 1.f, 0.5f }
#define SEG_BL     { 0.f, 0.f, 0.f, 0.5f }
#define SEG_BR     { 1.f, 0.f, 1.f, 0.5f }
#define SEG_BOT    { 0.f, 0.f, 1.f, 0.f }

static const glyph_seg GLYPH_0[] = { SEG_TOP, SEG_TL, SEG_TR, SEG_BL, SEG_BR, SEG_BOT };
static const glyph_seg GLYPH_1[] = { SEG_TR, SEG_BR };
static const glyph_seg GLYPH_2[] = { SEG_TOP, SEG_TR, SEG_MID, SEG_BL, SEG_BOT };
static const glyph_seg GLYPH_3[] = { SEG_TOP, SEG_TR, SEG_MID, SEG_BR, SEG_BOT };
static const glyph_seg GLYPH_4[] = { SEG_TL, SEG_TR, SEG_MID, SEG_BR };
static const glyph_seg GLYPH_5[] = { SEG_TOP, SEG_TL, SEG_MID, SEG_BR, SEG_BOT };
static const glyph_seg GLYPH_6[] = { SEG_TOP, SEG_TL, SEG_MID, SEG_BL, SEG_BR, SEG_BOT };
static const glyph_seg GLYPH_7[] = { SEG_TOP, SEG_TR, SEG_BR };
static const glyph_seg GLYPH_8[] = { SEG_TOP, SEG_TL, SEG_TR, SEG_MID, SEG_BL, SEG_BR, SEG_BOT };
static const glyph_seg GLYPH_9[] = { SEG_TOP, SEG_TL, SEG_TR, SEG_MID, SEG_BR, SEG_BOT };
/* A short stroke along the baseline -- a single point would vanish, since
   everything here is drawn as GL_LINES. */
static const glyph_seg GLYPH_DOT[] = { { 0.35f, 0.f, 0.65f, 0.f } };

static const glyph_seg *const GLYPH_DIGITS[10] = {
    GLYPH_0, GLYPH_1, GLYPH_2, GLYPH_3, GLYPH_4,
    GLYPH_5, GLYPH_6, GLYPH_7, GLYPH_8, GLYPH_9
};
static const int GLYPH_DIGIT_NSEG[10] = { 6, 2, 5, 5, 4, 5, 6, 3, 7, 6 };

/* Worst case for the readout: 5 characters ("999.9"), the widest of them
   7 segments, 2 verts per segment. Rounded up so the shared label buffer
   below has room for either user. */
#define HUD_MAX_VERTS 128

/* Ring i lies in the plane perpendicular to axis i, matching the sense in
   which rotation_x/y/z actually spin the model (see mat_rot_x/y/z above)
   -- so each ring visibly turns when its own slider moves, not the other
   two. */
static void build_gizmo_rings(gizmo_vert out[3 * GIZMO_SEGMENTS]) {
    static const float col[3][3] = { { 1, 0.25f, 0.25f }, { 0.25f, 1, 0.25f }, { 0.35f, 0.55f, 1 } };
    for (int ring = 0; ring < 3; ring++) {
        for (int s = 0; s < GIZMO_SEGMENTS; s++) {
            float a = 2.f * (float)M_PI * s / GIZMO_SEGMENTS;
            float c = cosf(a), sn = sinf(a);
            float x = 0, y = 0, z = 0;
            if (ring == 0)      { y =  c * GIZMO_RADIUS; z = sn * GIZMO_RADIUS; }
            else if (ring == 1) { x =  c * GIZMO_RADIUS; z = -sn * GIZMO_RADIUS; }
            else                { x =  c * GIZMO_RADIUS; y = sn * GIZMO_RADIUS; }
            gizmo_vert *v = &out[ring * GIZMO_SEGMENTS + s];
            v->x = x; v->y = y; v->z = z;
            v->r = col[ring][0]; v->g = col[ring][1]; v->b = col[ring][2];
        }
    }
}

/* Projects a gizmo-space point through mvp down to NDC (w-divide -- w is
   genuinely non-1 now that the render loop uses a real perspective
   frustum, not the old orthographic one). */
static void gizmo_project_ndc(const mat4 mvp, float x, float y, float z, float *ndcx, float *ndcy) {
    float cx = mvp[0] * x + mvp[4] * y + mvp[8] * z + mvp[12];
    float cy = mvp[1] * x + mvp[5] * y + mvp[9] * z + mvp[13];
    float cw = mvp[3] * x + mvp[7] * y + mvp[11] * z + mvp[15];
    if (fabsf(cw) < 1e-6f) cw = 1.f;
    *ndcx = cx / cw; *ndcy = cy / cw;
}

/* Appends one letter's line segments, in NDC, centered at (cx,cy) with
   on-screen "size" corrected by aspect so it reads as a square glyph
   rather than a stretched one on a non-square display. Returns the new
   vertex count. */
static int gizmo_append_glyph(label_vert *out, int count, const glyph_seg *segs, int nseg,
                                float cx, float cy, float size, float aspect,
                                float r, float g, float b) {
    for (int i = 0; i < nseg; i++) {
        float x0 = cx + (segs[i].x0 - 0.5f) * size / aspect;
        float y0 = cy + (segs[i].y0 - 0.5f) * size;
        float x1 = cx + (segs[i].x1 - 0.5f) * size / aspect;
        float y1 = cy + (segs[i].y1 - 0.5f) * size;
        out[count].x = x0; out[count].y = y0; out[count].r = r; out[count].g = g; out[count].b = b; count++;
        out[count].x = x1; out[count].y = y1; out[count].r = r; out[count].g = g; out[count].b = b; count++;
    }
    return count;
}

/* Lays a "%.1f" number out left-to-right from (x,y) as its left edge,
   reusing gizmo_append_glyph for each character -- so the readout picks
   up the same aspect correction the gizmo labels get, and reads as square
   glyphs rather than stretched ones on a non-square display. Anything
   that is not a digit or a point is skipped rather than drawn as a blank,
   which keeps a stray character from punching a hole in the spacing.
   Returns the new vertex count. */
static int hud_append_number(label_vert *out, int count, double value,
                             float x, float y, float size, float aspect,
                             float r, float g, float b) {
    /* Clamped before formatting, not after: a NaN or a wild value would
       otherwise print more characters than the caller sized its buffer
       for. NaN fails every comparison, so this is written to catch it
       rather than to let it through. */
    if (!(value >= 0.0)) value = 0.0;
    if (value > 999.0) value = 999.0;
    char buf[16];
    snprintf(buf, sizeof buf, "%.1f", value);

    const float w = size / aspect;          /* one glyph's on-screen width */
    float cx = x + w * 0.5f;                /* gizmo_append_glyph centres */
    for (const char *p = buf; *p; p++) {
        if (*p == '.') {
            count = gizmo_append_glyph(out, count, GLYPH_DOT, 1, cx, y, size, aspect, r, g, b);
            cx += w * 0.55f;                /* a point needs less room than a digit */
        } else if (*p >= '0' && *p <= '9') {
            const int d = *p - '0';
            count = gizmo_append_glyph(out, count, GLYPH_DIGITS[d], GLYPH_DIGIT_NSEG[d],
                                       cx, y, size, aspect, r, g, b);
            cx += w * 1.35f;                /* glyph width plus a gap */
        }
    }
    return count;
}

static GLuint compile_shader(GLenum type, const char *src) {
    GLuint s = glCreateShader(type);
    glShaderSource(s, 1, &src, NULL);
    glCompileShader(s);
    GLint ok = 0;
    glGetShaderiv(s, GL_COMPILE_STATUS, &ok);
    if (!ok) { char log[2048]; glGetShaderInfoLog(s, sizeof log, NULL, log);
               fprintf(stderr, "shader compile: %s\n", log); exit(1); }
    return s;
}

/* ============================================================ playback == */

/* GStreamer objects are internally thread-safe (their own GLib locking), so
   playbin/appsink calls are made directly from whichever thread receives
   the IPC command -- only our own small bits of state below need the
   mutex. */
static pthread_mutex_t play_lock = PTHREAD_MUTEX_INITIALIZER;
static GstElement *playbin;
static GstElement *appsink;
static GstGLDisplay *gst_display;
static GstGLContext *gst_app_ctx;

static bool   idle_active = true;    /* true only when nothing is loaded */
static bool   loop_enabled = false;
static double volume_pct = 100.0;
static double pending_start = 0.0;   /* seconds to seek to once loaded */
static bool   have_pending_start = false;
static double last_known_fps = 24.0;

/* Latest decoded frame, as a GL texture already in our EGL share group --
   glupload/glcolorconvert did the DMA-BUF import and YUV->RGBA conversion
   on GStreamer's own thread; this is a plain shared GL name by the time we
   see it, same as the old mpv-render-API video FBO texture was. */
static GstSample *cur_sample;
static GLuint cur_tex;
static int cur_tex_w = 1, cur_tex_h = 1;

/* Still images (the idle/loading picture) bypass playbin entirely -- see
   video_load()'s comment on why -- and are held in this separate,
   permanent texture instead of cur_tex. */
static GLuint idle_tex;
static bool   showing_still_image = false;
/* Set by video_load() (any thread), consumed once by the main thread's
   render loop, since the actual decode + glTexImage2D upload below needs
   the EGL context that's only current there. */
static char   pending_image_path[1024];
static bool   have_pending_image = false;

static bool path_is_still_image(const char *path) {
    const char *dot = strrchr(path, '.');
    if (!dot) return false;
    static const char *exts[] = { ".png", ".jpg", ".jpeg", ".bmp", ".gif", ".webp", NULL };
    for (int i = 0; exts[i]; i++) if (!strcasecmp(dot, exts[i])) return true;
    return false;
}

/* Decodes a still image to raw RGBA and uploads it into idle_tex, via a
   throwaway pipeline independent of the main GL-context-sharing video
   pipeline (playbin/gst_app_ctx) -- a one-off image decode has no
   performance need for that complexity. This replaces routing stills
   through playbin, which -- lacking an imagefreeze element, never added
   here since it's the wrong tool for the real multi-frame videos this
   pipeline otherwise plays -- decodes exactly one frame and hits EOS
   almost immediately, leaving nothing on screen once that single frame's
   GL memory gets recycled by the pool. Must run on the main/GL thread. */
static bool load_idle_image_now(const char *path) {
    gchar *uri = gst_filename_to_uri(path, NULL);
    if (!uri) return false;
    gchar *desc = g_strdup_printf(
        "uridecodebin uri=%s ! videoconvert ! video/x-raw,format=RGBA ! appsink name=s sync=false",
        uri);
    g_free(uri);
    GError *err = NULL;
    GstElement *pipe = gst_parse_launch(desc, &err);
    g_free(desc);
    if (!pipe) {
        fprintf(stderr, "[img] %s: %s\n", path, err ? err->message : "?");
        if (err) g_error_free(err);
        return false;
    }
    GstElement *sink = gst_bin_get_by_name(GST_BIN(pipe), "s");
    gst_element_set_state(pipe, GST_STATE_PLAYING);
    GstSample *sample = gst_app_sink_pull_sample(GST_APP_SINK(sink));
    bool ok = false;
    if (sample) {
        GstCaps *caps = gst_sample_get_caps(sample);
        GstBuffer *buf = gst_sample_get_buffer(sample);
        GstVideoInfo vinfo;
        GstMapInfo map;
        if (caps && gst_video_info_from_caps(&vinfo, caps) && gst_buffer_map(buf, &map, GST_MAP_READ)) {
            if (!idle_tex) glGenTextures(1, &idle_tex);
            glBindTexture(GL_TEXTURE_2D, idle_tex);
            glTexImage2D(GL_TEXTURE_2D, 0, GL_RGBA8, vinfo.width, vinfo.height, 0,
                         GL_RGBA, GL_UNSIGNED_BYTE, map.data);
            glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MIN_FILTER, GL_LINEAR);
            glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MAG_FILTER, GL_LINEAR);
            glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_WRAP_S, GL_CLAMP_TO_EDGE);
            glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_WRAP_T, GL_CLAMP_TO_EDGE);
            gst_buffer_unmap(buf, &map);
            ok = true;
            printf("[img] loaded %s (%dx%d)\n", path, vinfo.width, vinfo.height);
        }
        gst_sample_unref(sample);
    }
    if (!ok) fprintf(stderr, "[img] %s: no sample decoded\n", path);
    gst_element_set_state(pipe, GST_STATE_NULL);
    gst_object_unref(sink);
    gst_object_unref(pipe);
    return ok;
}

static GstBusSyncReply bus_sync_handler(GstBus *bus, GstMessage *msg, gpointer data) {
    (void)bus; (void)data;
    if (GST_MESSAGE_TYPE(msg) != GST_MESSAGE_NEED_CONTEXT) return GST_BUS_PASS;
    const gchar *type = NULL;
    gst_message_parse_context_type(msg, &type);
    GstElement *src = GST_ELEMENT(GST_MESSAGE_SRC(msg));
    if (!g_strcmp0(type, GST_GL_DISPLAY_CONTEXT_TYPE)) {
        GstContext *ctx = gst_context_new(GST_GL_DISPLAY_CONTEXT_TYPE, TRUE);
        gst_context_set_gl_display(ctx, gst_display);
        gst_element_set_context(src, ctx);
        gst_context_unref(ctx);
        gst_message_unref(msg);
        return GST_BUS_DROP;
    }
    if (!g_strcmp0(type, "gst.gl.app_context")) {
        GstContext *ctx = gst_context_new("gst.gl.app_context", TRUE);
        GstStructure *s = gst_context_writable_structure(ctx);
        gst_structure_set(s, "context", GST_TYPE_GL_CONTEXT, gst_app_ctx, NULL);
        gst_element_set_context(src, ctx);
        gst_context_unref(ctx);
        gst_message_unref(msg);
        return GST_BUS_DROP;
    }
    return GST_BUS_PASS;
}

/* Pulls whatever the appsink has ready, non-blocking -- called once per
   render frame, same spot mpv_render_context_render used to occupy. */
static void video_pump(void) {
    if (!appsink) return;
    GstSample *s = gst_app_sink_try_pull_sample(GST_APP_SINK(appsink), 0);
    if (!s) return;
    if (cur_sample) gst_sample_unref(cur_sample);
    cur_sample = s;

    GstBuffer *buf = gst_sample_get_buffer(s);
    /* The upload/colour-convert that produced this texture ran on
       GStreamer's own internal GL thread/context, and GL commands are
       only ordered *within* a context -- without an explicit wait here,
       sampling this texture from our context races the write that fills
       it, and can show stale (recycled-pool) content instead of erroring. */
    GstGLSyncMeta *sync_meta = buf ? gst_buffer_get_gl_sync_meta(buf) : NULL;
    if (sync_meta) gst_gl_sync_meta_wait(sync_meta, gst_app_ctx);
    GstMemory *mem = buf ? gst_buffer_peek_memory(buf, 0) : NULL;
    if (mem && gst_is_gl_memory(mem)) {
        cur_tex = ((GstGLMemory *)mem)->tex_id;
    }
    GstCaps *caps = gst_sample_get_caps(s);
    GstVideoInfo vinfo;
    if (caps && gst_video_info_from_caps(&vinfo, caps)) {
        cur_tex_w = vinfo.width;
        cur_tex_h = vinfo.height;
        if (vinfo.fps_n > 0 && vinfo.fps_d > 0)
            last_known_fps = (double)vinfo.fps_n / vinfo.fps_d;
    }
}

/* Bus messages that affect playback state, drained alongside video_pump().
   EOS is where loop-file is actually implemented: mpv's own "loop-file=inf"
   restarts the same file internally, so we replicate that with a seek back
   to zero rather than a fresh loadfile. */
static void bus_pump(void) {
    GstBus *bus = gst_element_get_bus(playbin);
    GstMessage *msg;
    while ((msg = gst_bus_pop_filtered(bus, GST_MESSAGE_EOS | GST_MESSAGE_ERROR | GST_MESSAGE_WARNING))) {
        if (GST_MESSAGE_TYPE(msg) == GST_MESSAGE_EOS) {
            pthread_mutex_lock(&play_lock);
            bool loop = loop_enabled;
            pthread_mutex_unlock(&play_lock);
            if (loop) {
                gst_element_seek_simple(playbin, GST_FORMAT_TIME,
                                         GST_SEEK_FLAG_FLUSH | GST_SEEK_FLAG_KEY_UNIT, 0);
                gst_element_set_state(playbin, GST_STATE_PLAYING);
            } else {
                /* mirrors mpv's keep-open=yes: pause on the last frame
                   rather than going idle */
                gst_element_set_state(playbin, GST_STATE_PAUSED);
            }
        } else if (GST_MESSAGE_TYPE(msg) == GST_MESSAGE_ERROR) {
            GError *err = NULL; gchar *dbg = NULL;
            gst_message_parse_error(msg, &err, &dbg);
            fprintf(stderr, "[gst:error] %s (%s)\n", err ? err->message : "?", dbg ? dbg : "");
            if (err) g_error_free(err);
            g_free(dbg);
        } else {
            GError *err = NULL; gchar *dbg = NULL;
            gst_message_parse_warning(msg, &err, &dbg);
            fprintf(stderr, "[gst:warn] %s (%s)\n", err ? err->message : "?", dbg ? dbg : "");
            if (err) g_error_free(err);
            g_free(dbg);
        }
        gst_message_unref(msg);
    }
    gst_object_unref(bus);
}

static void video_pipeline_init(void) {
    gst_display = GST_GL_DISPLAY(gst_gl_display_egl_new_with_egl_display(egl_dpy));
    gst_app_ctx = gst_gl_context_new_wrapped(gst_display, (guintptr)egl_ctx,
                                              GST_GL_PLATFORM_EGL, GST_GL_API_GLES2);
    /* A wrapped context has to be activated on the thread that actually
       owns the underlying EGL context (this one, via egl_init()'s
       eglMakeCurrent) before any GStreamer GL element touches it --
       otherwise gst_gl_context_thread_add() has no active_thread recorded
       and asserts on every call from the streaming thread. fill_info then
       queries GL_VERSION/extensions now that the context is current. */
    CHECK(gst_gl_context_activate(gst_app_ctx, TRUE), "gst_gl_context_activate");
    GError *gl_err = NULL;
    if (!gst_gl_context_fill_info(gst_app_ctx, &gl_err)) {
        fprintf(stderr, "gst_gl_context_fill_info: %s\n", gl_err ? gl_err->message : "?");
        if (gl_err) g_error_free(gl_err);
    }

    playbin = gst_element_factory_make("playbin3", "playbin");
    if (!playbin) playbin = gst_element_factory_make("playbin", "playbin");
    CHECK(playbin, "gst playbin");

    GstElement *sinkbin = gst_element_factory_make("glsinkbin", "glsink");
    CHECK(sinkbin, "gst glsinkbin");
    appsink = gst_element_factory_make("appsink", "vsink");
    CHECK(appsink, "gst appsink");
    /* texture-target pinned to 2D: without this, glupload is free to pick
       whichever uploader it likes, and for some sources (confirmed via
       GST_DEBUG on a file with B-frames + audio) it silently prefers
       DirectDmabufExternal, producing an external-oes texture instead of
       a plain 2D one. Our shader samples with a plain sampler2D bound via
       GL_TEXTURE_2D; binding an external-oes texture object to that target
       is invalid and just leaves whatever was previously bound there --
       which looked exactly like playback being stuck on the last real
       frame, when the pipeline itself was decoding fine the whole time. */
    GstCaps *caps = gst_caps_from_string(
        "video/x-raw(memory:GLMemory),format=RGBA,texture-target=2D");
    g_object_set(appsink, "caps", caps, "sync", TRUE, "max-buffers", 2, "drop", TRUE, NULL);
    gst_caps_unref(caps);
    g_object_set(sinkbin, "sink", appsink, NULL);

    g_object_set(playbin, "video-sink", sinkbin, NULL);
    /* No audio device is configured on this headless Pi (no PipeWire/ALSA
       session for a systemd-launched process) -- autoaudiosink picks
       OpenAL, which fails to open a device, and that preroll failure was
       killing the *whole* pipeline (video included) on any clip that
       actually carries an audio track. This display never needs audio
       output, so route it to fakesink unconditionally rather than let
       sink auto-selection be a single point of failure for playback. */
    g_object_set(playbin, "audio-sink", gst_element_factory_make("fakesink", "asink"), NULL);

    GstBus *bus = gst_element_get_bus(playbin);
    gst_bus_set_sync_handler(bus, bus_sync_handler, NULL, NULL);
    gst_object_unref(bus);
}

static void video_load(const char *path, double start_sec) {
    /* Stopping playbin unconditionally, even for a still image, matters:
       without it a real video already playing when the idle image loads
       would keep decoding (and showing, until superseded) underneath it. */
    gst_element_set_state(playbin, GST_STATE_NULL);

    if (path_is_still_image(path)) {
        pthread_mutex_lock(&play_lock);
        snprintf(pending_image_path, sizeof pending_image_path, "%s", path);
        have_pending_image = true;
        showing_still_image = true;
        idle_active = false;   /* something is loaded, transport-wise */
        pthread_mutex_unlock(&play_lock);
        printf("[img] loadfile %s (deferred to render thread)\n", path);
        return;
    }
    pthread_mutex_lock(&play_lock);
    showing_still_image = false;
    pthread_mutex_unlock(&play_lock);

    char uri[2048];
    if (strstr(path, "://")) snprintf(uri, sizeof uri, "%s", path);
    else {
        gchar *u = gst_filename_to_uri(path, NULL);
        snprintf(uri, sizeof uri, "%s", u ? u : path);
        g_free(u);
    }
    g_object_set(playbin, "uri", uri, NULL);
    g_object_set(playbin, "mute", FALSE, "volume", volume_pct / 100.0, NULL);
    pthread_mutex_lock(&play_lock);
    pending_start = start_sec;
    have_pending_start = start_sec > 0;
    idle_active = false;
    pthread_mutex_unlock(&play_lock);
    gst_element_set_state(playbin, GST_STATE_PLAYING);
    printf("[gst] loadfile %s (start=%.2f)\n", path, start_sec);
}

static void video_apply_pending_start(void) {
    bool pending;
    double start;
    pthread_mutex_lock(&play_lock);
    pending = have_pending_start;
    start = pending_start;
    if (pending) have_pending_start = false;
    pthread_mutex_unlock(&play_lock);
    if (!pending) return;
    GstState state;
    gst_element_get_state(playbin, &state, NULL, 0);
    if (state >= GST_STATE_PAUSED)
        gst_element_seek_simple(playbin, GST_FORMAT_TIME,
                                 GST_SEEK_FLAG_FLUSH | GST_SEEK_FLAG_KEY_UNIT,
                                 (gint64)(start * GST_SECOND));
}

static bool video_get_pause(void) {
    GstState state;
    gst_element_get_state(playbin, &state, NULL, 0);
    return state == GST_STATE_PAUSED;
}

static void video_set_pause(bool pause) {
    gst_element_set_state(playbin, pause ? GST_STATE_PAUSED : GST_STATE_PLAYING);
}

/* Querying playbin's own position reflects the pipeline's read-ahead --
   decodebin's internal queues buffer up to ~1-2s of local file content by
   default, so during PLAYING this can report a position noticeably ahead
   of whatever's actually been decoded and is on screen. cur_sample is the
   actual frame video_pump() last pulled off the appsink and handed to the
   renderer, so its buffer timestamp is exactly what's currently on
   screen, immune to upstream buffering -- used here to fix the dock's
   position suddenly jumping backward a couple of seconds the instant
   playback paused (revealing how far the pipeline had actually read
   ahead of what was on screen).

   PAUSED is the opposite case: appsink's regular pull only hands back
   *new* samples delivered during PLAYING, not the single buffer GStreamer
   preroll-decodes to complete a paused seek, so cur_sample goes stale and
   stops updating the moment something pauses -- exactly the state
   frame-stepping lives in. The plain pipeline query is accurate here,
   though: preroll guarantees the sink is holding precisely the buffer
   the seek landed on by the time the state change completes. */
static double video_get_position(void) {
    if (!video_get_pause() && cur_sample) {
        GstBuffer *buf = gst_sample_get_buffer(cur_sample);
        if (buf && GST_BUFFER_PTS_IS_VALID(buf)) {
            const GstSegment *seg = gst_sample_get_segment(cur_sample);
            GstClockTime stream_time = seg
                ? gst_segment_to_stream_time(seg, GST_FORMAT_TIME, GST_BUFFER_PTS(buf))
                : GST_BUFFER_PTS(buf);
            if (GST_CLOCK_TIME_IS_VALID(stream_time))
                return (double)stream_time / GST_SECOND;
        }
    }
    gint64 pos = 0;
    if (!gst_element_query_position(playbin, GST_FORMAT_TIME, &pos)) return 0;
    return (double)pos / GST_SECOND;
}

static double video_get_duration(void) {
    gint64 dur = 0;
    if (!gst_element_query_duration(playbin, GST_FORMAT_TIME, &dur)) return 0;
    return (double)dur / GST_SECOND;
}

static void video_seek(double sec) {
    gst_element_seek_simple(playbin, GST_FORMAT_TIME,
                             GST_SEEK_FLAG_FLUSH | GST_SEEK_FLAG_KEY_UNIT,
                             (gint64)(sec * GST_SECOND));
}

/* KEY_UNIT above snaps to "the keyframe at or before" the target -- fine
   (and fast) for scrub-bar dragging, but its notion of "nearest" comes from
   the demuxer's own seek index, which isn't guaranteed to be frame-exact,
   and compounds badly across repeated single-frame nudges. ACCURATE instead
   decodes forward from the preceding keyframe to land exactly on the
   requested time -- normally too expensive to use for every seek on a
   long-GOP file, but a single-frame nudge is only ever at most one GOP away
   regardless, so the cost is the same as KEY_UNIT in practice. Used only by
   video_frame_back_step. */
static void video_seek_accurate(double sec) {
    gst_element_seek_simple(playbin, GST_FORMAT_TIME,
                             GST_SEEK_FLAG_FLUSH | GST_SEEK_FLAG_ACCURATE,
                             (gint64)(sec * GST_SECOND));
}

static void video_stop(void) {
    gst_element_set_state(playbin, GST_STATE_READY);
    pthread_mutex_lock(&play_lock);
    idle_active = true;
    pthread_mutex_unlock(&play_lock);
}

/* Exact single-frame stepping (forward) is a real GStreamer primitive.
   Backward isn't -- there's no equivalent "step -1" for a hardware decoder
   pulling from a compressed stream, so this approximates it with a seek to
   one nominal frame duration earlier while paused. Good enough for the
   scrub-by-frame UI this backs; not frame-exact on every codec/GOP. */
static void video_frame_step(void) {
    gst_element_set_state(playbin, GST_STATE_PAUSED);
    gst_element_get_state(playbin, NULL, NULL, GST_CLOCK_TIME_NONE);
    gst_element_send_event(playbin, gst_event_new_step(GST_FORMAT_BUFFERS, 1, 1.0, TRUE, FALSE));
}

static void video_frame_back_step(void) {
    gst_element_set_state(playbin, GST_STATE_PAUSED);
    gst_element_get_state(playbin, NULL, NULL, GST_CLOCK_TIME_NONE);
    double pos = video_get_position();
    double fps = last_known_fps > 0 ? last_known_fps : 24.0;
    /* Round to the nearest frame boundary before stepping back, not just
       pos - 1/fps -- pos itself is a queried float that can sit a hair off
       true frame boundaries, and that error would otherwise compound with
       every repeated press. */
    double frame_idx = round(pos * fps);
    double target = (frame_idx > 0 ? frame_idx - 1 : 0) / fps;
    video_seek_accurate(target);
}

static double video_estimated_frame_number(void) {
    return video_get_position() * (last_known_fps > 0 ? last_known_fps : 24.0);
}

/* ================================================================ IPC == */

/* Speaks a compatible subset of mpv's JSON-line IPC protocol -- just enough
   for server.py's mpv_send(): one command object per line, one JSON-line
   reply, connection then closed by the client. No request_id matching or
   event stream is needed because server.py never asks for either. */

static void ipc_reply(int fd, const char *data_json /* NULL = null */) {
    char buf[256];
    int n = snprintf(buf, sizeof buf, "{\"data\":%s,\"error\":\"success\"}\n",
                      data_json ? data_json : "null");
    write(fd, buf, n);
}

static int parse_command_args(const char *line, char *tokens[8], int max) {
    const char *p = strstr(line, "\"command\"");
    if (!p) return 0;
    p = strchr(p, '[');
    if (!p) return 0;
    p++;
    int n = 0;
    while (*p && *p != ']' && n < max) {
        while (*p == ' ' || *p == ',') p++;
        if (*p == '"') {
            p++;
            const char *start = p;
            while (*p && *p != '"') p++;
            tokens[n++] = strndup(start, (size_t)(p - start));
            if (*p == '"') p++;
        } else if (*p != ']' && *p) {
            const char *start = p;
            while (*p && *p != ',' && *p != ']') p++;
            tokens[n++] = strndup(start, (size_t)(p - start));
        } else break;
    }
    return n;
}

static bool truthy(const char *s) {
    return s && (!strcmp(s, "yes") || !strcmp(s, "true") || !strcmp(s, "1"));
}

static void *ipc_client_thread(void *arg) {
    int fd = (int)(intptr_t)arg;
    char buf[4096];
    ssize_t n = read(fd, buf, sizeof buf - 1);
    if (n <= 0) { close(fd); return NULL; }
    buf[n] = 0;
    char *nl = strchr(buf, '\n');
    if (nl) *nl = 0;

    char *tok[8] = {0};
    int argc = parse_command_args(buf, tok, 8);
    if (argc == 0) { ipc_reply(fd, NULL); close(fd); goto done; }

    char out[128];
    if (!strcmp(tok[0], "get_property") && argc >= 2) {
        const char *name = tok[1];
        if (!strcmp(name, "time-pos")) {
            snprintf(out, sizeof out, "%.3f", video_get_position());
            ipc_reply(fd, out);
        } else if (!strcmp(name, "duration")) {
            snprintf(out, sizeof out, "%.3f", video_get_duration());
            ipc_reply(fd, out);
        } else if (!strcmp(name, "pause")) {
            ipc_reply(fd, video_get_pause() ? "true" : "false");
        } else if (!strcmp(name, "idle-active")) {
            pthread_mutex_lock(&play_lock);
            bool ia = idle_active;
            pthread_mutex_unlock(&play_lock);
            ipc_reply(fd, ia ? "true" : "false");
        } else if (!strcmp(name, "loop-file")) {
            pthread_mutex_lock(&play_lock);
            bool lp = loop_enabled;
            pthread_mutex_unlock(&play_lock);
            ipc_reply(fd, lp ? "\"inf\"" : "\"no\"");
        } else if (!strcmp(name, "estimated-frame-number")) {
            snprintf(out, sizeof out, "%.0f", video_estimated_frame_number());
            ipc_reply(fd, out);
        } else {
            ipc_reply(fd, NULL);
        }
    } else if (!strcmp(tok[0], "set_property") && argc >= 3) {
        const char *name = tok[1], *val = tok[2];
        if (!strcmp(name, "loop-file")) {
            pthread_mutex_lock(&play_lock);
            loop_enabled = !strcmp(val, "inf");
            pthread_mutex_unlock(&play_lock);
        } else if (!strcmp(name, "mute")) {
            g_object_set(playbin, "mute", truthy(val), NULL);
        } else if (!strcmp(name, "pause")) {
            video_set_pause(truthy(val));
        } else if (!strcmp(name, "start")) {
            pthread_mutex_lock(&play_lock);
            pending_start = atof(val);
            have_pending_start = pending_start > 0;
            pthread_mutex_unlock(&play_lock);
        }
        /* image-display-duration / keep-open: no native GStreamer/playbin
           equivalent is needed -- keep-open's "pause on end" behaviour is
           already how bus_pump() handles EOS unconditionally. */
        ipc_reply(fd, NULL);
    } else if (!strcmp(tok[0], "loadfile") && argc >= 2) {
        pthread_mutex_lock(&play_lock);
        double start = pending_start;
        pthread_mutex_unlock(&play_lock);
        video_load(tok[1], start);
        ipc_reply(fd, NULL);
    } else if (!strcmp(tok[0], "cycle") && argc >= 2 && !strcmp(tok[1], "pause")) {
        video_set_pause(!video_get_pause());
        ipc_reply(fd, NULL);
    } else if (!strcmp(tok[0], "stop")) {
        video_stop();
        ipc_reply(fd, NULL);
    } else if (!strcmp(tok[0], "seek") && argc >= 2) {
        video_seek(atof(tok[1]));
        ipc_reply(fd, NULL);
    } else if (!strcmp(tok[0], "frame-step")) {
        video_frame_step();
        ipc_reply(fd, NULL);
    } else if (!strcmp(tok[0], "frame-back-step")) {
        video_frame_back_step();
        ipc_reply(fd, NULL);
    } else if (!strcmp(tok[0], "cycle-values") && argc >= 2 && !strcmp(tok[1], "loop-file")) {
        pthread_mutex_lock(&play_lock);
        loop_enabled = !loop_enabled;
        pthread_mutex_unlock(&play_lock);
        ipc_reply(fd, NULL);
    } else if (!strcmp(tok[0], "add") && argc >= 3 && !strcmp(tok[1], "volume")) {
        pthread_mutex_lock(&play_lock);
        volume_pct += atof(tok[2]);
        if (volume_pct < 0) volume_pct = 0;
        if (volume_pct > 100) volume_pct = 100;
        double v = volume_pct;
        pthread_mutex_unlock(&play_lock);
        g_object_set(playbin, "volume", v / 100.0, NULL);
        ipc_reply(fd, NULL);
    } else {
        ipc_reply(fd, NULL);
    }

    for (int i = 0; i < argc; i++) free(tok[i]);
done:
    close(fd);
    return NULL;
}

static void *ipc_server_thread(void *arg) {
    const char *sockpath = arg;
    unlink(sockpath);
    int srv = socket(AF_UNIX, SOCK_STREAM, 0);
    CHECK(srv >= 0, "ipc socket");
    struct sockaddr_un addr = { .sun_family = AF_UNIX };
    snprintf(addr.sun_path, sizeof addr.sun_path, "%s", sockpath);
    CHECK(bind(srv, (struct sockaddr *)&addr, sizeof addr) == 0, "ipc bind");
    CHECK(listen(srv, 16) == 0, "ipc listen");
    chmod(sockpath, 0777);
    printf("[ipc] ready, socket %s\n", sockpath);
    while (running) {
        int fd = accept(srv, NULL, NULL);
        if (fd < 0) { if (errno == EINTR) continue; break; }
        pthread_t th;
        pthread_create(&th, NULL, ipc_client_thread, (void *)(intptr_t)fd);
        pthread_detach(th);
    }
    close(srv);
    return NULL;
}

/* ================================================================= main == */

int main(void) {
    /* stdout is a pipe to journald under systemd, not a tty, so libc
       defaults to full buffering -- without this, log lines sit
       unflushed for minutes rather than appearing as they happen. */
    setvbuf(stdout, NULL, _IOLBF, 0);
    setvbuf(stderr, NULL, _IOLBF, 0);
    const char *card    = getenv("ZEALANDATA_DRM_CARD");
    const char *objpath = getenv("ZEALANDATA_PROJECTION_OBJ");
    const char *sockpath= getenv("ZEALANDATA_MPV_SOCKET");
    const char *mapfile = getenv("ZEALANDATA_MAPPING_FILE");
    const char *idleimg = getenv("ZEALANDATA_LOADING_IMAGE");
    if (!card)     card = "/dev/dri/card1";
    if (!objpath)  objpath = "/home/pj/zealandata/static/3dPrint_210kFaces.obj";
    if (!sockpath) sockpath = "/tmp/zealandata-mpv.sock";
    if (mapfile)   mapping_path = mapfile;

    signal(SIGINT, on_signal);
    signal(SIGTERM, on_signal);

    if (!drm_init(card)) return 1;
    if (!egl_init()) return 1;
    if (!load_obj(objpath)) return 1;
    mapping_reload();

    /* ---- GL objects ---- */
    GLuint vao, vbo_p, vbo_n, ibo;
    glGenVertexArrays(1, &vao); glBindVertexArray(vao);
    glGenBuffers(1, &vbo_p); glBindBuffer(GL_ARRAY_BUFFER, vbo_p);
    glBufferData(GL_ARRAY_BUFFER, m_nvert * sizeof(vec3), m_pos, GL_STATIC_DRAW);
    glEnableVertexAttribArray(0); glVertexAttribPointer(0, 3, GL_FLOAT, GL_FALSE, 0, 0);
    glGenBuffers(1, &vbo_n); glBindBuffer(GL_ARRAY_BUFFER, vbo_n);
    glBufferData(GL_ARRAY_BUFFER, m_nvert * sizeof(vec3), m_nrm, GL_STATIC_DRAW);
    glEnableVertexAttribArray(1); glVertexAttribPointer(1, 3, GL_FLOAT, GL_FALSE, 0, 0);
    glGenBuffers(1, &ibo); glBindBuffer(GL_ELEMENT_ARRAY_BUFFER, ibo);
    glBufferData(GL_ELEMENT_ARRAY_BUFFER, m_nidx * sizeof(unsigned), m_idx, GL_STATIC_DRAW);

    GLuint prog = glCreateProgram();
    glAttachShader(prog, compile_shader(GL_VERTEX_SHADER, VS_SRC));
    glAttachShader(prog, compile_shader(GL_FRAGMENT_SHADER, FS_SRC));
    glLinkProgram(prog);
    GLint linked = 0; glGetProgramiv(prog, GL_LINK_STATUS, &linked);
    if (!linked) { char log[2048]; glGetProgramInfoLog(prog, sizeof log, NULL, log);
                   fprintf(stderr, "link: %s\n", log); return 1; }
    glUseProgram(prog);
    GLint uMVP = glGetUniformLocation(prog, "uMVP");
    GLint uModel = glGetUniformLocation(prog, "uModel");
    GLint uModelSize = glGetUniformLocation(prog, "uModelSize");
    GLint uVidRotation = glGetUniformLocation(prog, "uVidRotation");
    GLint uVidFlipH = glGetUniformLocation(prog, "uVidFlipH");
    GLint uVidFlipV = glGetUniformLocation(prog, "uVidFlipV");
    GLint uShading = glGetUniformLocation(prog, "uShading");
    GLint uVideoEdgeLT = glGetUniformLocation(prog, "uVideoEdgeLT");
    GLint uVideoEdgeRB = glGetUniformLocation(prog, "uVideoEdgeRB");
    glUniform1i(glGetUniformLocation(prog, "uTex"), 0);

    /* ---- keystone warp pass: scene render target + its own quad ---- */
    GLuint warpProg = glCreateProgram();
    glAttachShader(warpProg, compile_shader(GL_VERTEX_SHADER, WARP_VS_SRC));
    glAttachShader(warpProg, compile_shader(GL_FRAGMENT_SHADER, WARP_FS_SRC));
    glLinkProgram(warpProg);
    GLint warpLinked = 0; glGetProgramiv(warpProg, GL_LINK_STATUS, &warpLinked);
    if (!warpLinked) { char log[2048]; glGetProgramInfoLog(warpProg, sizeof log, NULL, log);
                        fprintf(stderr, "warp link: %s\n", log); return 1; }
    glUseProgram(warpProg);
    glUniform1i(glGetUniformLocation(warpProg, "uSceneTex"), 0);
    glUseProgram(prog);

    GLuint warpVao, warpVbo, warpIbo;
    glGenVertexArrays(1, &warpVao); glBindVertexArray(warpVao);
    glGenBuffers(1, &warpVbo); glBindBuffer(GL_ARRAY_BUFFER, warpVbo);
    /* 4 corners * (x,y,w, u,v) -- rewritten every frame from the keystone
       homography, so GL_DYNAMIC_DRAW rather than STATIC. */
    glBufferData(GL_ARRAY_BUFFER, 4 * 5 * sizeof(float), NULL, GL_DYNAMIC_DRAW);
    glEnableVertexAttribArray(0);
    glVertexAttribPointer(0, 3, GL_FLOAT, GL_FALSE, 5 * sizeof(float), (void *)0);
    glEnableVertexAttribArray(1);
    glVertexAttribPointer(1, 2, GL_FLOAT, GL_FALSE, 5 * sizeof(float), (void *)(3 * sizeof(float)));
    static const unsigned warpIdx[6] = { 0, 1, 2, 0, 2, 3 };
    glGenBuffers(1, &warpIbo); glBindBuffer(GL_ELEMENT_ARRAY_BUFFER, warpIbo);
    glBufferData(GL_ELEMENT_ARRAY_BUFFER, sizeof warpIdx, warpIdx, GL_STATIC_DRAW);

    /* ---- calibration gizmo: ring program + static ring geometry ---- */
    GLuint gizmoProg = glCreateProgram();
    glAttachShader(gizmoProg, compile_shader(GL_VERTEX_SHADER, GIZMO_VS_SRC));
    glAttachShader(gizmoProg, compile_shader(GL_FRAGMENT_SHADER, GIZMO_FS_SRC));
    glLinkProgram(gizmoProg);
    GLint gizmoLinked = 0; glGetProgramiv(gizmoProg, GL_LINK_STATUS, &gizmoLinked);
    if (!gizmoLinked) { char log[2048]; glGetProgramInfoLog(gizmoProg, sizeof log, NULL, log);
                         fprintf(stderr, "gizmo link: %s\n", log); return 1; }
    GLint uGizmoMVP = glGetUniformLocation(gizmoProg, "uMVP");

    GLuint gizmoVao, gizmoVbo;
    glGenVertexArrays(1, &gizmoVao); glBindVertexArray(gizmoVao);
    glGenBuffers(1, &gizmoVbo); glBindBuffer(GL_ARRAY_BUFFER, gizmoVbo);
    gizmo_vert ringVerts[3 * GIZMO_SEGMENTS];
    build_gizmo_rings(ringVerts);
    glBufferData(GL_ARRAY_BUFFER, sizeof ringVerts, ringVerts, GL_STATIC_DRAW);
    glEnableVertexAttribArray(0);
    glVertexAttribPointer(0, 3, GL_FLOAT, GL_FALSE, sizeof(gizmo_vert), (void *)0);
    glEnableVertexAttribArray(1);
    glVertexAttribPointer(1, 3, GL_FLOAT, GL_FALSE, sizeof(gizmo_vert), (void *)(3 * sizeof(float)));

    /* ---- calibration gizmo: label program + dynamic per-frame geometry --- */
    GLuint labelProg = glCreateProgram();
    glAttachShader(labelProg, compile_shader(GL_VERTEX_SHADER, GIZMO_LABEL_VS_SRC));
    glAttachShader(labelProg, compile_shader(GL_FRAGMENT_SHADER, GIZMO_FS_SRC));
    glLinkProgram(labelProg);
    GLint labelLinked = 0; glGetProgramiv(labelProg, GL_LINK_STATUS, &labelLinked);
    if (!labelLinked) { char log[2048]; glGetProgramInfoLog(labelProg, sizeof log, NULL, log);
                         fprintf(stderr, "gizmo label link: %s\n", log); return 1; }

    GLuint labelVao, labelVbo;
    glGenVertexArrays(1, &labelVao); glBindVertexArray(labelVao);
    glGenBuffers(1, &labelVbo); glBindBuffer(GL_ARRAY_BUFFER, labelVbo);
    /* Shared by the gizmo's X/Y/Z labels and the frame-rate readout --
       only one of them uploads at a time, so the buffer just has to be as
       big as the larger of the two. */
    glBufferData(GL_ARRAY_BUFFER,
                 (GIZMO_LABEL_MAX_VERTS > HUD_MAX_VERTS ? GIZMO_LABEL_MAX_VERTS : HUD_MAX_VERTS)
                     * sizeof(label_vert), NULL, GL_DYNAMIC_DRAW);
    glEnableVertexAttribArray(0);
    glVertexAttribPointer(0, 2, GL_FLOAT, GL_FALSE, sizeof(label_vert), (void *)0);
    glEnableVertexAttribArray(1);
    glVertexAttribPointer(1, 3, GL_FLOAT, GL_FALSE, sizeof(label_vert), (void *)(2 * sizeof(float)));

    glBindVertexArray(vao);   /* leave the model's VAO bound, matching prior behaviour */

    /* Scene is now always rendered off-screen (previously only when
       render_scale < 1) since the warp pass needs a texture to draw from
       either way -- direct-to-display is no longer a code path. */
    GLuint sceneFbo = 0, sceneTex = 0, sceneDepth = 0;
    int sceneW = 0, sceneH = 0;

    /* ---- calibration test pattern: an odd-sized checkerboard, so opposite
       corners always share a color (sum-of-indices parity) and all four
       land on white -- lets orientation/mirroring be read at a glance
       without depending on real video content. */
    bool test_pattern = getenv("ZEALANDATA_TEST_PATTERN") != NULL;
    GLuint checkerTex = 0;
    if (test_pattern) {
        const int N = 9, CELL = 32, DIM = N * CELL;
        unsigned char *px = malloc((size_t)DIM * DIM * 4);
        for (int y = 0; y < DIM; y++)
            for (int x = 0; x < DIM; x++) {
                int cx = x / CELL, cy = y / CELL;
                unsigned char v = ((cx + cy) % 2 == 0) ? 200 : 80;
                unsigned char *p = &px[(y * DIM + x) * 4];
                p[0] = p[1] = p[2] = v; p[3] = 255;
            }
        glGenTextures(1, &checkerTex);
        glBindTexture(GL_TEXTURE_2D, checkerTex);
        glTexImage2D(GL_TEXTURE_2D, 0, GL_RGBA8, DIM, DIM, 0, GL_RGBA, GL_UNSIGNED_BYTE, px);
        glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MIN_FILTER, GL_LINEAR);
        glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MAG_FILTER, GL_LINEAR);
        glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_WRAP_S, GL_CLAMP_TO_EDGE);
        glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_WRAP_T, GL_CLAMP_TO_EDGE);
        free(px);
        printf("[cal] test pattern active (checkerboard, all corners white)\n");
    }

    /* ---- GStreamer ---- */
    gst_init(NULL, NULL);
    video_pipeline_init();
    printf("[gst] ready\n");

    pthread_t ipc_th;
    pthread_create(&ipc_th, NULL, ipc_server_thread, (void *)sockpath);

    if (idleimg && *idleimg) video_load(idleimg, 0);

    /* ---- render loop ---- */
    double last_cal = 0, last_fps = now_sec();
    /* Separate from the 5-second logging window above: the on-screen
       readout needs to react while someone is watching it, but averaging
       over a short window is what stops it flickering between two numbers
       every frame. */
    double hud_last = now_sec(), hud_fps = 0;
    int hud_frames = 0;
    int frames = 0;
    /* Per-phase timing: with a vsync-locked flip it's otherwise impossible
       to tell "the GPU is busy" from "we're being paced", and those want
       opposite fixes. */
    double acc_video = 0, acc_draw = 0, acc_present = 0;
    while (running) {
        /* calibration is polled rather than watched: one stat() per 30ms is
           nothing next to a frame, and it avoids an inotify dependency */
        double t = now_sec();
        if (t - last_cal > 0.03) { mapping_reload(); last_cal = t; }

        double tA = now_sec();
        bus_pump();
        video_apply_pending_start();
        video_pump();
        {
            /* Consuming the still-image request here rather than in
               video_load() itself: the decode + glTexImage2D upload below
               needs the EGL context this (main) thread made current. */
            char img[sizeof pending_image_path];
            bool need_img;
            pthread_mutex_lock(&play_lock);
            need_img = have_pending_image;
            if (need_img) { snprintf(img, sizeof img, "%s", pending_image_path); have_pending_image = false; }
            pthread_mutex_unlock(&play_lock);
            if (need_img) load_idle_image_now(img);
        }
        acc_video += now_sec() - tA;


        /* Scene target sized by render_scale, always -- the warp pass below
           needs a texture to draw from regardless of scale, so unlike
           before there's no direct-to-display shortcut at scale 1.0
           anymore (that shortcut existed only to skip an otherwise-
           pointless full-resolution blit). */
        int wantW = (int)(drm.mode.hdisplay * map_cur.render_scale);
        int wantH = (int)(drm.mode.vdisplay * map_cur.render_scale);
        if (wantW < 16) wantW = 16;
        if (wantH < 16) wantH = 16;
        if (wantW != sceneW || wantH != sceneH) {
            sceneW = wantW; sceneH = wantH;
            if (!sceneFbo) { glGenFramebuffers(1, &sceneFbo); glGenTextures(1, &sceneTex); glGenRenderbuffers(1, &sceneDepth); }
            glBindTexture(GL_TEXTURE_2D, sceneTex);
            glTexImage2D(GL_TEXTURE_2D, 0, GL_RGBA8, sceneW, sceneH, 0, GL_RGBA, GL_UNSIGNED_BYTE, NULL);
            glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MIN_FILTER, GL_LINEAR);
            glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MAG_FILTER, GL_LINEAR);
            glBindRenderbuffer(GL_RENDERBUFFER, sceneDepth);
            glRenderbufferStorage(GL_RENDERBUFFER, GL_DEPTH_COMPONENT16, sceneW, sceneH);
            glBindFramebuffer(GL_FRAMEBUFFER, sceneFbo);
            glFramebufferTexture2D(GL_FRAMEBUFFER, GL_COLOR_ATTACHMENT0, GL_TEXTURE_2D, sceneTex, 0);
            glFramebufferRenderbuffer(GL_FRAMEBUFFER, GL_DEPTH_ATTACHMENT, GL_RENDERBUFFER, sceneDepth);
            glBindFramebuffer(GL_FRAMEBUFFER, 0);
            printf("[gl ] scene target %dx%d (render_scale %.2f)\n", sceneW, sceneH, map_cur.render_scale);
        }

        /* ---- transform: calibration only -- the model's own fixed OBJ-
           axis quirk is baked into the stored vertex data now (see
           load_obj), so there is no separate base-orientation matrix to
           apply here any more. ---- */
        mat4 mRx, mRy, mRz, mS, mT, tmp, model, proj, mvp;
        mat_rot_x(mRx, map_cur.rot_x * (float)M_PI / 180.f);
        mat_rot_y(mRy, map_cur.rot_y * (float)M_PI / 180.f);
        mat_rot_z(mRz, map_cur.rot_z * (float)M_PI / 180.f);
        mat_scale(mS, map_cur.scale * SCALE_BASELINE);
        mat_translate(mT, map_cur.off_x, map_cur.off_y, 0);

        /* rotation_z applied innermost (before x/y) so it spins the
           model's own current up-axis -- what an operator reads as "turn
           the print" -- rather than the camera's fixed view axis. Applying
           it last (outermost, as this used to) instead rotates the
           *already x/y-tilted* result about the camera's own axis
           regardless of that tilt, which looks like the picture spinning
           in place rather than the model turning -- exactly the "z
           rotation looks pinned to the camera, not the model" report this
           reordering fixes. rotation_x/y stay outermost: they exist to
           correct the projector's own perpendicularity relative to the
           screen, which is inherently a camera-relative correction. */
        mat_mul(tmp, mRy, mRz);
        mat_mul(tmp, mRx, tmp);
        mat_mul(tmp, mS, tmp);
        mat_mul(model, mT, tmp);

        float half = 1.15f;            /* padding around the fitted model */
        float aspect = (float)wantW / (float)wantH;
        /* A real projector is a point light at a finite distance, not the
           parallel "sunlight" mat_ortho assumed -- that was fine for a flat
           screen but drifted increasingly with the model's own elevation,
           which is exactly the misalignment this replaces. Scaling the near
           plane's bounds by (near/throw_dist) keeps the framing at the
           model's own depth (z=0) matching the old ortho half-extents
           exactly as throw_dist grows large, so existing calibrations don't
           jump when this is first dialled in from a big value. */
        float throwDist = map_cur.throw_dist;
        float near = 0.05f, far = throwDist + 20.f;
        float halfY = half;
        float halfX = half * aspect;
        float ratio = near / throwDist;
        /* Lateral projector position needs BOTH halves of a proper off-
           axis ("lens-shift") projection together, not either alone --
           see server.py's MAPPING_NUMERIC comment on "throw_offset_x/y":
           1) Translate into the eye's real off-axis position (below) --
              this alone gives correct ray angles but a symmetric frustum
              then renders the model off-centre, since nothing re-centres
              the picture: reported directly as "should only change ray
              angles... rather than shifting the image".
           2) Shear the frustum to match (here) -- this alone re-centres
              the picture, but with the eye still at the un-translated
              origin the "shear" is just a uniform screen-space pan with
              no depth-dependent effect at all -- same symptom, worse:
              looks like nothing changed until the pan is big enough to
              notice, at which point it's still just a pan.
           Together, a point at the model's own reference depth (z=0)
           keeps mapping to exactly the same NDC regardless of the offset
           (the translation's shift and the frustum's shear cancel there
           by construction -- see the near-plane bounds below, derived by
           similar triangles from the real eye position to a point at
           z=0), while a point off that plane -- i.e. actual relief --
           does not cancel, and comes out skewed proportionally to both
           the offset and its own elevation. That residual, uncancelled
           skew is the "ray angle" effect this is actually for. */
        float frL = ratio * (-halfX - map_cur.throw_off_x);
        float frR = ratio * ( halfX - map_cur.throw_off_x);
        float frB = ratio * (-halfY - map_cur.throw_off_y);
        float frT = ratio * ( halfY - map_cur.throw_off_y);
        mat_frustum(proj, frL, frR, frB, frT, near, far);
        mat4 mEye;
        mat_translate(mEye, -map_cur.throw_off_x, -map_cur.throw_off_y, -throwDist);
        mat_mul(model, mEye, model);
        mat_mul(mvp, proj, model);

        double tB = now_sec();
        glBindFramebuffer(GL_FRAMEBUFFER, sceneFbo);
        glViewport(0, 0, wantW, wantH);
        glClearColor(0, 0, 0, 1);
        glClear(GL_COLOR_BUFFER_BIT | GL_DEPTH_BUFFER_BIT);
        glEnable(GL_DEPTH_TEST);
        /* The print is a closed slab, so its back and underside face away
           from the projector and can never be seen -- rasterising them was
           costing about 1.4ms a frame for nothing. Safe to cull with GL's
           default front-facing sense because winding survives everything
           this pipeline does to the mesh: INVERT_RELIEF is false, and the
           fixed OBJ-axis correction in load_obj is a rotation rather than a
           reflection (see its comment), so triangles reach here wound the
           way the file had them. */
        glEnable(GL_CULL_FACE);
        glUseProgram(prog);
        glUniformMatrix4fv(uMVP, 1, GL_FALSE, mvp);
        glUniformMatrix4fv(uModel, 1, GL_FALSE, model);
        glUniform2f(uModelSize, m_size.x, m_size.y);
        glUniform1f(uVidRotation, map_cur.vid_rotation * (float)M_PI / 180.f);
        glUniform1i(uVidFlipH, map_cur.vid_flip_h ? 1 : 0);
        glUniform1i(uVidFlipV, map_cur.vid_flip_v ? 1 : 0);
        glUniform1i(uShading, map_cur.shading ? 1 : 0);
        glUniform2f(uVideoEdgeLT, map_cur.vid_left, map_cur.vid_top);
        glUniform2f(uVideoEdgeRB, map_cur.vid_right, map_cur.vid_bottom);
        glActiveTexture(GL_TEXTURE0);
        glBindTexture(GL_TEXTURE_2D, test_pattern ? checkerTex : showing_still_image ? idle_tex : cur_tex);
        glBindVertexArray(vao);
        glDrawElements(GL_TRIANGLES, (GLsizei)m_nidx, GL_UNSIGNED_INT, 0);

        /* ---- keystone warp: draw the scene texture onto a quad whose
           corners are individually nudged by the calibration sliders ---- */
        float H[9];
        quad_homography(-1.f + map_cur.ks_bl_x, -1.f + map_cur.ks_bl_y,
                          1.f + map_cur.ks_br_x, -1.f + map_cur.ks_br_y,
                          1.f + map_cur.ks_tr_x,  1.f + map_cur.ks_tr_y,
                         -1.f + map_cur.ks_tl_x,  1.f + map_cur.ks_tl_y,
                         H);
        float corners[4][2] = { {0,0}, {1,0}, {1,1}, {0,1} };  /* s,t; matches quad_homography's source order */
        float warpVerts[4][5];
        for (int i = 0; i < 4; i++) {
            float x, y, w;
            homography_apply(H, corners[i][0], corners[i][1], &x, &y, &w);
            warpVerts[i][0] = x; warpVerts[i][1] = y; warpVerts[i][2] = w;
            warpVerts[i][3] = corners[i][0]; warpVerts[i][4] = corners[i][1];
        }
        glBindFramebuffer(GL_FRAMEBUFFER, 0);
        glViewport(0, 0, drm.mode.hdisplay, drm.mode.vdisplay);
        glClear(GL_COLOR_BUFFER_BIT);
        glDisable(GL_DEPTH_TEST);
        glUseProgram(warpProg);
        glActiveTexture(GL_TEXTURE0);
        glBindTexture(GL_TEXTURE_2D, sceneTex);
        glBindVertexArray(warpVao);
        glBindBuffer(GL_ARRAY_BUFFER, warpVbo);
        glBufferSubData(GL_ARRAY_BUFFER, 0, sizeof warpVerts, warpVerts);
        glDrawElements(GL_TRIANGLES, 6, GL_UNSIGNED_INT, 0);

        /* ---- calibration gizmo: drawn after the warp, deliberately
           bypassing it -- see the comment above GIZMO_VS_SRC. Uses the same
           mvp as the mesh itself -- now that the model's fixed OBJ-axis
           quirk is baked into the vertex data rather than a separate
           runtime matrix (see load_obj), there's no longer a second
           "mBase-free" transform for the rings to need. Gated on its own
           mapping.gizmo flag, independent of shading -- see MAPPING_BOOLEAN
           in server.py. */
        if (map_cur.gizmo) {
            glUseProgram(gizmoProg);
            glUniformMatrix4fv(uGizmoMVP, 1, GL_FALSE, mvp);
            glBindVertexArray(gizmoVao);
            for (int ring = 0; ring < 3; ring++)
                glDrawArrays(GL_LINE_LOOP, ring * GIZMO_SEGMENTS, GIZMO_SEGMENTS);

            /* Each label anchors on its own ring at a fixed 45-degree
               point, nudged past the ring radius, then projected through
               the same mvp -- see gizmo_project_ndc/gizmo_append_glyph. */
            label_vert labelVerts[GIZMO_LABEL_MAX_VERTS];
            int lc = 0;
            float ndcx, ndcy;
            const float ANCHOR = GIZMO_RADIUS * 1.3f;
            const float S = 0.7071068f; /* sin/cos of 45 degrees */
            gizmo_project_ndc(mvp, 0, ANCHOR * S, ANCHOR * S, &ndcx, &ndcy);
            lc = gizmo_append_glyph(labelVerts, lc, GLYPH_X, 2, ndcx, ndcy, 0.06f, aspect, 1.f, 0.25f, 0.25f);
            gizmo_project_ndc(mvp, ANCHOR * S, 0, -ANCHOR * S, &ndcx, &ndcy);
            lc = gizmo_append_glyph(labelVerts, lc, GLYPH_Y, 3, ndcx, ndcy, 0.06f, aspect, 0.25f, 1.f, 0.25f);
            gizmo_project_ndc(mvp, ANCHOR * S, ANCHOR * S, 0, &ndcx, &ndcy);
            lc = gizmo_append_glyph(labelVerts, lc, GLYPH_Z, 3, ndcx, ndcy, 0.06f, aspect, 0.35f, 0.55f, 1.f);

            glUseProgram(labelProg);
            glBindVertexArray(labelVao);
            glBindBuffer(GL_ARRAY_BUFFER, labelVbo);
            glBufferSubData(GL_ARRAY_BUFFER, 0, lc * sizeof(label_vert), labelVerts);
            glDrawArrays(GL_LINES, 0, lc);
        }

        /* ---- frame-rate readout: like the gizmo, drawn after the warp so
           the keystone correction doesn't skew it -- it reports on the
           renderer rather than being part of the projected picture, and a
           warped number is only harder to read. Top-left, in the same
           amber the admin panel uses for the web readout. Gated on its own
           mapping.fps flag (see MAPPING_BOOLEAN in server.py), which the
           browser backend has always honoured and this one previously
           ignored entirely. ---- */
        if (map_cur.fps_overlay) {
            /* Display aspect, not the scene target's: this draws to the
               default framebuffer, which is the full display even when
               render_scale has shrunk the off-screen scene. */
            const float hudAspect = (float)drm.mode.hdisplay / (float)drm.mode.vdisplay;
            label_vert hudVerts[HUD_MAX_VERTS];
            int hc = hud_append_number(hudVerts, 0, hud_fps,
                                       -0.96f, 0.88f, 0.07f, hudAspect,
                                       1.f, 0.75f, 0.2f);
            glUseProgram(labelProg);
            glBindVertexArray(labelVao);
            glBindBuffer(GL_ARRAY_BUFFER, labelVbo);
            glBufferSubData(GL_ARRAY_BUFFER, 0, hc * sizeof(label_vert), hudVerts);
            glDrawArrays(GL_LINES, 0, hc);
        }

        glBindVertexArray(vao);   /* restore, matching pre-warp-pass state */

        glFinish();                       /* so the timing splits are real */
        acc_draw += now_sec() - tB;

        double tC = now_sec();
        present();
        acc_present += now_sec() - tC;

        frames++;
        hud_frames++;
        if (now_sec() - hud_last >= 0.5) {
            hud_fps = hud_frames / (now_sec() - hud_last);
            hud_frames = 0;
            hud_last = now_sec();
        }
        if (now_sec() - last_fps >= 5.0) {
            double el = now_sec() - last_fps;
            printf("[fps] %.1f  (per frame: video %.1fms, draw %.1fms, present %.1fms)\n",
                   frames / el, 1000 * acc_video / frames,
                   1000 * acc_draw / frames, 1000 * acc_present / frames);
            frames = 0;
            acc_video = acc_draw = acc_present = 0;
            last_fps = now_sec();
        }
    }

    printf("[   ] shutting down\n");
    if (playbin) { gst_element_set_state(playbin, GST_STATE_NULL); gst_object_unref(playbin); }
    drm_restore();
    return 0;
}
