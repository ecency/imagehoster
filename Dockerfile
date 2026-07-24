# --- Stage 1: Build libvips from source with dav1d (full AV1 decode support) ---
FROM node:20-bookworm AS vips-builder

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

# Build dav1d (fast AV1 decoder with full profile/bitstream support)
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

# Build libheif (HEIF/AVIF container — links to dav1d for AV1, libde265 for HEVC, libaom for encode)
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
RUN yarn install --frozen-lockfile
# Replace Sharp's bundled libvips-cpp.so with our custom build (includes dav1d AVIF support)
RUN cp /usr/local/lib/x86_64-linux-gnu/libvips-cpp.so.42 \
  node_modules/@img/sharp-libvips-linux-x64/lib/libvips-cpp.so.42

COPY . .
RUN make lib

# --- Runtime image ---
FROM node:20-bookworm-slim

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

# Copy custom-built shared libraries (dav1d, libaom, libheif, libvips)
COPY --from=vips-builder /usr/local/lib/ /usr/local/lib/
RUN ldconfig

COPY --from=build /app/lib lib
COPY --from=build /app/config config
COPY --from=build /app/node_modules node_modules

EXPOSE 8800
ENV PORT=8800
ENV NODE_ENV=production
# Cap glibc per-thread malloc arenas: libvips spins up many native threads per
# worker and the default arena-per-thread strategy fragments badly, ballooning
# RSS until the box swaps. 2 arenas trades negligible alloc concurrency for far
# lower, stable RSS.
ENV MALLOC_ARENA_MAX=2

HEALTHCHECK --interval=20s --timeout=10s --start-period=5s \
  CMD /bin/sh -c 'wget -nv -t1 --spider "http://localhost:${PORT}/healthcheck" || exit 1'

# tini as PID 1 reaps zombies. Node as PID 1 does not reap the /bin/sh that the
# HEALTHCHECK spawns every 20s, so those accumulate as <defunct> processes.
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "lib/app.js"]
