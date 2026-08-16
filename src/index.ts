import { diagnoseConfig, type Integration, invalidConfigMessage, noConfigMessage, notConfiguredMessage, PREFIX } from "./errors"
import { getState } from "./state"
import { readIdentities } from "./storage"
import type { Identities, Manifest, OrchestratorConfig } from "./types"

export type { ConfigProblem, Integration } from "./errors"
export type { GlobalVariable, Identities, Manifest, Microfrontend, OrchestratorConfig } from "./types"

const withoutTrailingSlash = (value: string): string => value.replace(/\/+$/, "")

const resolveUserId = async (userId: OrchestratorConfig["userId"]): Promise<string | undefined> => {
    const value = typeof userId === "function" ? await userId() : userId
    return value === undefined || value === null || value === "" ? undefined : String(value)
}

const sameConfig = (left: OrchestratorConfig, right: OrchestratorConfig): boolean =>
    left.backendUrl === right.backendUrl && left.projectId === right.projectId && left.environment === right.environment && left.userId === right.userId

/**
 * Rejects a configuration the client could not use, with a message that names the option, shows what
 * actually arrived and prints the call to write. environment is deliberately not required: without
 * it the backend resolves it from the domain. It is still checked for type, because a non string
 * there would silently end up percent encoded into the path.
 */
const requireConfig = (config: OrchestratorConfig, integration: Integration): void => {
    if (typeof config !== "object" || config === null) {
        throw new Error(noConfigMessage(config, integration))
    }
    const problems = diagnoseConfig(config)
    if (problems.length > 0) {
        throw new Error(invalidConfigMessage(problems, integration))
    }
    if (config.environment !== undefined && config.environment !== null && typeof config.environment !== "string") {
        throw new Error(
            `${PREFIX} configure() received environment as a ${typeof config.environment}, not a string. Pass the environment slug as it appears in the console, ex. "DEV", or leave it out to let the backend resolve it from the domain of this page.`
        )
    }
}

/** Notices about a stored configuration that works but probably does not do what the host meant. */
const warnAboutConfig = (config: OrchestratorConfig): void => {
    if (typeof config.environment === "string" && config.environment.trim() === "") {
        console.warn(
            `${PREFIX} configure() received an empty environment, so the client falls back to the auto routes and the backend resolves the environment from the domain of this page. Remove the option if that is what you want, or check the variable that feeds it.`
        )
    }
}

/**
 * Two shapes, one per route family. With an explicit environment the slug is the last segment; with
 * no environment the "auto" segment takes its place before the project id and the backend resolves
 * the environment from the domain the request comes from.
 */
const manifestPath = (config: OrchestratorConfig): string => {
    const projectId = encodeURIComponent(config.projectId)
    return config.environment ? `/serve/all/${projectId}/${encodeURIComponent(config.environment)}` : `/serve/all/auto/${projectId}`
}

const manifestUrl = async (config: OrchestratorConfig): Promise<string> => {
    const { sessionId, deviceId } = identities()
    const query = new URLSearchParams({ mfeSessionId: sessionId, mfeDeviceId: deviceId })
    // Resolved as late as possible: the host may only know the user after its own auth round trip.
    const userId = await resolveUserId(config.userId)
    if (userId) {
        query.set("mfeUserId", userId)
    }
    return `${withoutTrailingSlash(config.backendUrl)}${manifestPath(config)}?${query.toString()}`
}

/**
 * What a status usually means on this route. The backend answers the same 404 for an unknown project
 * and for an unknown environment, and the two are indistinguishable from here, so both are named.
 */
const statusHint = (status: number, config: OrchestratorConfig): string => {
    if (status === 404) {
        const environment = config.environment
            ? `the environment "${config.environment}" does not exist in it`
            : "no environment of that project declares the domain this page is served on, which is what the auto route resolves on"
        return `\n\nA 404 on this route means the backend did not find what the URL names: either the project id "${config.projectId}" is not a project of this console, or ${environment}. Check both in the console, and check that backendUrl points at the console API of the same instance.`
    }
    if (status === 401 || status === 403) {
        return `\n\nThe console refused the request. Check that the project id "${config.projectId}" belongs to the instance backendUrl points at, and that this domain is allowed to read its manifest.`
    }
    return ""
}

const fetchManifest = async (config: OrchestratorConfig): Promise<Manifest> => {
    const url = await manifestUrl(config)
    // No retry in v1: whatever fetch throws travels straight to the caller.
    const response = await fetch(url, { headers: { accept: "application/json" } })
    if (!response.ok) {
        throw new Error(`${PREFIX} the manifest request failed with ${response.status} ${response.statusText}. GET ${url}${statusHint(response.status, config)}`)
    }
    const payload = (await response.json()) as Partial<Manifest> | null
    return {
        globalVariables: payload?.globalVariables ?? [],
        microfrontends: payload?.microfrontends ?? []
    }
}

