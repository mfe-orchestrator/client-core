# @mfe-orchestrator-hub/client

Framework agnostic client for [MFE Orchestrator](https://github.com/mfe-orchestrator). It asks the
console which microfrontends the current environment serves and hands back their ready to use,
version pinned URLs.

Zero runtime dependencies, ESM + CJS, ships its own types.

## The one rule

**The host page never decides which version it gets.** It sends the identities it holds and uses the
URL it receives verbatim. It does not parse the version out of the URL, does not draw any random
number, does not know that a canary exists. All of that lives in the backend.

## Install

```sh
pnpm add @mfe-orchestrator-hub/client
```

## Configure

Call `configure()` at the very top of the host entry point, before anything imports a remote.

```ts
import { configure } from "@mfe-orchestrator-hub/client"

configure({
    backendUrl: import.meta.env.VITE_MFE_BACKEND_URL,
    projectId: import.meta.env.VITE_MFE_PROJECT_ID
})
```

`backendUrl` and `projectId` are the only required options.

### Which environment am I?

`environment` is optional. Leave it out and the client calls the *auto* routes, where the backend
resolves the environment from the domain the request comes from — the domains you declared for each
environment in the console. One build then serves staging and production without an environment
variable to set per deployment.

```ts
// staging.example.com → the STAGING environment, production.example.com → PROD, decided by the backend
configure({ backendUrl: "…", projectId: "…" })
```

Pass it explicitly when the host already knows which environment it belongs to, or when one domain
has to serve several of them:

```ts
configure({
    backendUrl: import.meta.env.VITE_MFE_BACKEND_URL,
    projectId: import.meta.env.VITE_MFE_PROJECT_ID,
    environment: import.meta.env.VITE_MFE_ENVIRONMENT // ex. "DEV"
})
```

`configure()` is idempotent: calling it again with the same options is a no op, so a framework
provider may call it on every render. A second call with different options is ignored, with a
warning, because the manifest of this page load may already be in flight.

## Bundler configuration

The string below is injected into the host bundle, so the bare specifier is resolved by the host's
own bundler. This is exactly the form the console generates.

### Vite — `@originjs/vite-plugin-federation`

```js
federation({
    name: "shell",
    remotes: {
        checkoutnew: {
            external: `import('@mfe-orchestrator-hub/client').then(m => m.remoteUrl('checkout-new'))`,
            externalType: "promise"
        }
    },
    shared: ["react", "react-dom"]
})
```

### Webpack — `ModuleFederationPlugin`

```js
new ModuleFederationPlugin({
    name: "shell",
    remotes: {
        checkoutnew: `promise import('@mfe-orchestrator-hub/client').then(m => m.remoteUrl('checkout-new'))`
    },
    shared: { react: { singleton: true }, "react-dom": { singleton: true } }
})
```

### Where `backendUrl` and `projectId` come from

The remotes above resolve themselves through this client, so the bundle has to carry the two
required options. The console writes them into the bundler config itself rather than into a `.env`:
the config is the file it commits to your repository, so a fresh clone builds a bundle that already
knows which console to ask and which project to ask about, with no variable left to set.

```js
// vite.config.js
define: {
    "import.meta.env.VITE_MFE_BACKEND_URL": JSON.stringify("https://console.mfe-orchestrator.dev/api"),
    "import.meta.env.VITE_MFE_PROJECT_ID": JSON.stringify("6f1b2c3d4e5f6a7b8c9d0e1f")
}
```

```js
// webpack.config.js
new webpack.DefinePlugin({
    "process.env.MFE_BACKEND_URL": JSON.stringify("https://console.mfe-orchestrator.dev/api"),
    "process.env.MFE_PROJECT_ID": JSON.stringify("6f1b2c3d4e5f6a7b8c9d0e1f"),
    // Verbatim text: the bare `undefined` is what an unset environment looks like, and the backend
    // then resolves it from the domain. `process` does not exist in a browser, so leaving the key
    // out would throw instead of reading as undefined.
    "process.env.MFE_ENVIRONMENT": "undefined"
})
```

`configure()` keeps reading the same names either way — a `.env` still works if you prefer one.

## API

```ts
export interface OrchestratorConfig {
    backendUrl: string // ex. "https://console.mfe-orchestrator.dev/api"
    projectId: string
    environment?: string // environment slug, ex. "DEV". Omitted: resolved by the backend from the domain
    userId?: string | (() => string | undefined | Promise<string | undefined>)
}

/** Call once, synchronously, before any remote is imported. Idempotent. */
export function configure(config: OrchestratorConfig): void

/** Resolves the ready to use, version pinned URL of a remote. Awaits the manifest internally. */
export function remoteUrl(slug: string): Promise<string>

/** Whole manifest, fetched once and memoized. */
export function manifest(): Promise<Manifest>

/** Global variables of the environment, as a plain object. */
export function globalVariables(): Promise<Record<string, string>>

/** The two ids, exposed for telemetry/debugging. */
export function identities(): { sessionId: string; deviceId: string }
```

The types `Manifest`, `Microfrontend`, `GlobalVariable`, `Identities` and `OrchestratorConfig` are
exported as well.

### `remoteUrl(slug)`

```ts
import { remoteUrl } from "@mfe-orchestrator-hub/client"

const url = await remoteUrl("checkout-new")
// https://console…/serve/mfe/files/auto/<projectId>/checkout-new/_v/1.5.0-rc1/assets/remoteEntry.js
```

Use that URL as it is. Never rebuild it by hand and never strip the `_v/<version>/` segment: a
classic script (webpack `publicPath: "auto"`) derives the base of its chunks from
`document.currentScript.src`, which is the URL *before* any redirect, so without the segment already
in place it would request its chunks off a different version and mix two builds in one page.

An unknown slug rejects with a message listing the slugs the environment does serve.

### `globalVariables()`

```ts
const variables = await globalVariables()
// { API_URL: "https://…", FEATURE_FLAG: "on" }
```

### `identities()`

```ts
const { sessionId, deviceId } = identities()
```

## How it talks to the backend

One single successful request per page load, memoized as a promise so that concurrent callers share
it:

```
GET {backendUrl}/serve/all/{projectId}/{environment}
    ?mfeSessionId=<uuid>&mfeDeviceId=<uuid>&mfeUserId=<optional>
```

and, when no `environment` is configured, the same request on the auto route, where the backend
resolves the environment from the domain the request comes from:

```
GET {backendUrl}/serve/all/auto/{projectId}
    ?mfeSessionId=<uuid>&mfeDeviceId=<uuid>&mfeUserId=<optional>
```

### Why identities travel in the query string

Microfrontends are loaded with a cross-site `import()`. Module scripts are fetched with a fixed
`same-origin` credentials mode, so no cookie of the console domain is ever sent with them and no
`Set-Cookie` of ours is stored. The host page is the only place holding this state and the URL is the
only way to hand it over.

| query param | where it is kept | storage key | lifetime |
| --- | --- | --- | --- |
| `mfeSessionId` | `sessionStorage` | `mfe-orchestrator.sessionId` | dies with the browser session |
| `mfeDeviceId` | `localStorage` | `mfe-orchestrator.deviceId` | survives browser restarts |
| `mfeUserId` | supplied by the host app | — | not stored by the SDK |

All three are sent whenever available: the client does not know, and must not guess, which one the
backend uses.

`userId` may be a value, a getter, or an async getter. It is resolved as late as possible, right
before the request is issued, so a host that only knows its user after an auth round trip can pass a
function.

Both ids are generated with `crypto.randomUUID()` on first use and persisted. Storage can throw —
Safari in private mode, disabled storage, hardened browsers that throw on the property access
itself — and in that case the client falls back to ids held in memory for the lifetime of the page.
This never throws out of the SDK.

### Successes are cached, failures are not

A resolved manifest is memoized for the lifetime of the page. A failed attempt is not: when the
shared attempt settles as rejected, the memo is dropped, so the next call to `manifest()`,
`remoteUrl()` or `globalVariables()` starts a fresh request.

Every caller already waiting on the failed attempt still gets that rejection — the memo is cleared
once, when the attempt settles, not in each caller's own `catch` — so a failure rejects all of them
and costs exactly one request.

This is not a retry: nothing here loops, schedules or backs off. It only means that one flaky lookup
or one 502 during a console redeploy does not condemn the page to reject every `remoteUrl()` until a
full reload. Recovering is the host app's call, by asking again.

## When the configuration is wrong

`backendUrl` and `projectId` almost always come from build time variables, so the usual failure is
not a wrong value but a value that never reached the bundle. The client says so out loud instead of
firing a request at `undefined`:

```text
[@mfe-orchestrator-hub/client] configure() cannot start the client: projectId is not usable.

  • projectId is missing.
      → It is the id of the project in the console: open the project and copy it from its page, ex. "6f1b2c3d4e5f6a7b8c9d0e1f".
      → Nothing arrived here at all, which is what a value that never reached the bundle looks like: check VITE_MFE_PROJECT_ID (Vite) or MFE_PROJECT_ID (webpack) in the build that produced this bundle. The generated configs carry it in the "define" block of vite.config, or in the DefinePlugin of webpack.config, so look there first; declared only in a .env file the build never reads, it looks exactly like this.

Configure the client like this:

    import { configure } from "@mfe-orchestrator-hub/client"

    configure({
        backendUrl: "https://console.mfe-orchestrator.dev/api",
        projectId: "6f1b2c3d4e5f6a7b8c9d0e1f"
    })

Call it once, at the very top of the host entry point, before anything imports a remote.
```

`configure()` throws, before anything is stored, when an option is:

| What arrived | What the message says |
| --- | --- |
| `undefined`, `null`, `""`, `"   "` | missing or empty, plus the environment variable to check |
| `projectID`, `backend_url`, `apiUrl`… | the key the client ignores, and how the option is spelled |
| `"undefined"`, `"…"`, `"<your-project-id>"` | a placeholder that was never filled in |
| a number, an object, an array | the type it received, instead of a string |
| `"console.test/api"` | not a URL: the two forms that do work, with and without protocol |
| `"localhost:3000/api"` | a bare `host:port` is read as a scheme, write `http://localhost:3000/api` |
| `" p1 "` as `projectId` | padded with whitespace, which would be percent encoded into the URL |

Reading anything before `configure()` ran rejects with the same guidance, naming the call that was
made too early. A `404` on the manifest route says which two things the backend could not find, the
project id or the environment, since it answers the same status for both. Every message shows the
snippet of the package the host actually uses: `<OrchestratorProvider>` for React,
`createOrchestrator()` for Vue, `provideOrchestrator()` for Angular.

## Not in v1

No automatic retries, no offline caching, no service worker, and nothing that reads or writes
cookies. A network error is surfaced exactly as `fetch` produced it.

## Framework adapters

- React — [`@mfe-orchestrator-hub/client-react`](https://github.com/mfe-orchestrator/client-react)
- Vue — [`@mfe-orchestrator-hub/client-vue`](https://github.com/mfe-orchestrator/client-vue)
- Angular — [`@mfe-orchestrator-hub/client-angular`](https://github.com/mfe-orchestrator/client-angular)

They are ergonomics only: every decision lives here, in the core.

## Development

```sh
pnpm install
pnpm test        # vitest
pnpm build       # tsup, ESM + CJS + types
pnpm typecheck
```

## License

MIT © Lorenzo De Francesco
