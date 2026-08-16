/**
 * Everything the client says when its configuration is wrong or absent.
 *
 * The two required options almost always arrive from build time environment variables, so the
 * failure the host sees is not "a value is invalid" but "nothing reached the bundle". Messages here
 * are written for that moment: they name the option, show what actually arrived, say where the real
 * value comes from, and print the exact call to write, in the flavour of the package the host uses.
 */

export const PREFIX = "[@mfe-orchestrator-hub/client]"

/** Which package the host went through. Only decides which snippet an error prints. */
export type Integration = "core" | "react" | "vue" | "angular"

/** The two options without which nothing can be requested. */
export type RequiredOption = "backendUrl" | "projectId"

const EXAMPLE_BACKEND_URL = "https://console.mfe-orchestrator.dev/api"
const EXAMPLE_PROJECT_ID = "6f1b2c3d4e5f6a7b8c9d0e1f"

const SNIPPETS: Record<Integration, string> = {
    core: `import { configure } from "@mfe-orchestrator-hub/client"

configure({
    backendUrl: "${EXAMPLE_BACKEND_URL}",
    projectId: "${EXAMPLE_PROJECT_ID}"
})`,
    react: `import { OrchestratorProvider } from "@mfe-orchestrator-hub/client-react"

<OrchestratorProvider config={{ backendUrl: "${EXAMPLE_BACKEND_URL}", projectId: "${EXAMPLE_PROJECT_ID}" }}>
    <App />
</OrchestratorProvider>`,
    vue: `import { createOrchestrator } from "@mfe-orchestrator-hub/client-vue"

app.use(createOrchestrator({ backendUrl: "${EXAMPLE_BACKEND_URL}", projectId: "${EXAMPLE_PROJECT_ID}" }))`,
    angular: `import { provideOrchestrator } from "@mfe-orchestrator-hub/client-angular"

bootstrapApplication(AppComponent, {
    providers: [provideOrchestrator({ backendUrl: "${EXAMPLE_BACKEND_URL}", projectId: "${EXAMPLE_PROJECT_ID}" })]
})`
}

const WHERE: Record<Integration, string> = {
    core: "Call it once, at the very top of the host entry point, before anything imports a remote.",
    react: "Render it above every component that resolves a remote. Better still, call configure() at the very top of the entry point: a bundler may import a remote before React mounts.",
    vue: "Install the plugin before mounting the app. Better still, call configure() at the very top of the entry point: a bundler may import a remote before the app is created.",
    angular: "Pass it to bootstrapApplication(). Better still, call configure() at the very top of main.ts: a lazily loaded remote must find the client already configured."
}

const WHAT_IT_IS: Record<RequiredOption, string> = {
    backendUrl: `It is the base URL of the console API, protocol included, ex. "${EXAMPLE_BACKEND_URL}". A path on the same origin as the host, ex. "/api", works too.`,
    projectId: `It is the id of the project in the console: open the project and copy it from its page, ex. "${EXAMPLE_PROJECT_ID}".`
}

/** The name the value travels under from the bundler config into the bundle, per toolchain. */
const BUILD_VARIABLE: Record<RequiredOption, { vite: string; webpack: string }> = {
    backendUrl: { vite: "VITE_MFE_BACKEND_URL", webpack: "MFE_BACKEND_URL" },
    projectId: { vite: "VITE_MFE_PROJECT_ID", webpack: "MFE_PROJECT_ID" }
}

/**
 * What an option that was never substituted into the bundle looks like.
 *
 * The bundler config is named before the .env file on purpose: it is where the console writes both
 * values when it generates the config, so it is where they are missing from when they are missing.
 */
const missingEnvHint = (option: RequiredOption): string =>
    `Nothing arrived here at all, which is what a value that never reached the bundle looks like: check ${BUILD_VARIABLE[option].vite} (Vite) or ${BUILD_VARIABLE[option].webpack} (webpack) in the build that produced this bundle. The generated configs carry it in the "define" block of vite.config, or in the DefinePlugin of webpack.config, so look there first; declared only in a .env file the build never reads, it looks exactly like this.`

/** Values that mean "the template was never filled in". */
const PLACEHOLDER = /^(…|\.{3}|undefined|null|nan|<[^>]*>|\{\{[^}]*\}\}|\$\{[^}]*\}|your[-_ ]?[a-z]*|x{3,}|change[-_ ]?me|todo|tbd)$/i

/** Long values are cut: an error message is not the place to print a whole JWT. */
const quoted = (value: string): string => JSON.stringify(value.length > 120 ? `${value.slice(0, 120)}…` : value)

const described = (value: unknown): string => {
    if (value === null) {
        return "null"
    }
    if (Array.isArray(value)) {
        return "an array"
    }
    const type = typeof value
    return type === "object" || type === "function" ? `a ${type}` : `a ${type} (${String(value)})`
}

/** Same key modulo case and separators: projectID, project_id, PROJECT-ID all collapse onto projectid. */
const normalized = (key: string): string => key.toLowerCase().replace(/[^a-z0-9]/g, "")

const ALIASES: Record<RequiredOption, string[]> = {
    backendUrl: ["backendurl", "backendbaseurl", "apiurl", "baseurl", "consoleurl", "url", "backend"],
    projectId: ["projectid", "project", "idproject", "projectuuid", "projectkey"]
}

/**
 * The key the host actually wrote, when it looks like a misspelling of the one that is missing.
 * `projectID` is by far the most common: it is silently ignored, so without this the message would
 * claim the option is absent while the developer stares at a line that clearly sets it.
 */
