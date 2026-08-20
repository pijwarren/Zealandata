CFLAGS  ?= -O2 -Wall -Wextra
PKGS     = libdrm gbm egl glesv2 gstreamer-1.0 gstreamer-app-1.0 gstreamer-gl-1.0 gstreamer-video-1.0
CFLAGS  += $(shell pkg-config --cflags $(PKGS))
LDLIBS   = $(shell pkg-config --libs $(PKGS)) -lm -lpthread

projector: projector.c
	$(CC) $(CFLAGS) -o $@ $< $(LDLIBS)

clean:
	rm -f projector

.PHONY: clean
