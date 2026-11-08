import { describe, expect, it } from "vitest"
import { RestrictionPlugin } from "../src/restriction.js"
import { compile, createDb } from "./helpers.js"

describe("RestrictionPlugin", () => {
    it("allows only the listed query kinds", () => {
        const db = createDb(new RestrictionPlugin({ allowed: ["SelectQueryNode"] }))
        expect(compile(db.selectFrom("users").selectAll()).sql).toBe(`select * from "users"`)
        expect(() => db.deleteFrom("users").compile()).toThrow("Operation not allowed: DeleteQueryNode.")
    })
    it("rejects the disallowed query kinds", () => {
        const db = createDb(new RestrictionPlugin({ disallowed: ["DeleteQueryNode"] }))
        expect(compile(db.selectFrom("users").selectAll()).sql).toBe(`select * from "users"`)
        expect(() => db.deleteFrom("users").compile()).toThrow("Operation not allowed: DeleteQueryNode.")
    })
    it("allows everything with no options", () => {
        const db = createDb(new RestrictionPlugin({}))
        expect(compile(db.deleteFrom("users")).sql).toBe(`delete from "users"`)
    })
})
