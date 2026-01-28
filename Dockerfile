FROM node:18-bullseye AS build

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
FROM node:18-slim

WORKDIR /app

RUN apt-get update && apt-get install -y \
  libvips \
  libheif1 \
  libde265-0 \
  libdav1d6 \
  libaom3 \
  wget \
  && rm -rf /var/lib/apt/lists/*

COPY --from=build /app/lib lib
COPY --from=build /app/config config
COPY --from=build /app/node_modules node_modules
COPY --from=build /app/healthCheck.ts healthCheck.ts

EXPOSE 8800
ENV PORT=8800
ENV NODE_ENV=production

HEALTHCHECK --interval=20s --timeout=10s --start-period=5s \
  CMD wget -nv -t1 --spider "http://localhost:8800/healthcheck" || exit 1

CMD ["node", "lib/app.js"]
