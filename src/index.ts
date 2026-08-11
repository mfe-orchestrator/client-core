import { getState } from "./state"
import { readIdentities } from "./storage"
import type { Identities, Manifest, OrchestratorConfig } from "./types"

export type { GlobalVariable, Identities, Manifest, Microfrontend, OrchestratorConfig } from "./types"

const PREFIX = "[@mfe-orchestrator-hub/client]"

const NOT_CONFIGURED = `${PREFIX} call configure() first. Configure the client at the very top of the host entry point, before anything imports a remote:

    import { configure } from "@mfe-orchestrator-hub/client"

    configure({ backendUrl: "…", projectId: "…", environment: "…" })`

const withoutTrailingSlash = (value: string): string => value.replace(/\/+$/, "")

const resolveUserId = async (userId: OrchestratorConfig["userId"]): Promise<string | undefined> => {
    const value = typeof userId === "function" ? await userId() : userId
    return value === undefined || value === null || value === "" ? undefined : String(value)
}

const sameConfig = (left: OrchestratorConfig, right: OrchestratorConfig): boolean =>
    left.backendUrl === right.backendUrl && left.projectId === right.projectId && left.environment === right.environment && left.userId === right.userId

const requireConfig = (config: OrchestratorConfig): void => {
    const missing = (["backendUrl", "projectId", "environment"] as const).filter(key => !config?.[key])
    if (missing.length > 0) {
        throw new Error(`${PREFIX} configure() is missing required option${missing.length > 1 ? "s" : ""}: ${missing.join(", ")}.`)
    }
}

const manifestUrl = async (config: OrchestratorConfig): Promise<string> => {
    const { sessionId, deviceId } = identities()
    const query = new URLSearchParams({ mfeSessionId: sessionId, mfeDeviceId: deviceId })
    // Resolved as late as possible: the host may only know the user after its own auth round trip.
    const userId = await resolveUserId(config.userId)
    if (userId) {
        query.set("mfeUserId", userId)
    }
    return `${withoutTrailingSlash(config.backendUrl)}/serve/all/${encodeURIComponent(config.projectId)}/${encodeURIComponent(config.environment)}?${query.toString()}`
}

const fetchManifest = async (config: OrchestratorConfig): Promise<Manifest> => {
    const url = await manifestUrl(config)
    // No retry in v1: whatever fetch throws travels straight to the caller.
    const response = await fetch(url, { headers: { accept: "application/json" } })
    if (!response.ok) {
        throw new Error(`${PREFIX} the manifest request failed with ${response.status} ${response.statusText}. GET ${url}`)
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
 * Idempotent: calling it again with the same options is a no op, so a framework provider may safely
 * call it on every render. A second call with different options is ignored, with a warning, because
 * the manifest of this page load may already be in flight or resolved.
 */
export const configure = (config: OrchestratorConfig): void => {
    requireConfig(config)
    const state = getState()
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
export const manifest = (): Promise<Manifest> => {
    const state = getState()
    const config = state.config
    if (!config) {
        // Not memoized: the host may still configure the client and try again.
        return Promise.reject(new Error(NOT_CONFIGURED))
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

/**
 * The ready to use, version pinned URL of a remote. Awaits the manifest internally.
 *
 * The returned URL is used verbatim: the host never parses the version out of it and never strips
 * the `_v/<version>/` segment, or a classic script would load its chunks off another version.
 */
export const remoteUrl = async (slug: string): Promise<string> => {
    const { microfrontends } = await manifest()
    const found = microfrontends.find(microfrontend => microfrontend.slug === slug)
    if (!found) {
        const available = microfrontends.map(microfrontend => `"${microfrontend.slug}"`).join(", ")
        const { environment } = getState().config ?? { environment: "?" }
        throw new Error(`${PREFIX} unknown microfrontend slug "${slug}". Available in environment "${environment}": ${available || "none, this environment serves no microfrontend"}.`)
    }
    if (!found.url) {
        throw new Error(`${PREFIX} the microfrontend "${slug}" is in the manifest but carries no url. Check its deployment in the console.`)
    }
    return found.url
}

/** The global variables of the environment, as a plain object. */
export const globalVariables = async (): Promise<Record<string, string>> => {
    const { globalVariables: variables } = await manifest()
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
