# --- Stage 1: Build libvips from source with the codecs bookworm does not ship ---
FROM node:24-bookworm AS vips-builder

RUN apt-get update && apt-get install -y \
  build-essential cmake meson ninja-build nasm \
  pkg-config git \
  # libvips dependencies from apt
  libglib2.0-dev libexpat1-dev \
  libjpeg62-turbo-dev libpng-dev libwebp-dev \
  libtiff-dev libgif-dev librsvg2-dev \
  libexif-dev liblcms2-dev libfftw3-dev \
  liborc-0.4-dev libpango1.0-dev libcgif-dev \
  libspng-dev libarchive-dev libimagequant-dev \
  libhwy-dev \
  && rm -rf /var/lib/apt/lists/*

# Build dav1d. NOTE: nothing currently links it. libheif 1.19.7 defaults
# WITH_DAV1D=OFF and this file never passes it, so AV1 decode runs on libaom
# and libdav1d.so ships unused. Enabling it is a decoder change with its own
# regression surface, so it is deliberately left alone here.
ARG DAV1D_VERSION=1.5.0
RUN cd /tmp && \
  git clone --depth 1 --branch ${DAV1D_VERSION} https://code.videolan.org/videolan/dav1d.git && \
  cd dav1d && \
  meson setup build --default-library=shared --buildtype=release \
    -Denable_tools=false -Denable_tests=false && \
  ninja -C build && \
  ninja -C build install && \
  ldconfig

# Build libaom (AV1 encoder — fallback, also needed for HEIC/HEIF compatibility)
ARG LIBAOM_VERSION=3.11.0
RUN cd /tmp && \
  git clone --depth 1 --branch v${LIBAOM_VERSION} https://aomedia.googlesource.com/aom && \
  cd aom && \
  mkdir -p aom_build && cd aom_build && \
  cmake .. \
    -DCMAKE_BUILD_TYPE=Release \
    -DBUILD_SHARED_LIBS=ON \
    -DENABLE_DOCS=OFF \
    -DENABLE_EXAMPLES=OFF \
    -DENABLE_TESTDATA=OFF \
    -DENABLE_TESTS=OFF \
    -DENABLE_TOOLS=OFF && \
  make -j$(nproc) && \
  make install && \
  ldconfig

# Build libde265 (HEVC/H.265 decoder — needed for HEIC images from iPhones/cameras)
ARG LIBDE265_VERSION=1.0.15
RUN cd /tmp && \
  git clone --depth 1 --branch v${LIBDE265_VERSION} https://github.com/strukturag/libde265.git && \
  cd libde265 && \
  mkdir build && cd build && \
  cmake .. \
    -DCMAKE_BUILD_TYPE=Release \
    -DBUILD_SHARED_LIBS=ON \
    -DENABLE_ENCODER=OFF \
    -DENABLE_DECODER=ON && \
  make -j$(nproc) && \
  make install && \
  ldconfig

# Build libheif (HEIF/AVIF container — libde265 for HEVC, libaom for AV1 decode
# and encode; dav1d is NOT linked, see the note above)
ARG LIBHEIF_VERSION=1.19.7
RUN cd /tmp && \
  git clone --depth 1 --branch v${LIBHEIF_VERSION} https://github.com/strukturag/libheif.git && \
  cd libheif && \
  mkdir build && cd build && \
  cmake .. \
    -DCMAKE_BUILD_TYPE=Release \
    -DBUILD_SHARED_LIBS=ON \
    -DWITH_EXAMPLES=OFF \
    -DWITH_GDK_PIXBUF=OFF \
    -DWITH_LIBDE265=ON \
    -DWITH_LIBDE265_PLUGIN=OFF && \
  make -j$(nproc) && \
  make install && \
  ldconfig

# Build libvips (image processing — links to our custom libheif)
ARG LIBVIPS_VERSION=8.16.1
ENV PKG_CONFIG_PATH=/usr/local/lib/pkgconfig:/usr/local/lib/x86_64-linux-gnu/pkgconfig
RUN cd /tmp && \
  git clone --depth 1 --branch v${LIBVIPS_VERSION} https://github.com/libvips/libvips.git && \
  cd libvips && \
  meson setup build --buildtype=release \
    -Dintrospection=disabled \
    -Dmodules=disabled \
    -Dmagick=disabled \
    -Dopenexr=disabled \
    -Dopenjpeg=disabled \
    -Djpeg-xl=disabled \
    -Dopenslide=disabled \
    -Dpdfium=disabled \
    -Dnifti=disabled \
    -Dcfitsio=disabled \
    -Dpoppler=disabled \
    -Dmatio=disabled && \
  ninja -C build && \
  ninja -C build install && \
  ldconfig

# --- Stage 2: Build application ---
FROM vips-builder AS build

RUN apt-get update && apt-get install -y python3 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json yarn.lock ./
# SHARP_IGNORE_GLOBAL_LIBVIPS: sharp's install script checks for a global libvips
# FIRST, and this stage inherits PKG_CONFIG_PATH pointing at the custom 8.16.1
# build. It only skips the source build today because node-addon-api happens to
# be absent from the tree. If that ever changes transitively, sharp would build
# from source and load ../src/build/Release ahead of the prebuilt binding,
# silently bypassing the overwrite below. Pin the prebuilt path.
RUN SHARP_IGNORE_GLOBAL_LIBVIPS=1 yarn install --frozen-lockfile
# Replace Sharp's bundled libvips-cpp.so with our custom build (HEIC via libde265,
# AVIF via libaom, and the wider format set libvips was configured with)
RUN cp /usr/local/lib/x86_64-linux-gnu/libvips-cpp.so.42 \
  node_modules/@img/sharp-libvips-linux-x64/lib/libvips-cpp.so.42

# Fail the build if that copy did not land on the library Sharp actually loads.
#
# Two ways it can silently become a no-op. sharp-libvips PR #252 renamed the
# bundled library to libvips-cpp.so.<vips-version> in the sharp 0.34.x line, so
# after such an upgrade the cp writes a filename nothing loads; and if the cp were
# dropped entirely the stock self-contained bundle stays in place. Either way the
# build stays green while HEIC decode disappears, masked by the
# serve-original-bytes fallback. sharp.versions cannot detect it: it reads a
# static versions.json, which reports 8.15.3 in production today while the loaded
# library is 8.16.1.
#
# The discriminator is the split build. Our libvips-cpp.so.42 declares NEEDED
# libvips.so.42 and the codecs hang off that; the stock bundle is self-contained
# and declares only libc-family entries. Verified against the running production
# image: libvips-cpp.so.42 -> libvips.so.42 -> libheif.so.1 -> libde265 + libaom.
RUN set -e; \
  BINDING=node_modules/@img/sharp-linux-x64/lib/sharp-linux-x64.node; \
  test -f "$BINDING" || { echo "GUARD FAIL: no sharp binding at $BINDING"; exit 1; }; \
  test ! -e node_modules/sharp/src/build || { \
    echo "GUARD FAIL: sharp built from source at install, so the prebuilt binding and the overwrite are both bypassed"; exit 1; }; \
  VLIB_NAME="$(readelf -d "$BINDING" | sed -n 's/.*(NEEDED).*\[\(libvips-cpp\.so[^]]*\)\].*/\1/p' | head -1)"; \
  test -n "$VLIB_NAME" || { echo "GUARD FAIL: sharp binding declares no libvips-cpp NEEDED entry"; readelf -d "$BINDING" | grep NEEDED; exit 1; }; \
  VLIB="node_modules/@img/sharp-libvips-linux-x64/lib/$VLIB_NAME"; \
  test -f "$VLIB" || { echo "GUARD FAIL: binding loads $VLIB_NAME but the cp wrote a different filename"; exit 1; }; \
  readelf -d "$VLIB" | grep -q 'NEEDED.*\[libvips\.so\.42\]' || { \
    echo "GUARD FAIL: $VLIB is the stock self-contained library, the overwrite did not take effect"; \
    readelf -d "$VLIB" | grep NEEDED; exit 1; }; \
  VIPS_SO="$(find /usr/local/lib -name libvips.so.42 | head -1)"; \
  HEIF_SO="$(find /usr/local/lib -name 'libheif.so.1' | head -1)"; \
  test -n "$VIPS_SO" || { echo "GUARD FAIL: custom libvips.so.42 not found under /usr/local/lib"; exit 1; }; \
  test -n "$HEIF_SO" || { echo "GUARD FAIL: custom libheif.so.1 not found under /usr/local/lib"; exit 1; }; \
  readelf -d "$VIPS_SO" | grep -q 'NEEDED.*\[libheif\.so\.1\]' || { echo "GUARD FAIL: custom libvips is not linked against libheif"; exit 1; }; \
  for dep in libde265 libaom; do \
    readelf -d "$HEIF_SO" | grep -q "NEEDED.*\[$dep" || { \
      echo "GUARD FAIL: libheif.so.1 lacks NEEDED $dep"; readelf -d "$HEIF_SO" | grep NEEDED; exit 1; }; \
  done; \
  echo "GUARD OK: custom libvips chain verified ($VLIB_NAME -> libvips.so.42 -> libheif.so.1 -> libde265 + libaom)"

