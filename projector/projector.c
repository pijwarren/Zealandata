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
 *            it drove a standalone mpv -- screensaver, spinner, resume and
 *            progress all keep working untouched. Run the server with
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
struct mapping {
    float scale, rot_x, rot_y, rot_z, off_x, off_y, render_scale;
    bool shading;
};
static struct mapping map_cur = { 1, 0, 0, 0, 0, 0, 1, false };
static const char *mapping_path = "/home/pj/zealandata-warped/mapping.json";
static time_t mapping_mtime;

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
    if (st.st_mtime == mapping_mtime) return;
    mapping_mtime = st.st_mtime;

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
    json_bool(buf, "shading", &map_cur.shading);
    if (map_cur.render_scale < 0.25f) map_cur.render_scale = 0.25f;
    if (map_cur.render_scale > 1.0f) map_cur.render_scale = 1.0f;
    printf("[cal] scale=%.2f rot=(%.0f,%.0f,%.0f) off=(%.2f,%.2f) rs=%.2f shading=%d\n",
           map_cur.scale, map_cur.rot_x, map_cur.rot_y, map_cur.rot_z,
           map_cur.off_x, map_cur.off_y, map_cur.render_scale, map_cur.shading);
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
static void mat_ortho(mat4 m, float l, float r, float b, float t, float n, float f) {
    mat_identity(m);
    m[0] = 2 / (r - l); m[5] = 2 / (t - b); m[10] = -2 / (f - n);
    m[12] = -(r + l) / (r - l); m[13] = -(t + b) / (t - b); m[14] = -(f + n) / (f - n);
}

/* ================================================================= mesh == */

typedef struct { float x, y, z; } vec3;

static vec3 *m_pos = NULL;
static vec3 *m_nrm = NULL;
static float *m_uv = NULL;
static unsigned *m_idx = NULL;
static size_t m_nvert = 0, m_nidx = 0;

/* The relief comes out of the OBJ inverted -- what should stand proud sits
   sunken -- so the height axis is mirrored. Kept as constants rather than
   controls: these are fixed properties of this model file, not things that
   vary with where the projector happens to be. */
static const bool INVERT_RELIEF = false;
/* The fixed camera looks down -Z, so once the up-axis remap above has
   folded height into depth, an "as seen on screen" spin lives on the Z
   axis, not Y -- rotating a positive angle about Z is counter-clockwise
   from the camera's side (standard GL convention), so clockwise needs a
   negative value here. */
static const float BASE_ORIENTATION_Z_DEG = 90.f;
static const float BASE_ORIENTATION_X_DEG = 180.f;

/* How the video needs turning to land the right way up on the print.
   Named "clockwise" for continuity with the name orient_uv()'s switch
   cases use, but confirmed live against the physical print: increasing
   this value turns the displayed image counter-clockwise as actually
   seen on the projector, not clockwise -- a flip across the horizontal
   axis (if enabled) applies on top of that. */
static const int VIDEO_ROTATION_CW_DEG = 90;
static const bool VIDEO_FLIP_ACROSS_HORIZONTAL = false;

static void orient_uv(float *u, float *v) {
    /* Inverse of the described transform: to turn the displayed image
       clockwise the sample coordinates turn counter-clockwise, and an
       inverse composition runs its steps in reverse -- hence the flip
       landing before the rotation here. */
    if (VIDEO_FLIP_ACROSS_HORIZONTAL) *v = 1.f - *v;
    float uu = *u, vv = *v;
    switch (((VIDEO_ROTATION_CW_DEG % 360) + 360) % 360) {
        case 90:  *u = 1.f - vv; *v = uu;        break;
        case 180: *u = 1.f - uu; *v = 1.f - vv;  break;
        case 270: *u = vv;       *v = 1.f - uu;  break;
        default: break;
    }
}

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

    /* Planar top-down UVs from the model's own footprint, not whatever the
       OBJ carried: raw print exports often have none, or ones meant for a
       physical texture rather than video projected from above. */
    m_uv = malloc(m_nvert * 2 * sizeof(float));
    for (size_t i = 0; i < m_nvert; i++) {
        float u, v;
        if (up == 1) {
            u = size.x > 0 ? (m_pos[i].x + size.x / 2) / size.x : 0.5f;
            v = size.z > 0 ? (m_pos[i].z + size.z / 2) / size.z : 0.5f;
        } else {
            u = size.x > 0 ? (m_pos[i].x + size.x / 2) / size.x : 0.5f;
            v = size.y > 0 ? (m_pos[i].y + size.y / 2) / size.y : 0.5f;
        }
        orient_uv(&u, &v);
        m_uv[i * 2] = u;
        m_uv[i * 2 + 1] = v;
    }

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
    "layout(location=2) in vec2 aUV;\n"
    "uniform mat4 uMVP;\n"
    "uniform mat4 uModel;\n"
    "out vec2 vUV;\n"
    "out vec3 vNrm;\n"
    "void main(){\n"
    "  vUV = aUV;\n"
    "  vNrm = mat3(uModel) * aNrm;\n"
    "  gl_Position = uMVP * vec4(aPos,1.0);\n"
    "}\n";

