# Vela

Vela is a remote browser for one person and their agents. It is Playwright,
Cloudflare Access, and a session registry, and nothing else.

- The **panel** at `/` opens and lists browser sessions. Each session has its
  own page at `/sessions/{id}`, where its pages, its live view, its MCP
  endpoint, and the close and set-default actions live.
- The **MCP surface** at `/mcp` and `/mcp/{session-id}` lets agents drive a
  browser with the same management core the panel uses.
- **Cloudflare Access** is the only authentication. Every request is verified
  against the Access assertion before anything else happens, unless Vela runs
  with `ENVIRONMENT=development`.

## Requirements

- Node.js 24 or newer.
- Chromium installed on `PATH` (Linux is the normal choice). Playwright launches
  it and drives it over a pipe; nothing listens on a socket.
- A Cloudflare Zero Trust team with an Access application in front of Vela.

## Install and run

```sh
npm install
cp .env.example .env   # then fill it in
ENVIRONMENT=development npm run dev   # http://localhost:8000
```

Production:

```sh
npm run build
npm start              # node .output/server/index.mjs
```

`PORT` and `HOST` are read by the Node server. Vela launches `chromium` from
`PATH`; install it from your distribution.

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

Every push runs the typecheck, the unit tests, the production build and the
end-to-end tests. Only a passing run publishes a `linux/amd64` image to GitHub
Container Registry, tagged `:latest`:

```sh
podman pull ghcr.io/lazzybit/vela:latest
```

The image is the production build from `npm run build` on Node.js 24 over
Debian 13, run as the non-root `node` user, with Debian's Chromium installed.
Configuration is injected as environment variables, exactly as for a source
install. Sessions and the default live in process memory, so the container
keeps no state and a restart starts empty; there is nothing to mount.

Debian's `chromium-sandbox` package installs a root-owned, setuid
`chrome-sandbox` helper, so Chromium keeps its sandbox even where the host
denies unprivileged user namespaces. The image installs that package, and Vela
launches the Chromium on `PATH`.

[`examples/vela.container`](examples/vela.container) is a system Podman
Quadlet unit for the published image. `UserNS=auto` allocates a user namespace
from the `containers` range in `/etc/subuid` and `/etc/subgid`, and the
namespaced `SYS_ADMIN` capability lets the setuid sandbox helper create
Chromium's PID and network namespaces:

```sh
sudo cp examples/vela.container /etc/containers/systemd/
sudo $EDITOR /etc/containers/systemd/vela.container   # both Access values
sudo systemctl daemon-reload
sudo systemctl enable --now vela.service
```

`UserNS=auto` only needs the `containers` subuid/subgid range, not a new user
account. The unit publishes no host port: run the Cloudflare Tunnel on the same
Podman network and point it at `http://vela:8000`, so the port is never bound to
the host and Access stays the only way in.

Build the image locally with:

```sh
podman build -f Containerfile -t vela .
```

Podman also reads the repository's `.dockerignore` as its ignore file, so the
build context stays small.

## Using the MCP surface

The MCP surface is Playwright MCP itself: the same tools, schemas, snapshots and
interactions, with one exception. `browser_close` is not advertised, because the
context belongs to the session and closing a session is the panel's job. A
client that calls the name anyway is refused by Playwright MCP.

Vela decides only which browser the tools may use.

MCP clients point at:

- `/mcp` — the default session. The default is resolved **once**, at
  `initialize`, and the connection stays with that browser.
- `/mcp/{session-id}` — one specific session. The id selects a target; it never
  grants access.

Because Access normally authenticates the request before it reaches the origin,
clients do not carry a token of their own. If your client runs outside Access and
you want to test it, it must supply the same `Cf-Access-Jwt-Assertion` header
Access would.

Sessions themselves are managed from the panel, not over MCP: opening and
listing happen at `/`, and closing a session or choosing the default happens on
that session's page at `/sessions/{id}`.

## Behaviour worth knowing

- Opening a session takes you to its page; closing one returns to the list. An
  unknown or closed session id sends you back to `/` with the registry's
  explanation.
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
- A live view is on demand. Start it on a session's page; Vela captures the page
  Chromium reports as visible (a background tab reports itself hidden), delivers
  it at the chosen frame rate, and stops the screencast when the last viewer
  disconnects or the page or session closes. Viewers share one capture.
- A page can run one screencast. If an MCP client is recording video from the
  active page, the live view reports that it is unavailable rather than taking
  over the recording.
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
(open/list/close/set-default, clearing the default, ids), cross-origin
rejection, and the live view (visible-page selection with fallback, shared
capture, per-viewer frame rate, and teardown).

`npm run test:e2e` starts the built server twice: once with
`ENVIRONMENT=development` to exercise the panel in a browser, its
server-function actions and the outcome each one reports, the session page and
its redirects (opening a session, closing one, and an unknown or closed id), the
live view stream, the MCP handshake, session binding verified by real navigation,
and a real Chromium driven through the MCP tools; and once in production mode to
confirm requests without an Access assertion are refused.
