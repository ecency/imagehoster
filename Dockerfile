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
# sharp compiles its own binding against the libvips this image built in stage 1,
# through pkg-config (PKG_CONFIG_PATH is inherited from vips-builder), instead of
# installing the prebuilt binding and overwriting the library it bundles. That
# overwrite was a copy into a filename the binding happened to load; sharp-libvips
# renamed that file in the 0.34 line, so the copy would have gone on succeeding
# while nothing loaded it, and sharp.versions could not tell because the prebuilt
# path reads a static versions file. A binding built here links libvips-cpp.so.42
# by soname, reports the loaded library's real version, and a future sharp bump
# whose minimum libvips is newer than ours fails at install instead of passing
# with the wrong library. sharp does this by itself when it finds a global libvips
# and node-addon-api + node-gyp (devDependencies); forcing it makes a missing
# pkg-config path a build failure rather than a silent fall back to the prebuilt.
# node-addon-api is pinned to 8.1.0 in package.json: sharp 0.33.x compiles its
# binding as C++11 and node-addon-api 8.3+ requires C++17. Lift the pin with the
# next sharp major.
RUN SHARP_FORCE_GLOBAL_LIBVIPS=1 yarn install --frozen-lockfile

# Fail the build unless the compiled binding exists and links the custom chain.
# The runtime stage repeats the proof by decoding a HEIC through it.
RUN set -e; \
  BINDING=node_modules/sharp/src/build/Release/sharp-linux-x64.node; \
  test -f "$BINDING" || { echo "GUARD FAIL: sharp did not build from source (no $BINDING)"; \
    ls -la node_modules/sharp/src/build 2>/dev/null; exit 1; }; \
  readelf -d "$BINDING" | grep -q 'NEEDED.*\[libvips-cpp\.so\.42\]' || { \
    echo "GUARD FAIL: compiled binding does not link libvips-cpp.so.42"; readelf -d "$BINDING" | grep NEEDED; exit 1; }; \
  VLIB="$(ldd "$BINDING" | sed -n 's/.*libvips-cpp\.so\.42 => \([^ ]*\).*/\1/p')"; \
  case "$VLIB" in /usr/local/lib/*) ;; *) echo "GUARD FAIL: binding resolves libvips-cpp.so.42 to '$VLIB', not the custom build"; exit 1;; esac; \
  readelf -d "$VLIB" | grep -q 'NEEDED.*\[libvips\.so\.42\]' || { \
    echo "GUARD FAIL: $VLIB is not the split custom build"; readelf -d "$VLIB" | grep NEEDED; exit 1; }; \
  VIPS_SO="$(find /usr/local/lib -name libvips.so.42 | head -1)"; \
  HEIF_SO="$(find /usr/local/lib -name 'libheif.so.1' | head -1)"; \
  test -n "$VIPS_SO" || { echo "GUARD FAIL: custom libvips.so.42 not found under /usr/local/lib"; exit 1; }; \
  test -n "$HEIF_SO" || { echo "GUARD FAIL: custom libheif.so.1 not found under /usr/local/lib"; exit 1; }; \
  readelf -d "$VIPS_SO" | grep -q 'NEEDED.*\[libheif\.so\.1\]' || { echo "GUARD FAIL: custom libvips is not linked against libheif"; exit 1; }; \
  for dep in libde265 libaom; do \
    readelf -d "$HEIF_SO" | grep -q "NEEDED.*\[$dep" || { \
      echo "GUARD FAIL: libheif.so.1 lacks NEEDED $dep"; readelf -d "$HEIF_SO" | grep NEEDED; exit 1; }; \
  done; \
  echo "GUARD OK: compiled sharp binding -> $VLIB -> libvips.so.42 -> libheif.so.1 -> libde265 + libaom"; \
  pkg-config --modversion vips-cpp > /app/.vips-version; \
  echo "libvips $(cat /app/.vips-version) recorded for the runtime smoke test"

# With the binding compiled, the prebuilt bindings and their bundled libvips are
# dead weight and a silent fallback: sharp tries src/build first and the prebuilt
# second, so if the compiled binding ever went missing the service would come up
# on the stock library with HEIC decode gone. yarn 1 also ignores the libc field
# and installs the musl variants alongside the glibc ones. Remove the whole
# namespace so that failure is loud and the image carries nothing it cannot load.
RUN rm -rf node_modules/@img && test ! -e node_modules/@img

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
COPY --from=build /app/.vips-version .vips-version

# Prove the custom libvips is the one actually loaded, on the exact filesystem
# that ships, by decoding. The build-stage guard checks the ELF wiring; this
# checks that the wiring works, and that the NAPI binding loads under this Node
# major. Reading metadata is not enough: the stock library parses the HEIF
# container fine and only a pixel decode reaches libde265. Because the binding
# is built against a global libvips, sharp.versions.vips now comes from the
# loaded library, so the smoke test also asserts it is the version pkg-config
# saw when the binding was compiled.
RUN SMOKE_VIPS_VERSION="$(cat /app/.vips-version)" node /app/scripts/smoke-decode.js

EXPOSE 8800
ENV PORT=8800
ENV NODE_ENV=production
# Cap glibc per-thread malloc arenas: libvips spins up many native threads per
# worker and the default arena-per-thread strategy fragments badly, ballooning
# RSS until the box swaps. 2 arenas trades negligible alloc concurrency for far
# lower, stable RSS.
ENV MALLOC_ARENA_MAX=2
# Size the libuv threadpool. Sharp encodes, fs reads, dns.lookup and zlib all
# share it, and libuv's default is 4 threads per process. With encodes bounded
# by encode-limit.ts (2 per worker on the production shape) the default left 2
# slots for every cached-variant read and every mirror DNS lookup, and lowering
# num_workers would have raised the encode share to all 4. 16 keeps the encode
# cap CPU-driven and leaves the rest of the pool to the cheap work that makes up
# most requests. Thread stacks are virtual memory; 16 per worker is negligible.
# encode-limit.ts caps encodes to leave slots free whatever this is set to, and
# app.ts logs the resulting budget at boot. Note libuv reads this with atoi():
# a non-numeric value means ONE thread, not the default.
ENV UV_THREADPOOL_SIZE=16

HEALTHCHECK --interval=20s --timeout=10s --start-period=5s \
  CMD /bin/sh -c 'wget -nv -t1 -O /dev/null "http://localhost:${PORT}/healthcheck" || exit 1'

# tini as PID 1 reaps zombies. Node as PID 1 does not reap the /bin/sh that the
# HEALTHCHECK spawns every 20s, so those accumulate as <defunct> processes.
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "lib/app.js"]
