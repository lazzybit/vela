# Vela

Vela is a remote browser for one person and their agents. It is Playwright,
Cloudflare Access, and a session registry, and nothing else.

- The **panel** at `/` is a plain, one-column document for opening, listing,
  closing and selecting browser sessions.
- The **MCP surface** at `/mcp` and `/mcp/{session-id}` lets agents drive a
  browser with the same management core the panel uses.
- **Cloudflare Access** is the only authentication. Every request is verified
  against the Access assertion before anything else happens, unless Vela runs
  with `ENVIRONMENT=development`.

## Requirements

- Node.js 24 or newer.
- A host that can run Chromium through Playwright (Linux is the normal choice).
  Playwright is a library here: Chromium runs in-process and never listens on a
  socket.
- A Cloudflare Zero Trust team with an Access application in front of Vela.

## Install and run

```sh
npm install
cp .env.example .env   # then fill it in
ENVIRONMENT=development npm run dev   # http://localhost:3000
```

Production:

```sh
npm run build
npm start              # node .output/server/index.mjs
```

`PORT` and `HOST` are read by the Node server. Chromium is downloaded by the
`playwright` package on install; use `npx playwright install chromium` if it was
installed with browser downloads skipped.

## Configuration

`ENVIRONMENT=development` skips Access verification for local development.
Everything else — including a missing, empty or misspelled value — is
production, which refuses to serve any request until both Access values are set.
There is no second token and no allowlist.

| Variable                            | Meaning                                                      |
| ----------------------------------- | ------------------------------------------------------------ |
| `ENVIRONMENT`                       | `production` (default) or `development`.                     |
| `CLOUDFLARE_ACCESS_TEAM_DOMAIN`     | Your team domain only, e.g. `example.cloudflareaccess.com`.  |
| `CLOUDFLARE_ACCESS_APPLICATION_AUD` | The Access application's **Application Audience (AUD) tag**. |
| `PORT` / `HOST`                     | Optional bind address for the Node server.                   |

In production, verification checks the signature against the team JWKS
(`https://example.cloudflareaccess.com/cdn-cgi/access/certs`), the issuer, the
audience, the expiry and the `RS256` algorithm on every single request. The
JWKS fetch is cached; the check never is.

## Cloudflare Access

1. In Zero Trust, create a **Self-hosted** Access application for the hostname
   Vela is published on.
2. Add a policy that allows exactly the one person who should reach the browser.
   Vela has one identity and does not model tenancy; Access is the boundary.
3. Copy the application's **AUD tag** into `CLOUDFLARE_ACCESS_APPLICATION_AUD`
   and set `CLOUDFLARE_ACCESS_TEAM_DOMAIN` to your team domain.
4. Publish Vela through a Cloudflare Tunnel (or any origin behind Access) so the
   origin is never reachable directly. Access adds the `Cf-Access-Jwt-Assertion`
   header that Vela verifies.

## Container image

Every push publishes a `linux/amd64` image to GitHub Container Registry, tagged
`:latest`:

```sh
podman pull ghcr.io/lazzybit/vela:latest
```

The image is the production build from `npm run build` on Node.js 24 (the
current LTS) over Debian 13, run as the non-root `node` user, with the
Playwright version Vela locks and its Chromium already installed. Configuration
is injected as environment variables, exactly as for a source install. Sessions
and the default live in process memory, so the container keeps no state and a
restart starts empty; there is nothing to mount.

The image runs as a non-root user, so Chromium keeps its sandbox and needs to
create user namespaces. Podman's default seccomp profile already allows the
syscalls that requires, so no extra profile is needed. Pass `--init` and
`--ipc=host`, which are Playwright's container recommendations:

```sh
podman run --rm --init --ipc=host \
  -p 127.0.0.1:3000:3000 \
  -e CLOUDFLARE_ACCESS_TEAM_DOMAIN=example.cloudflareaccess.com \
  -e CLOUDFLARE_ACCESS_APPLICATION_AUD=<application-aud> \
  ghcr.io/lazzybit/vela:latest
```

`--init` reaps Chromium's helper processes and `--ipc=host` gives Chromium the
shared memory it needs. The image binds `HOST=0.0.0.0` and `PORT=3000`. Do not
expose the port beyond the host: reach it through a Cloudflare Tunnel, because
Access is the only authentication. Under Docker, whose default seccomp profile
blocks user-namespace creation, add Playwright's `seccomp_profile.json` with
`--security-opt`.

Build the image locally with:

```sh
podman build -f Containerfile -t vela .
```

Podman also reads the repository's `.dockerignore` as its ignore file, so the
build context stays small.

[`examples/vela.container`](examples/vela.container) runs the published image as
a rootful Podman Quadlet unit.

## Using the MCP surface

The MCP surface is Playwright MCP itself: the same tools, schemas, snapshots and
interactions. Vela decides only which browser they may use.

MCP clients point at:

- `/mcp` — the default session. The default is resolved **once**, at
  `initialize`, and the connection stays with that browser.
- `/mcp/{session-id}` — one specific session. The id selects a target; it never
  grants access.

Because Access normally authenticates the request before it reaches the origin,
clients do not carry a token of their own. If your client runs outside Access and
you want to test it, it must supply the same `Cf-Access-Jwt-Assertion` header
Access would.

Sessions themselves are managed from the panel, not over MCP: opening, listing,
closing and choosing the default all happen at `/`. The panel's forms are server
functions and work without JavaScript.

`browser_close` refuses to close Vela's context, because the context belongs to
the session, not to the connection.

## Behaviour worth knowing

- A browser session owns a `BrowserContext` and outlives the MCP transport that
  created it. Dropping a connection never closes a browser.
- Closing the default session clears the default and says so. Existing
  connections keep the browser they bound to; nobody is quietly reassigned.
- A connection bound to a session that later closes gets an explicit error from
  the browser tools. It never retargets itself.
- `/mcp` without a default, or `/mcp/{id}` for an unknown session, is refused
  with an explicit error.
- State-changing requests from a browser must be same-origin. Non-browser MCP
  clients are unaffected.
- `SIGINT`/`SIGTERM` close MCP transports and the browser.

## Commands

```sh
npm run dev        # development server
npm run build      # production build (.output/server/index.mjs)
npm start          # run the production build
npm run typecheck  # tsc --noEmit
npm test           # unit and protocol tests (no browser needed)
npm run test:e2e   # end-to-end tests; needs a build and a Chromium install
```

## Tests

`npm test` covers assertion verification (valid, wrong audience/issuer/key,
expired, algorithm confusion, missing configuration), that only an explicit
`ENVIRONMENT=development` skips verification, the session registry
(open/list/close/set-default, clearing the default, ids) and cross-origin
rejection.

`npm run test:e2e` starts the built server twice: once with
`ENVIRONMENT=development` to
exercise the panel document (driven in a browser with JavaScript disabled), its
server-function forms, the MCP handshake, session binding verified by real
navigation, and a real Chromium driven through the MCP tools; and once in
production mode to confirm requests without an Access assertion are refused. It
needs `npm run build` first and a Playwright Chromium install.
