FROM node:20-bookworm AS build

WORKDIR /app

RUN apt-get update && apt-get install -y \
  build-essential \
  git \
  python3 \
  && rm -rf /var/lib/apt/lists/*

COPY package.json yarn.lock ./
RUN yarn install --frozen-lockfile

COPY . .
RUN make lib

# --- Runtime image ---
FROM node:20-bookworm-slim

WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends \
  wget \
  && rm -rf /var/lib/apt/lists/*

COPY --from=build /app/lib lib
COPY --from=build /app/config config
COPY --from=build /app/node_modules node_modules

EXPOSE 8800
ENV PORT=8800
ENV NODE_ENV=production

HEALTHCHECK --interval=20s --timeout=10s --start-period=5s \
  CMD wget -nv -t1 --spider "http://localhost:8800/healthcheck" || exit 1

CMD ["node", "lib/app.js"]
