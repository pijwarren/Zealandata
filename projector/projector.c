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
 * Video    : libmpv's render API decodes (hardware, via the Pi's V4L2 H.264
 *            decoder) straight into a GL texture we own, so playback logic
 *            doesn't have to be reinvented here.
 * Control  : the embedded mpv exposes the same IPC socket path the server
 *            already speaks, so server.py drives this exactly as it drove a
 *            standalone mpv -- screensaver, spinner, resume and progress all
 *            keep working untouched. Run the server with
 *            ZEALANDATA_MPV_EXTERNAL=1 so it talks to this socket instead of
 *            spawning an mpv of its own.
 * Calibration: mapping.json is polled and applied live, matching the admin
 *            panel's sliders.
 */
#define _GNU_SOURCE
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
#include <sys/stat.h>

#include <xf86drm.h>
#include <xf86drmMode.h>
#include <gbm.h>
#include <EGL/egl.h>
#include <EGL/eglext.h>
#include <GLES3/gl3.h>

#include <mpv/client.h>
#include <mpv/render_gl.h>

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
static const bool INVERT_RELIEF = true;
static const float BASE_ORIENTATION_Y_DEG = 90.f;

/* How the video needs turning to land the right way up on the print.
   Clockwise degrees as seen on the projector, then a flip across the
   horizontal axis. */
static const int VIDEO_ROTATION_CW_DEG = 270;
static const bool VIDEO_FLIP_ACROSS_HORIZONTAL = true;

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
       that's the height. */
    int up = (size.y <= size.x && size.y <= size.z) ? 1
           : (size.z <= size.x && size.z <= size.y) ? 2 : 1;

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

/* ================================================================= main == */

static mpv_handle *mpv;
static mpv_render_context *mpv_gl;

/* mpv calls this as get_proc_address(ctx, name) -- passing eglGetProcAddress
   directly looks like it should work and compiles with a cast, but it then
   receives the context pointer as its name argument and dereferences it as a
   string. Hence the wrapper. */
static void *get_proc_address_egl(void *ctx, const char *name) {
    (void)ctx;
    return (void *)eglGetProcAddress(name);
}