/**
 * Hands the client its configuration. Call it once, synchronously, before any remote is imported.
 *
 * `backendUrl` and `projectId` are required. `environment` is not: omitting it makes the client use
 * the "auto" routes, where the backend resolves the environment from the domain of the host page.
 *
 * Idempotent: calling it again with the same options is a no op, so a framework provider may safely
 * call it on every render. A second call with different options is ignored, with a warning, because
 * the manifest of this page load may already be in flight or resolved.
 */
export const configure = (config: OrchestratorConfig): void => {
    const state = getState()
    requireConfig(config, state.integration)
    const current = state.config
    if (current) {
        if (!sameConfig(current, config)) {
            console.warn(
                `${PREFIX} configure() was called again with a different configuration. The first one is kept: ${JSON.stringify({ backendUrl: current.backendUrl, projectId: current.projectId, environment: current.environment })}.`
            )
        }
        return
    }
    state.config = { ...config }
    warnAboutConfig(config)
}

/**
 * @internal Lets a framework adapter say which package the host is really using, so a configuration
 * error prints the snippet of that API instead of the bare `configure()` one. Idempotent, and never
 * needed by an application: the adapters call it as they load.
 */
export const registerIntegration = (integration: Integration): void => {
    getState().integration = integration
}

/**
 * The whole manifest of the environment, fetched once per page load and memoized as a promise, so
 * that concurrent callers share the single request in flight.
 *
 * A successful result is memoized for good. A failed attempt is not: the memo is dropped when the
 * shared attempt settles as rejected, so the next caller starts a fresh request. That is not a retry
 * — nothing here loops or backs off — it only means one flaky lookup at boot does not condemn the
 * page to reject every `remoteUrl()` until a full reload.
 */
const loadManifest = (caller: string): Promise<Manifest> => {
    const state = getState()
    const config = state.config
    if (!config) {
        // Not memoized: the host may still configure the client and try again.
        return Promise.reject(new Error(notConfiguredMessage(caller, state.integration)))
    }
    if (!state.manifestPromise) {
        // Assigned before the first await inside fetchManifest, which is what makes N concurrent
        // callers collapse onto one request.
        const attempt = fetchManifest(config)
        state.manifestPromise = attempt
        // Cleared once, when the shared attempt settles, not in each caller's own catch: every
        // caller already waiting on this attempt still gets its rejection. The identity check keeps
        // a late failure from evicting a newer attempt.
        attempt.catch(() => {
            if (state.manifestPromise === attempt) {
                state.manifestPromise = null
            }
        })
    }
    return state.manifestPromise
}

/** The whole manifest of the environment. See `loadManifest` for the memoization contract. */
export const manifest = (): Promise<Manifest> => loadManifest("manifest()")

/**
 * The ready to use, version pinned URL of a remote. Awaits the manifest internally.
 *
 * The returned URL is used verbatim: the host never parses the version out of it and never strips
 * the `_v/<version>/` segment, or a classic script would load its chunks off another version.
 */
export const remoteUrl = async (slug: string): Promise<string> => {
    const { microfrontends } = await loadManifest(`remoteUrl("${slug}")`)
    const found = microfrontends.find(microfrontend => microfrontend.slug === slug)
    if (!found) {
        const available = microfrontends.map(microfrontend => `"${microfrontend.slug}"`).join(", ")
        const environment = getState().config?.environment
        // With no configured environment the host cannot name the one it was served: only the backend knows.
        const where = environment ? `environment "${environment}"` : "the environment resolved from this domain"
        throw new Error(`${PREFIX} unknown microfrontend slug "${slug}". Available in ${where}: ${available || "none, this environment serves no microfrontend"}.`)
    }
    if (!found.url) {
        throw new Error(`${PREFIX} the microfrontend "${slug}" is in the manifest but carries no url. Check its deployment in the console.`)
    }
    return found.url
}

/** The global variables of the environment, as a plain object. */
export const globalVariables = async (): Promise<Record<string, string>> => {
    const { globalVariables: variables } = await loadManifest("globalVariables()")
    const result: Record<string, string> = {}
    for (const variable of variables) {
        if (variable && typeof variable.key === "string") {
            result[variable.key] = variable.value
        }
    }
    return result
}

/**
 * The session and device ids of this page, exposed for telemetry and debugging. Created on first
 * use and stable for the lifetime of the page, whether or not storage is available.
 */
export const identities = (): Identities => {
    const state = getState()
    if (!state.identities) {
        state.identities = readIdentities()
    }
    return state.identities
}
