import type { Integration } from "./errors"
import type { Identities, Manifest, OrchestratorConfig } from "./types"

export interface OrchestratorState {
    config: OrchestratorConfig | null
    manifestPromise: Promise<Manifest> | null
    identities: Identities | null
    /** Set by the framework adapters as they load, so an error prints the snippet of their own API. */
    integration: Integration
}

/**
 * The state lives on `globalThis` under this key, not in a module scope variable.
 *
 * A host can end up with two copies of this package loaded at once: the app imports the ESM build
 * while something else pulls the CJS one, or the bundler config and the app resolve to different
 * chunks. Two module scopes would mean two configurations and two manifest requests, which is
 * exactly what the contract forbids. One well known global slot makes the singleton real.
 */
export const STATE_KEY = "__mfe_orchestrator_client__"

const globalSlot = globalThis as typeof globalThis & Record<typeof STATE_KEY, OrchestratorState | undefined>

export const getState = (): OrchestratorState => {
    let state = globalSlot[STATE_KEY]
    if (!state) {
        state = { config: null, manifestPromise: null, identities: null, integration: "core" }
        globalSlot[STATE_KEY] = state
    }
    return state
}
