/**
 * Configuration of the orchestrator client. Handed over once, at the very top of the host entry point.
 */
export interface OrchestratorConfig {
    /** Base URL of the console API, ex. "https://console.mfe-orchestrator.dev/api". */
    backendUrl: string
    /** Id of the project the host belongs to. */
    projectId: string
    /**
     * Environment slug, ex. "DEV". Optional: when it is omitted the client calls the "auto" routes
     * and the backend resolves the environment from the domain the request comes from, out of the
     * domains declared for each environment in the console. Pass it explicitly whenever the host
     * already knows which environment it belongs to, or when one domain serves several of them.
     */
    environment?: string
    /**
     * Identity of the logged in user, if the host has one. May be a plain value, a getter, or an
     * async getter resolved right before the manifest request is issued.
     *
     * A host that only learns its user later may leave it out here and call `setUserId()` when the
     * user logs in, logs out or is switched: unlike a second `configure()`, that one takes effect,
     * because it drops the memoized manifest.
     */
    userId?: string | (() => string | undefined | Promise<string | undefined>)
}

/** A single environment variable of the deployment. */
export interface GlobalVariable {
    key: string
    value: string
}

/** A microfrontend as served by the console for the current environment. */
export interface Microfrontend {
    /** Stable, human readable id of the microfrontend. */
    slug: string
    /** Display name. */
    name: string
    /** Federation safe name, the one used as the remote key in the bundler config. */
    nameToIntegrate: string
    /** Version actually served. Informative only: never rebuild the URL out of it. */
    version: string
    continuousDeployment: boolean
    /** Ready to use, already version pinned URL of the remote entry. Use it verbatim. */
    url: string
}

/**
 * The whole payload of `GET {backendUrl}/serve/all/{projectId}/{environmentSlug}`, or of
 * `GET {backendUrl}/serve/all/auto/{projectId}` when no environment is configured.
 */
export interface Manifest {
    globalVariables: GlobalVariable[]
    microfrontends: Microfrontend[]
}

/** The two ids the host holds on behalf of the backend. */
export interface Identities {
    sessionId: string
    deviceId: string
}