COPY . .
RUN make lib

# --- Runtime image ---
FROM node:24-bookworm-slim

WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends \
  wget tini \
  # Runtime shared library dependencies for libvips
  libglib2.0-0 libexpat1 \
  libjpeg62-turbo libpng16-16 libwebp7 libwebpdemux2 libwebpmux3 \
  libtiff6 libgif7 librsvg2-2 \
  libexif12 liblcms2-2 libfftw3-double3 \
  liborc-0.4-0 libpango-1.0-0 libpangocairo-1.0-0 \
  libcgif0 libspng0 libarchive13 \
  libimagequant0 libhwy1 \
  && rm -rf /var/lib/apt/lists/*

# Copy custom-built shared libraries (libaom, libde265, libheif, libvips; dav1d
# is copied too but nothing links it, see the note in the builder stage)
COPY --from=vips-builder /usr/local/lib/ /usr/local/lib/
RUN ldconfig

COPY --from=build /app/lib lib
COPY --from=build /app/config config
COPY --from=build /app/node_modules node_modules
COPY --from=build /app/scripts/smoke-decode.js scripts/smoke-decode.js
COPY --from=build /app/test/test.heic test/test.heic

# Prove the custom libvips is the one actually loaded, on the exact filesystem
# that ships, by decoding rather than by reading a version string. The build-stage
# guard checks the ELF wiring; this checks that the wiring works, and that the
# NAPI binding loads under this Node major. Reading metadata is not enough: the
# stock library parses the HEIF container fine and only a pixel decode reaches
# libde265.
RUN node /app/scripts/smoke-decode.js

EXPOSE 8800
ENV PORT=8800
ENV NODE_ENV=production
# Cap glibc per-thread malloc arenas: libvips spins up many native threads per
# worker and the default arena-per-thread strategy fragments badly, ballooning
# RSS until the box swaps. 2 arenas trades negligible alloc concurrency for far
# lower, stable RSS.
ENV MALLOC_ARENA_MAX=2

HEALTHCHECK --interval=20s --timeout=10s --start-period=5s \
  CMD /bin/sh -c 'wget -nv -t1 -O /dev/null "http://localhost:${PORT}/healthcheck" || exit 1'

# tini as PID 1 reaps zombies. Node as PID 1 does not reap the /bin/sh that the
# HEALTHCHECK spawns every 20s, so those accumulate as <defunct> processes.
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "lib/app.js"]
