# Vela's container image: the production build from `npm run build`, Debian's
# Chromium, and nothing else.
#
# Chromium is a child process that Playwright drives over a pipe and never
# listens on a socket, so the image exposes only the application port.

FROM node:24-trixie-slim AS build

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY . .
RUN npm run build

FROM node:24-trixie-slim AS runtime

# `.output` is self-contained: Nitro traces `playwright` and `playwright-core`
# into `.output/server/node_modules`, so the runtime image needs neither a
# source `node_modules` nor a downloaded browser.
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8000

WORKDIR /app

# Debian's `chromium-sandbox` package installs a root-owned setuid
# `chrome-sandbox` helper, so the browser keeps its sandbox even where the host
# denies unprivileged user namespaces. Playwright's downloaded browser has no
# helper and would fail.
RUN apt-get update \
    && apt-get install -y --no-install-recommends chromium chromium-sandbox fonts-liberation \
    && rm -rf /var/lib/apt/lists/*

# Chromium aborts on an AppArmor denial while probing unprivileged user
# namespaces instead of falling back. The Debian wrapper sources this flag so
# the browser uses the setuid helper from `chromium-sandbox`; seccomp remains.
RUN printf '%s\n' 'export CHROMIUM_FLAGS="$CHROMIUM_FLAGS --disable-namespace-sandbox"' \
    > /etc/chromium.d/zz-vela

COPY --from=build /app/.output ./.output

# The runtime user owns the application directory so Playwright MCP can write
# its default `./.playwright-mcp` output next to the build, and so Chromium can
# use a writable working directory.
RUN chown -R node:node /app

USER node

EXPOSE 8000

CMD ["node", ".output/server/index.mjs"]
