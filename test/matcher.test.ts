import { TableNode } from "kysely"
import { describe, expect, it } from "vitest"
import { TableMatcher } from "../src/matcher.js"

const table = TableNode.create("users")
const schemaTable = TableNode.createWithSchema("app", "users")

describe("TableMatcher.test", () => {
    it("matches an exact table name", () => {
        expect(new TableMatcher("users").test(table)).toBe(true)
        expect(new TableMatcher("posts").test(table)).toBe(false)
    })
    it("matches a schema-qualified name only with the schema", () => {
        expect(new TableMatcher("app.users").test(schemaTable)).toBe(true)
        expect(new TableMatcher("users").test(schemaTable)).toBe(false)
    })
    it("matches everything with *", () => {
        expect(new TableMatcher("*").test(table)).toBe(true)
        expect(new TableMatcher("*").test(schemaTable)).toBe(true)
    })
    it("matches a regular expression against the full name", () => {
        expect(new TableMatcher(/^app\./).test(schemaTable)).toBe(true)
        expect(new TableMatcher(/^app\./).test(table)).toBe(false)
    })
    it("passes table and schema to a function", () => {
        const matcher = new TableMatcher((name, schema) => name === "users" && schema === "app")
        expect(matcher.test(schemaTable)).toBe(true)
        expect(matcher.test(table)).toBe(false)
    })
    it("matches if any test in a list matches", () => {
        expect(new TableMatcher(["posts", "users"]).test(table)).toBe(true)
        expect(new TableMatcher(["posts", "comments"]).test(table)).toBe(false)
    })
    it("never matches undefined", () => {
        expect(new TableMatcher("*").test(undefined)).toBe(false)
    })
})
