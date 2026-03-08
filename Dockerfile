FROM node:20-bookworm AS build

WORKDIR /app

RUN apt-get update && apt-get install -y \
  build-essential \
  git \
  curl \
  libvips-dev \
  libheif-dev \
  libde265-dev \
  libaom-dev \
  libx265-dev \
  libdav1d-dev \
  pkg-config \
  wget \
  && rm -rf /var/lib/apt/lists/*

COPY package.json yarn.lock ./
RUN yarn install --frozen-lockfile

COPY . .
RUN make lib

# --- Runtime image ---
FROM node:20-slim

WORKDIR /app

RUN apt-get update && apt-get install -y \
  libvips42 \
  libheif1 \
  libde265-0 \
  libdav1d7 \
  libaom3 \
  wget \
  && rm -rf /var/lib/apt/lists/*

RUN groupadd -r app && useradd -r -g app -d /app app && chown app:app /app

COPY --from=build --chown=app:app /app/lib lib
COPY --from=build --chown=app:app /app/config config
COPY --from=build --chown=app:app /app/node_modules node_modules
COPY --from=build --chown=app:app /app/healthCheck.ts healthCheck.ts

USER app

EXPOSE 8800
ENV PORT=8800
ENV NODE_ENV=production

HEALTHCHECK --interval=20s --timeout=10s --start-period=5s \
  CMD wget -nv -t1 --spider "http://localhost:8800/healthcheck" || exit 1

CMD ["node", "lib/app.js"]
