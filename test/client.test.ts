import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { DEVICE_ID_KEY, SESSION_ID_KEY } from "../src/storage"
import {
    asConfig,
    attempt,
    autoConfig,
    baseConfig,
    createMemoryStorage,
    createThrowingStorage,
    type FakeStorage,
    installExplodingStorageAccess,
    installStorage,
    loadSdk,
    manifestFixture,
    requestedHref,
    requestedUrl,
    stubFetchOnce,
    stubFlakyFetch
} from "./helpers"

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

describe("@mfe-orchestrator-hub/client", () => {
    let local: FakeStorage
    let session: FakeStorage

    beforeEach(() => {
        local = createMemoryStorage()
        session = createMemoryStorage()
        installStorage(local, session)
    })

    afterEach(() => {
        vi.unstubAllGlobals()
    })

    describe("manifest memoization", () => {
        it("given N concurrent remoteUrl calls, when the manifest is not loaded yet, then a single fetch is issued and every caller gets its url", async () => {
            const fetchMock = stubFetchOnce(manifestFixture)
            const sdk = await loadSdk()
            sdk.configure(baseConfig)

            const results = await Promise.all([sdk.remoteUrl("checkout-new"), sdk.remoteUrl("catalog"), sdk.remoteUrl("checkout-new"), sdk.remoteUrl("catalog"), sdk.remoteUrl("checkout-new")])

            expect(fetchMock).toHaveBeenCalledTimes(1)
            expect(results).toEqual([
                manifestFixture.microfrontends[0].url,
                manifestFixture.microfrontends[1].url,
                manifestFixture.microfrontends[0].url,
                manifestFixture.microfrontends[1].url,
                manifestFixture.microfrontends[0].url
            ])
        })

        it("given the manifest was already fetched, when manifest, remoteUrl and globalVariables are called again, then no further fetch happens", async () => {
            const fetchMock = stubFetchOnce(manifestFixture)
            const sdk = await loadSdk()
            sdk.configure(baseConfig)

            await sdk.manifest()
            await sdk.remoteUrl("catalog")
            await sdk.globalVariables()
            await sdk.manifest()

            expect(fetchMock).toHaveBeenCalledTimes(1)
        })

        it("given a remote entry in the manifest, when its url is resolved, then it is returned verbatim with the version segment untouched", async () => {
            stubFetchOnce(manifestFixture)
            const sdk = await loadSdk()
            sdk.configure(baseConfig)

            const url = await sdk.remoteUrl("checkout-new")

            expect(url).toBe("https://console.test/serve/mfe/files/auto/p1/checkout-new/_v/1.5.0-rc1/assets/remoteEntry.js")
            expect(url).toContain("/_v/1.5.0-rc1/")
        })
    })

    describe("identity query string", () => {
        it("given a configured userId, when the manifest is fetched, then mfeSessionId, mfeDeviceId and mfeUserId all travel in the query string", async () => {
            const fetchMock = stubFetchOnce(manifestFixture)
            const sdk = await loadSdk()
            sdk.configure({ ...baseConfig, userId: "user-42" })

            await sdk.manifest()

            const url = requestedUrl(fetchMock)
            expect(url.pathname).toBe("/api/serve/all/p1/DEV")
            expect(url.searchParams.get("mfeSessionId")).toMatch(UUID)
            expect(url.searchParams.get("mfeDeviceId")).toMatch(UUID)
            expect(url.searchParams.get("mfeUserId")).toBe("user-42")
            expect([...url.searchParams.keys()].sort()).toEqual(["mfeDeviceId", "mfeSessionId", "mfeUserId"])
        })

        it("given the ids exposed by identities, when the manifest is fetched, then the query string carries exactly those ids", async () => {
            const fetchMock = stubFetchOnce(manifestFixture)
            const sdk = await loadSdk()
            sdk.configure(baseConfig)

            const ids = sdk.identities()
            await sdk.manifest()

            const url = requestedUrl(fetchMock)
            expect(url.searchParams.get("mfeSessionId")).toBe(ids.sessionId)
            expect(url.searchParams.get("mfeDeviceId")).toBe(ids.deviceId)
        })

        it("given a userId provided as a sync function, when the manifest is fetched, then its return value is sent", async () => {
            const fetchMock = stubFetchOnce(manifestFixture)
            const sdk = await loadSdk()
            sdk.configure({ ...baseConfig, userId: () => "sync-user" })

            await sdk.manifest()

            expect(requestedUrl(fetchMock).searchParams.get("mfeUserId")).toBe("sync-user")
        })

        it("given a userId provided as an async function, when the manifest is fetched, then the resolved value is sent", async () => {
            const fetchMock = stubFetchOnce(manifestFixture)
            const sdk = await loadSdk()
            sdk.configure({ ...baseConfig, userId: async () => "async-user" })

            await sdk.manifest()

            expect(requestedUrl(fetchMock).searchParams.get("mfeUserId")).toBe("async-user")
        })

        it("given a userId getter that returns undefined, when the manifest is fetched, then mfeUserId is omitted and the other two ids are still sent", async () => {
            const fetchMock = stubFetchOnce(manifestFixture)
            const sdk = await loadSdk()
            sdk.configure({ ...baseConfig, userId: () => undefined })

            await sdk.manifest()

            const url = requestedUrl(fetchMock)
            expect(url.searchParams.has("mfeUserId")).toBe(false)
            expect(url.searchParams.get("mfeSessionId")).toMatch(UUID)
            expect(url.searchParams.get("mfeDeviceId")).toMatch(UUID)
        })

        it("given a backendUrl with a trailing slash, when the manifest url is built, then the path has no double slash", async () => {
            const fetchMock = stubFetchOnce(manifestFixture)
            const sdk = await loadSdk()
            sdk.configure({ ...baseConfig, backendUrl: "https://console.test/api/" })

            await sdk.manifest()

            expect(requestedUrl(fetchMock).pathname).toBe("/api/serve/all/p1/DEV")
        })
    })

    describe("optional environment", () => {
        it("given a configuration without environment, when the manifest is fetched, then the auto route is called with the project id after the auto segment", async () => {
            const fetchMock = stubFetchOnce(manifestFixture)
            const sdk = await loadSdk()
            sdk.configure(autoConfig)

            await sdk.manifest()

            expect(requestedUrl(fetchMock).pathname).toBe("/api/serve/all/auto/p1")
        })

        it("given a configuration with an environment, when the manifest is fetched, then the environment route is used exactly as before", async () => {
            const fetchMock = stubFetchOnce(manifestFixture)
            const sdk = await loadSdk()
            sdk.configure(baseConfig)

            await sdk.manifest()

            expect(requestedUrl(fetchMock).pathname).toBe("/api/serve/all/p1/DEV")
        })

        it("given an environment explicitly set to undefined, when the manifest is fetched, then the auto route is called just like when the key is absent", async () => {
            const fetchMock = stubFetchOnce(manifestFixture)
            const sdk = await loadSdk()
            sdk.configure({ ...autoConfig, environment: undefined })

            await sdk.manifest()

            expect(requestedUrl(fetchMock).pathname).toBe("/api/serve/all/auto/p1")
        })

        it("given no environment and a backendUrl with a trailing slash, when the auto url is built, then the path has no double slash", async () => {
            const fetchMock = stubFetchOnce(manifestFixture)
            const sdk = await loadSdk()
            sdk.configure({ ...autoConfig, backendUrl: "https://console.test/api/" })

            await sdk.manifest()

            expect(requestedUrl(fetchMock).pathname).toBe("/api/serve/all/auto/p1")
        })

        it("given no environment, when the manifest is fetched, then the three identities still travel in the query string", async () => {
            const fetchMock = stubFetchOnce(manifestFixture)
            const sdk = await loadSdk()
            sdk.configure({ ...autoConfig, userId: "user-42" })

            await sdk.manifest()

            const url = requestedUrl(fetchMock)
            expect(url.searchParams.get("mfeSessionId")).toMatch(UUID)
            expect(url.searchParams.get("mfeDeviceId")).toMatch(UUID)
            expect(url.searchParams.get("mfeUserId")).toBe("user-42")
        })

        it("given a configuration without environment, when configure is called, then it does not throw and the manifest resolves", async () => {
            stubFetchOnce(manifestFixture)
            const sdk = await loadSdk()

            expect(() => sdk.configure(autoConfig)).not.toThrow()
            await expect(sdk.remoteUrl("catalog")).resolves.toBe(manifestFixture.microfrontends[1].url)
        })

        it("given no environment and an unknown slug, when its url is requested, then the message points at the environment resolved from the domain", async () => {
            stubFetchOnce(manifestFixture)
            const sdk = await loadSdk()
            sdk.configure(autoConfig)

            await expect(sdk.remoteUrl("does-not-exist")).rejects.toThrow(/Available in the environment resolved from this domain: "checkout-new", "catalog"/)
        })

        it("given no environment, when configure is called again adding one, then the first configuration is kept and the auto route is still used", async () => {
            const fetchMock = stubFetchOnce(manifestFixture)
            const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
            const sdk = await loadSdk()

            sdk.configure(autoConfig)
            sdk.configure({ ...autoConfig, environment: "PROD" })
            await sdk.manifest()

            expect(warn).toHaveBeenCalledTimes(1)
            expect(requestedUrl(fetchMock).pathname).toBe("/api/serve/all/auto/p1")
            warn.mockRestore()
        })
    })

    describe("identities and storage", () => {
        it("given ids already in storage, when a new page load reads them, then the very same ids are reused", async () => {
            stubFetchOnce(manifestFixture)
            const first = await loadSdk()
            const firstIds = first.identities()

            expect(session.dump[SESSION_ID_KEY]).toBe(firstIds.sessionId)
            expect(local.dump[DEVICE_ID_KEY]).toBe(firstIds.deviceId)

            const second = await loadSdk()
            const secondIds = second.identities()

            expect(secondIds).toEqual(firstIds)
        })

        it("given a single page load, when identities is called several times, then it always returns the same pair", async () => {
            const sdk = await loadSdk()

            expect(sdk.identities()).toEqual(sdk.identities())
            expect(sdk.identities().sessionId).toMatch(UUID)
            expect(sdk.identities().deviceId).toMatch(UUID)
        })

        it("given a storage that throws on write, when identities is read, then in memory ids are used, nothing is persisted and they are regenerated on the next page load", async () => {
            installStorage(createThrowingStorage(), createThrowingStorage())

            const first = await loadSdk()
            const firstIds = first.identities()

            expect(firstIds.sessionId).toMatch(UUID)
            expect(firstIds.deviceId).toMatch(UUID)
            expect(first.identities()).toEqual(firstIds)

            const second = await loadSdk()
            const secondIds = second.identities()

            expect(secondIds.sessionId).toMatch(UUID)
            expect(secondIds.sessionId).not.toBe(firstIds.sessionId)
            expect(secondIds.deviceId).not.toBe(firstIds.deviceId)
        })

        it("given a storage that throws on the property access itself, when identities is read, then it does not throw and still yields two ids", async () => {
            installExplodingStorageAccess()

            const sdk = await loadSdk()

            expect(() => sdk.identities()).not.toThrow()
            expect(sdk.identities().sessionId).toMatch(UUID)
            expect(sdk.identities().deviceId).toMatch(UUID)
        })

        it("given no storage at all, when the manifest is fetched, then both ids are still present in the query string", async () => {
            installStorage(null, null)
            const fetchMock = stubFetchOnce(manifestFixture)
            const sdk = await loadSdk()
            sdk.configure(baseConfig)

            await sdk.manifest()

            const url = requestedUrl(fetchMock)
            expect(url.searchParams.get("mfeSessionId")).toMatch(UUID)
            expect(url.searchParams.get("mfeDeviceId")).toMatch(UUID)
        })
    })

    describe("errors", () => {
        it("given an unknown slug, when its url is requested, then it rejects listing the available slugs", async () => {
            stubFetchOnce(manifestFixture)
            const sdk = await loadSdk()
            sdk.configure(baseConfig)

            await expect(sdk.remoteUrl("does-not-exist")).rejects.toThrow(/unknown microfrontend slug "does-not-exist".*"checkout-new", "catalog"/s)
        })

        it("given an environment serving no microfrontend, when a url is requested, then the message says so instead of listing nothing", async () => {
            stubFetchOnce({ globalVariables: [], microfrontends: [] })
            const sdk = await loadSdk()
            sdk.configure(baseConfig)

            await expect(sdk.remoteUrl("checkout-new")).rejects.toThrow(/serves no microfrontend/)
        })

        it("given configure was never called, when remoteUrl, manifest or globalVariables are used, then each rejects naming itself and asking for configure()", async () => {
            const fetchMock = stubFetchOnce(manifestFixture)
            const sdk = await loadSdk()

            await expect(sdk.remoteUrl("checkout-new")).rejects.toThrow(/the client is not configured: remoteUrl\("checkout-new"\) was called before configure\(\)/)
            await expect(sdk.manifest()).rejects.toThrow(/the client is not configured: manifest\(\) was called before configure\(\)/)
            await expect(sdk.globalVariables()).rejects.toThrow(/the client is not configured: globalVariables\(\) was called before configure\(\)/)
            expect(fetchMock).not.toHaveBeenCalled()
        })

        it("given configure was never called, when a read fails, then the message shows the call to write", async () => {
            const sdk = await loadSdk()

            await expect(sdk.manifest()).rejects.toThrow(/import \{ configure \} from "@mfe-orchestrator-hub\/client"/)
            await expect(sdk.manifest()).rejects.toThrow(/at the very top of the host entry point/)
        })

        it("given a registered framework integration, when a read fails unconfigured, then the snippet is the one of that framework", async () => {
            const sdk = await loadSdk()
            sdk.registerIntegration("react")

            await expect(sdk.manifest()).rejects.toThrow(/OrchestratorProvider config=\{\{ backendUrl/)
        })

        it("given configure was missing, when it is called afterwards, then the manifest resolves normally", async () => {
            stubFetchOnce(manifestFixture)
            const sdk = await loadSdk()

            await expect(sdk.manifest()).rejects.toThrow(/the client is not configured/)
            sdk.configure(baseConfig)

            await expect(sdk.remoteUrl("catalog")).resolves.toBe(manifestFixture.microfrontends[1].url)
        })

        it("given a backend answering with an error status, when the manifest is fetched, then the status is surfaced as is without any retry", async () => {
            const fetchMock = stubFetchOnce(null, { ok: false, status: 404, statusText: "Not Found" })
            const sdk = await loadSdk()
            sdk.configure(baseConfig)

            await expect(sdk.manifest()).rejects.toThrow(/failed with 404 Not Found/)
            expect(fetchMock).toHaveBeenCalledTimes(1)
        })

        it("given a network failure, when the manifest is fetched, then the original error travels untouched", async () => {
            const fetchMock = stubFlakyFetch(Number.POSITIVE_INFINITY)
            const sdk = await loadSdk()
            sdk.configure(baseConfig)

            await expect(sdk.manifest()).rejects.toThrow(TypeError)
            expect(fetchMock).toHaveBeenCalledTimes(1)
        })
    })

    describe("speaking configuration errors", () => {
        it("given both required options missing, when configure is called, then the message names them, says what they are and shows the call to write", async () => {
            const sdk = await loadSdk()

            const thrown = attempt(() => sdk.configure(asConfig({})))

            expect(thrown).toMatch(/configure\(\) cannot start the client: backendUrl and projectId are not usable/)
            expect(thrown).toMatch(/• backendUrl is missing\./)
            expect(thrown).toMatch(/• projectId is missing\./)
            expect(thrown).toMatch(/It is the base URL of the console API/)
            expect(thrown).toMatch(/It is the id of the project in the console/)
            expect(thrown).toMatch(/VITE_MFE_BACKEND_URL/)
            expect(thrown).toMatch(/VITE_MFE_PROJECT_ID/)
            expect(thrown).toMatch(/ {4}configure\(\{\n {8}backendUrl: "https:\/\/console\.mfe-orchestrator\.dev\/api"/)
        })

        it("given one required option missing, when configure is called, then only that one is reported, in the singular", async () => {
            const sdk = await loadSdk()

            const thrown = attempt(() => sdk.configure(asConfig({ backendUrl: "https://console.test/api" })))

            expect(thrown).toMatch(/cannot start the client: projectId is not usable/)
            expect(thrown).not.toMatch(/• backendUrl/)
        })

        it("given empty strings, when configure is called, then they are reported as empty, not as missing", async () => {
            const sdk = await loadSdk()

            const thrown = attempt(() => sdk.configure({ backendUrl: "", projectId: "   ", environment: "DEV" }))

            expect(thrown).toMatch(/• backendUrl is an empty string\./)
            expect(thrown).toMatch(/• projectId holds nothing but whitespace\./)
        })

        it("given projectID instead of projectId, when configure is called, then the message points at the misspelled key", async () => {
            const sdk = await loadSdk()

            const thrown = attempt(() => sdk.configure(asConfig({ backendUrl: "https://console.test/api", projectID: "p1" })))

            expect(thrown).toMatch(/• projectId is missing\./)
            expect(thrown).toMatch(/carries "projectID", which the client ignores/)
            // The environment variable hint would be wrong here: the value did arrive, under another name.
            expect(thrown).not.toMatch(/VITE_MFE_PROJECT_ID/)
        })

        it("given backend_url instead of backendUrl, when configure is called, then the message points at the misspelled key", async () => {
            const sdk = await loadSdk()

            const thrown = attempt(() => sdk.configure(asConfig({ backend_url: "https://console.test/api", projectId: "p1" })))

            expect(thrown).toMatch(/carries "backend_url", which the client ignores/)
        })

        it("given an environment variable that never reached the bundle, when configure is called, then the string undefined is called out as a placeholder", async () => {
            const sdk = await loadSdk()

            const thrown = attempt(() => sdk.configure({ backendUrl: "https://console.test/api", projectId: "undefined" }))

            expect(thrown).toMatch(/• projectId is still the placeholder "undefined"\./)
            expect(thrown).toMatch(/VITE_MFE_PROJECT_ID/)
        })

        it("given a template that was never filled in, when configure is called, then it is reported as a placeholder", async () => {
            const sdk = await loadSdk()

            expect(attempt(() => sdk.configure({ backendUrl: "https://console.test/api", projectId: "<your-project-id>" }))).toMatch(/is still the placeholder "<your-project-id>"/)
            expect(attempt(() => sdk.configure({ backendUrl: "…", projectId: "p1" }))).toMatch(/is still the placeholder "…"/)
        })

        it("given a non string option, when configure is called, then the message names the type it received", async () => {
            const sdk = await loadSdk()

            const thrown = attempt(() => sdk.configure(asConfig({ backendUrl: 8080, projectId: { id: "p1" } })))

            expect(thrown).toMatch(/• backendUrl is a number \(8080\), not a string\./)
            expect(thrown).toMatch(/• projectId is a object, not a string\./)
        })

        it("given a backendUrl without protocol, when configure is called, then the message suggests the two forms that work", async () => {
            const sdk = await loadSdk()

            const thrown = attempt(() => sdk.configure({ backendUrl: "console.test/api", projectId: "p1" }))

            expect(thrown).toMatch(/• backendUrl is "console\.test\/api", which is not a URL\./)
            expect(thrown).toMatch(/write "https:\/\/console\.test\/api" instead, or "\/console\.test\/api"/)
        })

        it("given a bare host and port, when configure is called, then the message explains that it is read as a scheme", async () => {
            const sdk = await loadSdk()

            const thrown = attempt(() => sdk.configure({ backendUrl: "localhost:3000/api", projectId: "p1" }))

            expect(thrown).toMatch(/whose "localhost" scheme is neither http nor https/)
        })

        it("given a backendUrl that is a path on the same origin, when configure is called, then it is accepted", async () => {
            const fetchMock = stubFetchOnce(manifestFixture)
            const sdk = await loadSdk()

            expect(() => sdk.configure({ backendUrl: "/api/", projectId: "p1", environment: "DEV" })).not.toThrow()
            await sdk.manifest()

            expect(requestedHref(fetchMock)).toMatch(/^\/api\/serve\/all\/p1\/DEV\?/)
        })

        it("given a projectId padded with whitespace, when configure is called, then the percent encoding trap is spelled out", async () => {
            const sdk = await loadSdk()

            expect(attempt(() => sdk.configure({ backendUrl: "https://console.test/api", projectId: " p1 " }))).toMatch(/is " p1 ", padded with whitespace/)
        })

        it("given no argument at all, when configure is called, then the message says an object was expected", async () => {
            const sdk = await loadSdk()

            expect(attempt(() => sdk.configure(asConfig(undefined)))).toMatch(/configure\(\) was called with no argument instead of a configuration object/)
            expect(attempt(() => sdk.configure(asConfig("https://console.test/api")))).toMatch(/called with a string \(https:\/\/console\.test\/api\) instead of a configuration object/)
        })

        it("given a registered framework integration, when the configuration is invalid, then the snippet is the one of that framework", async () => {
            const sdk = await loadSdk()
            sdk.registerIntegration("angular")

            const thrown = attempt(() => sdk.configure(asConfig({})))

            expect(thrown).toMatch(/provideOrchestrator\(\{ backendUrl/)
            expect(thrown).toMatch(/bootstrapApplication\(AppComponent/)
        })

        it("given a non string environment, when configure is called, then it is rejected on its own", async () => {
            const sdk = await loadSdk()

            expect(attempt(() => sdk.configure(asConfig({ backendUrl: "https://console.test/api", projectId: "p1", environment: 2 })))).toMatch(/environment as a number, not a string/)
        })

        it("given an empty environment, when configure is called, then it is accepted with a warning that the auto route will be used", async () => {
            const fetchMock = stubFetchOnce(manifestFixture)
            const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
            const sdk = await loadSdk()

            sdk.configure({ ...baseConfig, environment: "" })
            await sdk.manifest()

            expect(warn).toHaveBeenCalledTimes(1)
            expect(String(warn.mock.calls[0]?.[0])).toMatch(/empty environment, so the client falls back to the auto routes/)
            expect(requestedUrl(fetchMock).pathname).toBe("/api/serve/all/auto/p1")
            warn.mockRestore()
        })

        it("given a valid configuration handed over twice, when configure runs again, then nothing is warned about the environment", async () => {
            stubFetchOnce(manifestFixture)
            const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
            const sdk = await loadSdk()

            sdk.configure(baseConfig)
            sdk.configure(baseConfig)

            expect(warn).not.toHaveBeenCalled()
            warn.mockRestore()
        })

        it("given a 404 on the manifest route, when it is surfaced, then the message says which two things the backend could not find", async () => {
            stubFetchOnce(null, { ok: false, status: 404, statusText: "Not Found" })
            const sdk = await loadSdk()
            sdk.configure(baseConfig)

            await expect(sdk.manifest()).rejects.toThrow(/the project id "p1" is not a project of this console, or the environment "DEV" does not exist in it/)
        })

        it("given a 404 on the auto route, when it is surfaced, then the message points at the domains declared for the environments", async () => {
            stubFetchOnce(null, { ok: false, status: 404, statusText: "Not Found" })
            const sdk = await loadSdk()
            sdk.configure(autoConfig)

            await expect(sdk.manifest()).rejects.toThrow(/no environment of that project declares the domain this page is served on/)
        })

        it("given a 403 on the manifest route, when it is surfaced, then the message names the project id that was refused", async () => {
            stubFetchOnce(null, { ok: false, status: 403, statusText: "Forbidden" })
            const sdk = await loadSdk()
            sdk.configure(baseConfig)

            await expect(sdk.manifest()).rejects.toThrow(/The console refused the request.*project id "p1"/s)
        })
    })

    describe("failed attempts are not memoized", () => {
        it("given a first attempt that failed, when the manifest is requested again, then a brand new request is issued and can succeed", async () => {
            const fetchMock = stubFlakyFetch(1)
            const sdk = await loadSdk()
            sdk.configure(baseConfig)

            await expect(sdk.manifest()).rejects.toThrow("Failed to fetch")
            await expect(sdk.manifest()).resolves.toEqual(manifestFixture)

            expect(fetchMock).toHaveBeenCalledTimes(2)
        })

        it("given three concurrent callers of a failing request, when it rejects, then all three reject on the single shared attempt", async () => {
            const fetchMock = stubFlakyFetch(Number.POSITIVE_INFINITY)
            const sdk = await loadSdk()
            sdk.configure(baseConfig)

            const outcomes = await Promise.allSettled([sdk.manifest(), sdk.manifest(), sdk.remoteUrl("checkout-new")])

            expect(outcomes.map(outcome => outcome.status)).toEqual(["rejected", "rejected", "rejected"])
            for (const outcome of outcomes) {
                expect(outcome.status === "rejected" && String(outcome.reason)).toContain("Failed to fetch")
            }
            expect(fetchMock).toHaveBeenCalledTimes(1)
        })

        it("given concurrent callers that all failed on one attempt, when a later caller arrives, then it re-fetches instead of replaying the stale error", async () => {
            const fetchMock = stubFlakyFetch(1)
            const sdk = await loadSdk()
            sdk.configure(baseConfig)

            await Promise.allSettled([sdk.manifest(), sdk.manifest(), sdk.manifest()])
            expect(fetchMock).toHaveBeenCalledTimes(1)

            await expect(sdk.remoteUrl("checkout-new")).resolves.toBe(manifestFixture.microfrontends[0].url)
            expect(fetchMock).toHaveBeenCalledTimes(2)
        })

        it("given a recovered manifest, when it is requested again, then the successful result stays memoized", async () => {
            const fetchMock = stubFlakyFetch(1)
            const sdk = await loadSdk()
            sdk.configure(baseConfig)

            await expect(sdk.manifest()).rejects.toThrow("Failed to fetch")
            await sdk.manifest()
            await sdk.manifest()
            await sdk.remoteUrl("catalog")
            await sdk.globalVariables()

            expect(fetchMock).toHaveBeenCalledTimes(2)
        })
    })

    describe("configure idempotence", () => {
        it("given configure was already called with the same options, when it is called again, then nothing changes and no warning is emitted", async () => {
            const fetchMock = stubFetchOnce(manifestFixture)
            const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
            const sdk = await loadSdk()

            sdk.configure(baseConfig)
            sdk.configure({ ...baseConfig })
            sdk.configure({ ...baseConfig })
            await sdk.manifest()

            expect(warn).not.toHaveBeenCalled()
            expect(fetchMock).toHaveBeenCalledTimes(1)
            warn.mockRestore()
        })

        it("given configure was already called, when it is called with different options, then the first configuration is kept and a warning is emitted", async () => {
            const fetchMock = stubFetchOnce(manifestFixture)
            const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
            const sdk = await loadSdk()

            sdk.configure(baseConfig)
            sdk.configure({ ...baseConfig, environment: "PROD" })
            await sdk.manifest()

            expect(warn).toHaveBeenCalledTimes(1)
            expect(requestedUrl(fetchMock).pathname).toBe("/api/serve/all/p1/DEV")
            warn.mockRestore()
        })
    })

    describe("globalVariables", () => {
        it("given the manifest global variables, when they are requested, then they come back as a plain object", async () => {
            stubFetchOnce(manifestFixture)
            const sdk = await loadSdk()
            sdk.configure(baseConfig)

            await expect(sdk.globalVariables()).resolves.toEqual({ API_URL: "https://api.example.test", FEATURE_FLAG: "on" })
        })

        it("given a manifest without the two lists, when it is read, then empty defaults are returned instead of undefined", async () => {
            stubFetchOnce({})
            const sdk = await loadSdk()
            sdk.configure(baseConfig)

            await expect(sdk.manifest()).resolves.toEqual({ globalVariables: [], microfrontends: [] })
            await expect(sdk.globalVariables()).resolves.toEqual({})
        })
    })
})