int main(void) {
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

    /* ---- video target: mpv renders here, the mesh samples it ---- */
    int vidW = 1920, vidH = 1080;
    GLuint videoTex, videoFbo;
    glGenTextures(1, &videoTex);
    glBindTexture(GL_TEXTURE_2D, videoTex);
    glTexImage2D(GL_TEXTURE_2D, 0, GL_RGBA8, vidW, vidH, 0, GL_RGBA, GL_UNSIGNED_BYTE, NULL);
    glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MIN_FILTER, GL_LINEAR);
    glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MAG_FILTER, GL_LINEAR);
    glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_WRAP_S, GL_CLAMP_TO_EDGE);
    glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_WRAP_T, GL_CLAMP_TO_EDGE);
    glGenFramebuffers(1, &videoFbo);
    glBindFramebuffer(GL_FRAMEBUFFER, videoFbo);
    glFramebufferTexture2D(GL_FRAMEBUFFER, GL_COLOR_ATTACHMENT0, GL_TEXTURE_2D, videoTex, 0);
    CHECK(glCheckFramebufferStatus(GL_FRAMEBUFFER) == GL_FRAMEBUFFER_COMPLETE, "video FBO");
    glBindFramebuffer(GL_FRAMEBUFFER, 0);

    /* ---- scene target, for render_scale < 1 ---- */
    GLuint sceneFbo = 0, sceneTex = 0, sceneDepth = 0;
    int sceneW = 0, sceneH = 0;

    /* ---- mpv ---- */
    mpv = mpv_create();
    CHECK(mpv, "mpv_create");
    mpv_set_option_string(mpv, "input-ipc-server", sockpath);
    mpv_set_option_string(mpv, "idle", "yes");
    mpv_set_option_string(mpv, "hwdec", "auto");
    mpv_set_option_string(mpv, "keep-open", "yes");
    mpv_set_option_string(mpv, "osc", "no");
    mpv_set_option_string(mpv, "osd-level", "0");
    mpv_set_option_string(mpv, "msg-level", "all=error");
    /* Required for the render API: mpv hands frames to us rather than
       driving a window of its own. */
    mpv_set_option_string(mpv, "vo", "libmpv");
    CHECK(mpv_initialize(mpv) >= 0, "mpv_initialize");

    mpv_opengl_init_params gl_init = { .get_proc_address = get_proc_address_egl };
    int advanced = 1;
    mpv_render_param params[] = {
        { MPV_RENDER_PARAM_API_TYPE, (void *)MPV_RENDER_API_TYPE_OPENGL },
        { MPV_RENDER_PARAM_OPENGL_INIT_PARAMS, &gl_init },
        { MPV_RENDER_PARAM_ADVANCED_CONTROL, &advanced },
        { 0 }
    };
    CHECK(mpv_render_context_create(&mpv_gl, mpv, params) >= 0, "mpv_render_context_create");
    printf("[mpv] ready, ipc socket %s\n", sockpath);

    if (idleimg && *idleimg) {
        const char *cmd[] = { "loadfile", idleimg, "replace", NULL };
        mpv_command(mpv, cmd);
        mpv_set_option_string(mpv, "image-display-duration", "inf");
    }

    /* ---- render loop ---- */
    double last_cal = 0, last_fps = now_sec();
    int frames = 0;
    while (running) {
        /* calibration is polled rather than watched: one stat() per 100ms is
           nothing next to a frame, and it avoids an inotify dependency */
        double t = now_sec();
        if (t - last_cal > 0.1) { mapping_reload(); last_cal = t; }

        /* drain mpv events so it can make progress */
        while (1) {
            mpv_event *ev = mpv_wait_event(mpv, 0);
            if (ev->event_id == MPV_EVENT_NONE) break;
            if (ev->event_id == MPV_EVENT_SHUTDOWN) running = 0;
        }

        /* keep the video FBO matched to the actual decoded size, so the
           texture isn't up- or down-scaled twice on its way to the mesh */
        int64_t dw = 0, dh = 0;
        if (mpv_get_property(mpv, "dwidth", MPV_FORMAT_INT64, &dw) >= 0 &&
            mpv_get_property(mpv, "dheight", MPV_FORMAT_INT64, &dh) >= 0 &&
            dw > 0 && dh > 0 && ((int)dw != vidW || (int)dh != vidH)) {
            vidW = (int)dw; vidH = (int)dh;
            glBindTexture(GL_TEXTURE_2D, videoTex);
            glTexImage2D(GL_TEXTURE_2D, 0, GL_RGBA8, vidW, vidH, 0, GL_RGBA, GL_UNSIGNED_BYTE, NULL);
            printf("[mpv] video %dx%d\n", vidW, vidH);
        }

        uint64_t flags = mpv_render_context_update(mpv_gl);
        if (flags & MPV_RENDER_UPDATE_FRAME) {
            mpv_opengl_fbo fbo = { .fbo = (int)videoFbo, .w = vidW, .h = vidH, .internal_format = 0 };
            int flip = 0;
            mpv_render_param rp[] = {
                { MPV_RENDER_PARAM_OPENGL_FBO, &fbo },
                { MPV_RENDER_PARAM_FLIP_Y, &flip },
                { 0 }
            };
            mpv_render_context_render(mpv_gl, rp);
        }

        /* scene target sized by render_scale */
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

        /* ---- transform: base orientation, then calibration on top ---- */
        mat4 mBase, mRx, mRy, mRz, mS, mT, tmp, model, proj, mvp;
        mat_rot_y(mBase, BASE_ORIENTATION_Y_DEG * (float)M_PI / 180.f);
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
        float aspect = (float)sceneW / (float)sceneH;
        mat_ortho(proj, -half * aspect, half * aspect, -half, half, -100.f, 100.f);
        mat_mul(mvp, proj, model);

        glBindFramebuffer(GL_FRAMEBUFFER, sceneFbo);
        glViewport(0, 0, sceneW, sceneH);
        glClearColor(0, 0, 0, 1);
        glClear(GL_COLOR_BUFFER_BIT | GL_DEPTH_BUFFER_BIT);
        glEnable(GL_DEPTH_TEST);
        glUseProgram(prog);
        glUniformMatrix4fv(uMVP, 1, GL_FALSE, mvp);
        glUniformMatrix4fv(uModel, 1, GL_FALSE, model);
        glUniform1i(uShading, map_cur.shading ? 1 : 0);
        glActiveTexture(GL_TEXTURE0);
        glBindTexture(GL_TEXTURE_2D, videoTex);
        glBindVertexArray(vao);
        glDrawElements(GL_TRIANGLES, (GLsizei)m_nidx, GL_UNSIGNED_INT, 0);

        /* upscale the scene to the display */
        glBindFramebuffer(GL_READ_FRAMEBUFFER, sceneFbo);
        glBindFramebuffer(GL_DRAW_FRAMEBUFFER, 0);
        glViewport(0, 0, drm.mode.hdisplay, drm.mode.vdisplay);
        glBlitFramebuffer(0, 0, sceneW, sceneH,
                          0, 0, drm.mode.hdisplay, drm.mode.vdisplay,
                          GL_COLOR_BUFFER_BIT, GL_LINEAR);
        glBindFramebuffer(GL_FRAMEBUFFER, 0);

        present();
        mpv_render_context_report_swap(mpv_gl);

        frames++;
        if (now_sec() - last_fps >= 5.0) {
            printf("[fps] %.1f\n", frames / (now_sec() - last_fps));
            frames = 0;
            last_fps = now_sec();
        }
    }

    printf("[   ] shutting down\n");
    if (mpv_gl) mpv_render_context_free(mpv_gl);
    if (mpv) mpv_terminate_destroy(mpv);
    drm_restore();
    return 0;
}