const confusableKey = (option: RequiredOption, config: unknown): string | undefined => {
    if (typeof config !== "object" || config === null) {
        return undefined
    }
    const candidates = ALIASES[option]
    return Object.keys(config).find(key => key !== option && candidates.includes(normalized(key)))
}

/** One thing that is wrong with one option, already spelled out. */
export interface ConfigProblem {
    option: RequiredOption
    /** Predicate completing "<option> …", ex. `is missing`. */
    what: string
    /** Extra lines, printed under the option, that say how to fix this particular case. */
    hints: string[]
}

const problem = (option: RequiredOption, what: string, ...hints: (string | undefined)[]): ConfigProblem => ({
    option,
    what,
    hints: [WHAT_IT_IS[option], ...hints].filter((hint): hint is string => Boolean(hint))
})

/**
 * A backendUrl the client can actually build a request on: an absolute http(s) URL, or a path on the
 * host's own origin, which `fetch` resolves against the page.
 */
const diagnoseBackendUrl = (value: string): ConfigProblem | null => {
    const trimmed = value.trim()
    if (trimmed.startsWith("/")) {
        return null
    }
    let parsed: URL
    try {
        parsed = new URL(trimmed)
    } catch {
        return problem(
            "backendUrl",
            `is ${quoted(value)}, which is not a URL`,
            trimmed.includes(".") || trimmed.includes(":")
                ? `It looks like a host without a protocol: write "https://${trimmed}" instead, or "/${trimmed.replace(/^\/+/, "")}" if the console API answers on the same origin as this page.`
                : undefined
        )
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        return problem(
            "backendUrl",
            `is ${quoted(value)}, whose "${parsed.protocol.replace(":", "")}" scheme is neither http nor https`,
            'A bare "host:port" is read as a scheme: write "http://localhost:3000/api", not "localhost:3000/api".'
        )
    }
    return null
}

/** Everything wrong with one required option, or null when it is usable. */
const diagnose = (option: RequiredOption, config: unknown): ConfigProblem | null => {
    const value = (config as Record<string, unknown> | null | undefined)?.[option]
    const typo = confusableKey(option, config)
    const typoHint = typo ? `The configuration carries "${typo}", which the client ignores. The option is spelled "${option}".` : undefined

    if (value === undefined || value === null) {
        return problem(option, value === null ? "is null" : "is missing", typoHint, typo ? undefined : missingEnvHint(option))
    }
    if (typeof value !== "string") {
        return problem(option, `is ${described(value)}, not a string`, typoHint)
    }
    if (value.trim() === "") {
        return problem(option, value === "" ? "is an empty string" : "holds nothing but whitespace", typoHint, missingEnvHint(option))
    }
    if (PLACEHOLDER.test(value.trim())) {
        const looksLikeAnUnsetVariable = /^(undefined|null|nan)$/i.test(value.trim())
        return problem(option, `is still the placeholder ${quoted(value)}`, typoHint, looksLikeAnUnsetVariable ? missingEnvHint(option) : undefined)
    }
    if (option === "projectId" && value.trim() !== value) {
        // Percent encoded into the path, so the padding would travel to the backend as %20.
        return problem(
            "projectId",
            `is ${quoted(value)}, padded with whitespace`,
            "Trim the value: it is percent encoded into the manifest URL, so the spaces would reach the backend as part of the id."
        )
    }
    return option === "backendUrl" ? diagnoseBackendUrl(value) : null
}

/** Every problem of a configuration, in the order the options are declared. Empty means usable. */
export const diagnoseConfig = (config: unknown): ConfigProblem[] =>
    (["backendUrl", "projectId"] as const).map(option => diagnose(option, config)).filter((found): found is ConfigProblem => found !== null)

const bulleted = (problems: ConfigProblem[]): string => problems.map(({ option, what, hints }) => [`  • ${option} ${what}.`, ...hints.map(hint => `      → ${hint}`)].join("\n")).join("\n")

const indented = (block: string): string =>
    block
        .split("\n")
        .map(line => (line ? `    ${line}` : line))
        .join("\n")

const howToConfigure = (integration: Integration): string => `Configure the client like this:\n\n${indented(SNIPPETS[integration])}\n\n${WHERE[integration]}`

const listed = (options: RequiredOption[]): string => (options.length > 1 ? `${options.slice(0, -1).join(", ")} and ${options.at(-1)}` : String(options[0]))

/** The message thrown by `configure()` when what it received cannot be used. */
export const invalidConfigMessage = (problems: ConfigProblem[], integration: Integration): string => {
    const options = problems.map(({ option }) => option)
    const headline = `${PREFIX} configure() cannot start the client: ${listed(options)} ${options.length > 1 ? "are" : "is"} not usable.`
    return `${headline}\n\n${bulleted(problems)}\n\n${howToConfigure(integration)}`
}

/** The message thrown by `configure()` when it did not even receive an object. */
export const noConfigMessage = (config: unknown, integration: Integration): string =>
    `${PREFIX} configure() was called with ${config === undefined ? "no argument" : described(config)} instead of a configuration object. It needs at least backendUrl and projectId.\n\n${howToConfigure(integration)}`

/** The message every read rejects with while the client has no configuration at all. */
export const notConfiguredMessage = (caller: string, integration: Integration): string =>
    `${PREFIX} the client is not configured: ${caller} was called before configure() ever ran, so neither backendUrl nor projectId is known and no manifest can be requested.\n\n${howToConfigure(integration)}`
