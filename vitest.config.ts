import { defineConfig } from "vitest/config"

export default defineConfig({
    resolve: {
        alias: {
            // value-or-factory only declares a "module" entry, which Node (and Vite's SSR resolver) can't resolve on its own.
            "value-or-factory": new URL("./node_modules/value-or-factory/dist/index.js", import.meta.url).pathname,
        },
    },
    test: {
        include: ["test/**/*.test.ts"],
    },
})
