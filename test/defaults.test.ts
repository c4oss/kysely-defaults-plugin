import { sql } from "kysely"
import { describe, expect, it } from "vitest"
import { DefaultsPlugin, DefaultsPluginOptions } from "../src/defaults.js"
import { compile, createDb } from "./helpers.js"

const now = new Date("2026-01-01T00:00:00Z")

function db(options: DefaultsPluginOptions) {
    return createDb(new DefaultsPlugin(options))
}

describe("DefaultsPlugin inserts", () => {
    const plugin = db({
        tables: [{
            table: "users",
            defaults: { created_by: ["system"] },
            overrides: { tenant: ["acme"] },
        }],
    })

    it("adds a missing default column", () => {
        expect(compile(plugin.insertInto("users").values({ name: "a" }))).toEqual({
            sql: `insert into "users" ("created_by", "name", "tenant") values ($1, $2, $3)`,
            parameters: ["system", "a", "acme"],
        })
    })
    it("keeps a value the query provides over a default", () => {
        expect(compile(plugin.insertInto("users").values({ name: "a", created_by: "alice" })).parameters).toEqual(["alice", "a", "acme"])
    })
    it("replaces a value the query provides with an override", () => {
        expect(compile(plugin.insertInto("users").values({ name: "a", tenant: "evil" })).parameters).toEqual(["system", "a", "acme"])
    })
    it("applies the default to rows that omit a column another row sets", () => {
        const query = plugin.insertInto("users").values([{ name: "a", created_by: "alice" }, { name: "b" }])
        expect(compile(query).parameters).toEqual(["alice", "a", "acme", "system", "b", "acme"])
    })
    it("keeps DEFAULT for an omitted column the plugin has no default for", () => {
        const query = plugin.insertInto("users").values([{ name: "a", email: "a@example.com" }, { name: "b" }])
        expect(compile(query).sql).toBe(`insert into "users" ("created_by", "name", "email", "tenant") values ($1, $2, $3, $4), ($5, $6, default, $7)`)
    })
    it("leaves other tables alone", () => {
        expect(compile(plugin.insertInto("posts").values({ title: "a" }))).toEqual({
            sql: `insert into "posts" ("title") values ($1)`,
            parameters: ["a"],
        })
    })
})

describe("DefaultsPlugin updates", () => {
    const plugin = db({
        tables: [{
            table: "users",
            defaults: { updated_at: { always: () => now } },
            overrides: { tenant: { update: "acme" } },
        }],
    })

    it("adds a default to an update built with an object", () => {
        expect(compile(plugin.updateTable("users").set({ name: "a" }))).toEqual({
            sql: `update "users" set "updated_at" = $1, "name" = $2, "tenant" = $3`,
            parameters: [now, "a", "acme"],
        })
    })
    it("adds a default to an update built with .set(column, value)", () => {
        expect(compile(plugin.updateTable("users").set("name", "a"))).toEqual({
            sql: `update "users" set "updated_at" = $1, "name" = $2, "tenant" = $3`,
            parameters: [now, "a", "acme"],
        })
    })
    it("keeps table-qualified columns and does not duplicate a column the query sets", () => {
        const query = plugin.updateTable("users").set("users.name", "a").set("users.updated_at", sql`now()`)
        expect(compile(query).sql).toBe(`update "users" set "users"."name" = $1, "users"."updated_at" = now(), "tenant" = $2`)
    })
    it("replaces a value the query sets with an override", () => {
        const query = plugin.updateTable("users").set({ name: "a", tenant: "evil" })
        expect(compile(query).parameters).toEqual([now, "a", "acme"])
    })
    it("matches an aliased table", () => {
        expect(compile(plugin.updateTable("users as u").set({ name: "a" })).parameters).toEqual([now, "a", "acme"])
    })
})

describe("DefaultsPlugin upserts", () => {
    const plugin = db({
        tables: [{
            table: "users",
            defaults: {
                created_by: ["system"],
                updated_at: { always: () => now },
            },
        }],
    })

    it("applies update defaults to on conflict do update", () => {
        const query = plugin.insertInto("users").values({ name: "a" }).onConflict(oc => oc.column("id").doUpdateSet({ name: "b" }))
        expect(compile(query)).toEqual({
            sql: `insert into "users" ("created_by", "updated_at", "name") values ($1, $2, $3) on conflict ("id") do update set "updated_at" = $4, "name" = $5`,
            parameters: ["system", now, "a", now, "b"],
        })
    })
    it("keeps on conflict do nothing", () => {
        const query = plugin.insertInto("users").values({ name: "a" }).onConflict(oc => oc.column("id").doNothing())
        expect(compile(query).sql).toBe(`insert into "users" ("created_by", "updated_at", "name") values ($1, $2, $3) on conflict ("id") do nothing`)
    })
})

describe("DefaultsPlugin values", () => {
    it("passes the query node to a factory", () => {
        const plugin = db({
            tables: [{ table: "users", defaults: { kind: [node => node.kind] } }],
        })
        expect(compile(plugin.insertInto("users").values({ name: "a" })).parameters).toEqual(["InsertQueryNode", "a"])
    })
    it("inserts an operation node as SQL", () => {
        const plugin = db({
            tables: [{ table: "users", defaults: { created_at: [sql`now()`.toOperationNode()] } }],
        })
        expect(compile(plugin.insertInto("users").values({ name: "a" })).sql).toBe(`insert into "users" ("created_at", "name") values (now(), $1)`)
    })
    it("applies every matching table entry in order", () => {
        const plugin = db({
            tables: [
                { table: "*", defaults: { created_by: ["system"] } },
                { table: "users", overrides: { created_by: ["admin"] } },
            ],
        })
        expect(compile(plugin.insertInto("users").values({ name: "a" })).parameters).toEqual(["admin", "a"])
    })
})

describe("DefaultsPlugin unsupported queries", () => {
    const options = { tables: [{ table: "users", defaults: { created_by: ["system"] } }] } satisfies DefaultsPluginOptions

    it("throws on insert ... select by default", () => {
        const query = db(options).insertInto("users").columns(["name"]).expression(eb => eb.selectFrom("people").select("name"))
        expect(() => query.compile()).toThrow("DefaultsPlugin")
    })
    it("leaves insert ... select alone when throwOnUnsupported is false", () => {
        const query = db({ ...options, throwOnUnsupported: false }).insertInto("users").columns(["name"]).expression(eb => eb.selectFrom("people").select("name"))
        expect(compile(query).sql).toBe(`insert into "users" ("name") select "name" from "people"`)
    })
    it("leaves selects and deletes alone", () => {
        const plugin = db(options)
        expect(compile(plugin.selectFrom("users").selectAll()).sql).toBe(`select * from "users"`)
        expect(compile(plugin.deleteFrom("users")).sql).toBe(`delete from "users"`)
    })

    it.todo("evaluates factories once per row rather than once per query")
    it.todo("applies update defaults to MySQL on duplicate key update")
    it.todo("applies insert defaults to insertInto(...).defaultValues()")
})
