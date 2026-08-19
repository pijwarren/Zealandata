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
 *            keep working untouched.
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

    /* Preferred mode if the display advertises one, else the first (which is
       the highest resolution by convention). */
    drm.mode = conn->modes[0];
    for (int i = 0; i < conn->count_modes; i++)
        if (conn->modes[i].type & DRM_MODE_TYPE_PREFERRED) { drm.mode = conn->modes[i]; break; }
    drm.connector_id = conn->connector_id;

    drmModeEncoder *enc = NULL;
    if (conn->encoder_id) enc = drmModeGetEncoder(drm.fd, conn->encoder_id);
    if (enc) {
        drm.crtc_id = enc->crtc_id;
        drmModeFreeEncoder(enc);
    }
    if (!drm.crtc_id) {                       /* nothing bound yet -- pick one */
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

/* Page flipping. Two buffers are in play at once: the one currently being
   scanned out and the one just rendered, so the previously-locked bo can
   only be released after the flip that replaces it has completed. */
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
    bool *waiting = data;
    *waiting = false;
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

/* =============================================================== main ==== */

int main(int argc, char **argv) {
    const char *card = getenv("ZEALANDATA_DRM_CARD");
    if (!card) card = "/dev/dri/card1";
    (void)argc; (void)argv;

    signal(SIGINT, on_signal);
    signal(SIGTERM, on_signal);

    if (!drm_init(card)) return 1;
    if (!egl_init()) return 1;

    /* Stage check: a recognisable moving pattern, so a blank or frozen
       projector is distinguishable from a working pipeline before any of
       the mesh or video code is wired in. */
    double t0 = now_sec();
    int frames = 0;
    while (running && now_sec() - t0 < 10.0) {
        double t = now_sec() - t0;
        glViewport(0, 0, drm.mode.hdisplay, drm.mode.vdisplay);
        glClearColor((float)(0.5 + 0.5 * sin(t * 2.0)), 0.1f,
                     (float)(0.5 + 0.5 * cos(t * 2.0)), 1.0f);
        glClear(GL_COLOR_BUFFER_BIT | GL_DEPTH_BUFFER_BIT);
        present();
        frames++;
    }
    printf("[ok ] %d frames in %.1fs = %.1f fps\n", frames, now_sec() - t0,
           frames / (now_sec() - t0));

    drm_restore();
    return 0;
}
