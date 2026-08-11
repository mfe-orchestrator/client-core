import type { Identities } from "./types"

export const SESSION_ID_KEY = "mfe-orchestrator.sessionId"
export const DEVICE_ID_KEY = "mfe-orchestrator.deviceId"

const PROBE_KEY = "mfe-orchestrator.probe"

type StorageKind = "local" | "session"

/**
 * Ids minted while storage was unusable. They live for the lifetime of the page so that, even
 * without storage, every request of this page load carries one stable pair of ids.
 */
const inMemoryIds = new Map<string, string>()

const uuidFromRandomBytes = (bytes: Uint8Array): string => {
    bytes[6] = (bytes[6] & 0x0f) | 0x40
    bytes[8] = (bytes[8] & 0x3f) | 0x80
    const hex: string[] = []
    for (const byte of bytes) {
        hex.push(byte.toString(16).padStart(2, "0"))
    }
    return `${hex.slice(0, 4).join("")}-${hex.slice(4, 6).join("")}-${hex.slice(6, 8).join("")}-${hex.slice(8, 10).join("")}-${hex.slice(10, 16).join("")}`
}

/**
 * A v4 UUID. `crypto.randomUUID` is the intended path; the two fallbacks only exist so that a page
 * served over plain http, or an exotic runtime, still gets an id instead of an exception.
 */
export const newId = (): string => {
    const cryptoApi = globalThis.crypto
    try {
        if (typeof cryptoApi?.randomUUID === "function") {
            return cryptoApi.randomUUID()
        }
        if (typeof cryptoApi?.getRandomValues === "function") {
            return uuidFromRandomBytes(cryptoApi.getRandomValues(new Uint8Array(16)))
        }
    } catch {
        // fall through to the non cryptographic fallback
    }
    const bytes = new Uint8Array(16)
    for (let index = 0; index < bytes.length; index++) {
        bytes[index] = Math.floor(Math.random() * 256)
    }
    return uuidFromRandomBytes(bytes)
}

/**
 * The requested storage, or `null` when it is missing or unusable.
 *
 * Both the property access and the write can throw: Safari in private mode exposes the object and
 * then refuses `setItem`, some hardened browsers throw a SecurityError on the access itself. The
 * write probe is the only reliable way to tell a usable storage from a decorative one.
 */
const openStorage = (kind: StorageKind): Storage | null => {
    try {
        const storage = kind === "local" ? globalThis.localStorage : globalThis.sessionStorage
        if (!storage) {
            return null
        }
        storage.setItem(PROBE_KEY, "1")
        storage.removeItem(PROBE_KEY)
        return storage
    } catch {
        return null
    }
}

/**
 * The id under `key`, read from storage and created on first use. Falls back to an id kept in
 * memory when storage cannot be used, so this never throws out of the SDK.
 */
const persistentId = (kind: StorageKind, key: string): string => {
    const storage = openStorage(kind)
    if (storage) {
        try {
            const stored = storage.getItem(key)
            if (stored) {
                return stored
            }
            const created = newId()
            storage.setItem(key, created)
            return created
        } catch {
            // storage passed the probe and failed anyway: keep going with an in memory id
        }
    }
    const remembered = inMemoryIds.get(key)
    if (remembered) {
        return remembered
    }
    const created = newId()
    inMemoryIds.set(key, created)
    return created
}

/** Reads, and creates when needed, the session and device ids. */
export const readIdentities = (): Identities => ({
    sessionId: persistentId("session", SESSION_ID_KEY),
    deviceId: persistentId("local", DEVICE_ID_KEY)
})
