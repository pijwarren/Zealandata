CFLAGS  ?= -O2 -Wall -Wextra
PKGS     = libdrm gbm egl glesv2 mpv
CFLAGS  += $(shell pkg-config --cflags $(PKGS))
LDLIBS   = $(shell pkg-config --libs $(PKGS)) -lm

projector: projector.c
	$(CC) $(CFLAGS) -o $@ $< $(LDLIBS)

clean:
	rm -f projector

.PHONY: clean
