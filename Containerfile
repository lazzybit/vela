# Vela's container image: the production build from `npm run build`, Chromium
# installed with the Playwright version the lockfile pins, and nothing else.
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

# `.output` is self-contained: Nitro traces `playwright-core` into
# `.output/server/node_modules`, so the runtime image does not keep a source
# `node_modules`. The Playwright CLI is installed only to download Chromium and
# its OS dependencies, then removed.
ENV NODE_ENV=production \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright \
    HOST=0.0.0.0 \
    PORT=8000

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev \
    && npx playwright install --with-deps chromium \
    && rm -rf node_modules /root/.npm

COPY --from=build /app/.output ./.output

# The runtime user owns the application directory so Playwright MCP can write
# its default `./.playwright-mcp` output next to the build, and so Chromium can
# use a writable working directory.
RUN chown -R node:node /app

# A non-root user keeps Chromium's sandbox enabled. The container runtime must
# allow Chromium to create user namespaces; see the README.
USER node

EXPOSE 8000

CMD ["node", ".output/server/index.mjs"]
