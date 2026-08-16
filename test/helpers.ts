import { vi } from "vitest"
import { STATE_KEY } from "../src/state"
import type { Manifest, OrchestratorConfig } from "../src/types"

/** A configuration a TypeScript host could not write, but a JavaScript one hands over every day. */
export const asConfig = (config: unknown): OrchestratorConfig => config as OrchestratorConfig

/** The message of what `run` throws, so a test can assert several things about one message. */
export const attempt = (run: () => void): string => {
    try {
        run()
    } catch (thrown) {
        return thrown instanceof Error ? thrown.message : String(thrown)
    }
    throw new Error("expected the call to throw, it did not")
}

export const manifestFixture: Manifest = {
    globalVariables: [
        { key: "API_URL", value: "https://api.example.test" },
        { key: "FEATURE_FLAG", value: "on" }
    ],
    microfrontends: [
        {
            slug: "checkout-new",
            name: "Checkout",
            nameToIntegrate: "checkoutnew",
            version: "1.5.0-rc1",
            continuousDeployment: true,
            url: "https://console.test/serve/mfe/files/auto/p1/checkout-new/_v/1.5.0-rc1/assets/remoteEntry.js"
        },
        {
            slug: "catalog",
            name: "Catalog",
            nameToIntegrate: "catalog",
            version: "2.0.0",
            continuousDeployment: false,
            url: "https://console.test/serve/mfe/files/auto/p1/catalog/_v/2.0.0/assets/remoteEntry.js"
        }
    ]
}

export const baseConfig = {
    backendUrl: "https://console.test/api",
    projectId: "p1",
    environment: "DEV"
}

/** The same host without an environment: the backend resolves it from the domain of the request. */
export const autoConfig = {
    backendUrl: baseConfig.backendUrl,
    projectId: baseConfig.projectId
}

/**
 * A fresh module registry AND a fresh global state slot, which together simulate a new page load.
 * Storage contents deliberately survive, so a test can prove that ids are read back.
 */
export const loadSdk = async () => {
    vi.resetModules()
    delete (globalThis as unknown as Record<string, unknown>)[STATE_KEY]
    return await import("../src/index")
}

export interface FakeStorage extends Storage {
    readonly dump: Record<string, string>
}

export const createMemoryStorage = (): FakeStorage => {
    const entries = new Map<string, string>()
    return {
        get length() {
            return entries.size
        },
        get dump() {
            return Object.fromEntries(entries)
        },
        getItem: (key: string) => entries.get(key) ?? null,
        setItem: (key: string, value: string) => {
            entries.set(key, value)
        },
        removeItem: (key: string) => {
            entries.delete(key)
        },
        clear: () => {
            entries.clear()
        },
        key: (index: number) => [...entries.keys()][index] ?? null
    }
}

/** Safari in private mode: the object is there, every write throws a QuotaExceededError. */
export const createThrowingStorage = (): Storage => ({
    length: 0,
    getItem: () => null,
    setItem: () => {
        throw new DOMException("The quota has been exceeded.", "QuotaExceededError")
    },
    removeItem: () => {
        throw new DOMException("The quota has been exceeded.", "QuotaExceededError")
    },
    clear: () => {},
    key: () => null
})

export const installStorage = (local: Storage | null, session: Storage | null): void => {
    for (const [name, value] of [
        ["localStorage", local],
        ["sessionStorage", session]
    ] as const) {
        Object.defineProperty(globalThis, name, { value, configurable: true, writable: true })
    }
}

/** Hardened browsers throw a SecurityError on the property access itself. */
export const installExplodingStorageAccess = (): void => {
    for (const name of ["localStorage", "sessionStorage"]) {
        Object.defineProperty(globalThis, name, {
            configurable: true,
            get() {
                throw new DOMException("Access to storage is not allowed from this context.", "SecurityError")
            }
        })
    }
}

export const stubFetchOnce = (payload: unknown, init: { ok?: boolean; status?: number; statusText?: string } = {}) => {
    const fetchMock = vi.fn(async () => ({
        ok: init.ok ?? true,
        status: init.status ?? 200,
        statusText: init.statusText ?? "OK",
        json: async () => payload
    }))
    vi.stubGlobal("fetch", fetchMock)
    return fetchMock
}

/**
 * A backend that fails its first `failures` calls and serves `payload` from then on. `Infinity`
 * never recovers.
 */
export const stubFlakyFetch = (failures: number, payload: unknown = manifestFixture) => {
    let calls = 0
    const fetchMock = vi.fn(async () => {
        calls++
        if (calls <= failures) {
            throw new TypeError("Failed to fetch")
        }
        return {
            ok: true,
            status: 200,
            statusText: "OK",
            json: async () => payload
        }
    })
    vi.stubGlobal("fetch", fetchMock)
    return fetchMock
}

export const requestedUrl = (fetchMock: ReturnType<typeof vi.fn>, call = 0): URL => new URL(requestedHref(fetchMock, call))

/** The raw first argument of a call, for a backendUrl that is a path and has no origin to parse. */
export const requestedHref = (fetchMock: ReturnType<typeof vi.fn>, call = 0): string => String(fetchMock.mock.calls[call]?.[0])