static const char *FS_SRC =
    "#version 300 es\n"
    "precision mediump float;\n"
    "in vec2 vUV;\n"
    "in vec3 vNrm;\n"
    "uniform sampler2D uTex;\n"
    "uniform int uShading;\n"
    "out vec4 oColor;\n"
    "void main(){\n"
    "  vec4 c = texture(uTex, vUV);\n"
    "  if (uShading == 1) {\n"
    /* Oblique on purpose: a light along the view axis flattens relief back
       out, which is the exact thing the calibration shading exists to show. */
    "    vec3 L = normalize(vec3(-1.0, 1.6, 1.0));\n"
    "    float d = max(dot(normalize(vNrm), L), 0.0);\n"
    "    c.rgb *= (0.55 + 1.1 * d);\n"
    "  }\n"
    "  oColor = vec4(c.rgb, 1.0);\n"
    "}\n";

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
    char uri[2048];
    if (strstr(path, "://")) snprintf(uri, sizeof uri, "%s", path);
    else {
        gchar *u = gst_filename_to_uri(path, NULL);
        snprintf(uri, sizeof uri, "%s", u ? u : path);
        g_free(u);
    }
    gst_element_set_state(playbin, GST_STATE_NULL);
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

static double video_get_position(void) {
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
    double step = last_known_fps > 0 ? 1.0 / last_known_fps : 1.0 / 24.0;
    video_seek(pos - step > 0 ? pos - step : 0);
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
    if (!objpath)  objpath = "/home/pj/zealandata-warped/static/3dPrint_210kFaces.obj";
    if (!sockpath) sockpath = "/tmp/zealandata-mpv.sock";
    if (mapfile)   mapping_path = mapfile;

    signal(SIGINT, on_signal);
    signal(SIGTERM, on_signal);

    if (!drm_init(card)) return 1;
    if (!egl_init()) return 1;
    if (!load_obj(objpath)) return 1;
    mapping_reload();

    /* ---- GL objects ---- */
    GLuint vao, vbo_p, vbo_n, vbo_t, ibo;
    glGenVertexArrays(1, &vao); glBindVertexArray(vao);
    glGenBuffers(1, &vbo_p); glBindBuffer(GL_ARRAY_BUFFER, vbo_p);
    glBufferData(GL_ARRAY_BUFFER, m_nvert * sizeof(vec3), m_pos, GL_STATIC_DRAW);
    glEnableVertexAttribArray(0); glVertexAttribPointer(0, 3, GL_FLOAT, GL_FALSE, 0, 0);
    glGenBuffers(1, &vbo_n); glBindBuffer(GL_ARRAY_BUFFER, vbo_n);
    glBufferData(GL_ARRAY_BUFFER, m_nvert * sizeof(vec3), m_nrm, GL_STATIC_DRAW);
    glEnableVertexAttribArray(1); glVertexAttribPointer(1, 3, GL_FLOAT, GL_FALSE, 0, 0);
    glGenBuffers(1, &vbo_t); glBindBuffer(GL_ARRAY_BUFFER, vbo_t);
    glBufferData(GL_ARRAY_BUFFER, m_nvert * 2 * sizeof(float), m_uv, GL_STATIC_DRAW);
    glEnableVertexAttribArray(2); glVertexAttribPointer(2, 2, GL_FLOAT, GL_FALSE, 0, 0);
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
    GLint uShading = glGetUniformLocation(prog, "uShading");
    glUniform1i(glGetUniformLocation(prog, "uTex"), 0);

    /* ---- scene target, for render_scale < 1 ---- */
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
        acc_video += now_sec() - tA;


        /* Scene target sized by render_scale. At full scale the mesh is drawn
           straight to the display instead: the intermediate FBO exists only
           so a reduced-resolution render can be upscaled, and the blit that
           does it costs a full 1920x1080 pass every frame no matter how small
           the scene target is -- which is why lowering render_scale appeared
           to do nothing at all until this was split out. */
        bool direct = map_cur.render_scale >= 0.999f;
        int wantW = direct ? drm.mode.hdisplay : (int)(drm.mode.hdisplay * map_cur.render_scale);
        int wantH = direct ? drm.mode.vdisplay : (int)(drm.mode.vdisplay * map_cur.render_scale);
        if (wantW < 16) wantW = 16;
        if (wantH < 16) wantH = 16;
        if (!direct && (wantW != sceneW || wantH != sceneH)) {
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

        /* ---- transform: base orientation, then calibration on top ---- */
        mat4 mBaseZ, mBaseX, mBase, mRx, mRy, mRz, mS, mT, tmp, model, proj, mvp;
        mat_rot_z(mBaseZ, BASE_ORIENTATION_Z_DEG * (float)M_PI / 180.f);
        mat_rot_x(mBaseX, BASE_ORIENTATION_X_DEG * (float)M_PI / 180.f);
        mat_mul(mBase, mBaseZ, mBaseX);
        mat_rot_x(mRx, map_cur.rot_x * (float)M_PI / 180.f);
        mat_rot_y(mRy, map_cur.rot_y * (float)M_PI / 180.f);
        mat_rot_z(mRz, map_cur.rot_z * (float)M_PI / 180.f);
        mat_scale(mS, map_cur.scale);
        mat_translate(mT, map_cur.off_x, map_cur.off_y, 0);

        mat_mul(tmp, mRy, mBase);      /* base orientation sits underneath */
        mat_mul(tmp, mRx, tmp);
        mat_mul(tmp, mRz, tmp);
        mat_mul(tmp, mS, tmp);
        mat_mul(model, mT, tmp);

        float half = 1.15f;            /* padding around the fitted model */
        float aspect = (float)wantW / (float)wantH;
        mat_ortho(proj, -half * aspect, half * aspect, -half, half, -100.f, 100.f);
        mat_mul(mvp, proj, model);

        double tB = now_sec();
        glBindFramebuffer(GL_FRAMEBUFFER, direct ? 0 : sceneFbo);
        glViewport(0, 0, wantW, wantH);
        glClearColor(0, 0, 0, 1);
        glClear(GL_COLOR_BUFFER_BIT | GL_DEPTH_BUFFER_BIT);
        glEnable(GL_DEPTH_TEST);
        glUseProgram(prog);
        glUniformMatrix4fv(uMVP, 1, GL_FALSE, mvp);
        glUniformMatrix4fv(uModel, 1, GL_FALSE, model);
        glUniform1i(uShading, map_cur.shading ? 1 : 0);
        glActiveTexture(GL_TEXTURE0);
        glBindTexture(GL_TEXTURE_2D, test_pattern ? checkerTex : cur_tex);
        glBindVertexArray(vao);
        glDrawElements(GL_TRIANGLES, (GLsizei)m_nidx, GL_UNSIGNED_INT, 0);

        if (!direct) {   /* upscale the reduced-resolution scene to the display */
            glBindFramebuffer(GL_READ_FRAMEBUFFER, sceneFbo);
            glBindFramebuffer(GL_DRAW_FRAMEBUFFER, 0);
            glViewport(0, 0, drm.mode.hdisplay, drm.mode.vdisplay);
            glBlitFramebuffer(0, 0, sceneW, sceneH,
                              0, 0, drm.mode.hdisplay, drm.mode.vdisplay,
                              GL_COLOR_BUFFER_BIT, GL_LINEAR);
            glBindFramebuffer(GL_FRAMEBUFFER, 0);
        }

        glFinish();                       /* so the timing splits are real */
        acc_draw += now_sec() - tB;

        double tC = now_sec();
        present();
        acc_present += now_sec() - tC;

        frames++;
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
