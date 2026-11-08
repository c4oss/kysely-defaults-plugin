import { sql } from "kysely"
import { describe, expect, it } from "vitest"
import { DiscriminatorPlugin } from "../src/discriminator.js"
import { compile, createDb } from "./helpers.js"

const db = createDb(new DiscriminatorPlugin({
    tables: [{ table: "users", columns: { tenant: "acme" } }],
}))

describe("DiscriminatorPlugin", () => {
    it("filters a select", () => {
        expect(compile(db.selectFrom("users").selectAll())).toEqual({
            sql: `select * from "users" where "users"."tenant" = $1`,
            parameters: ["acme"],
        })
    })
    it("combines with an existing where", () => {
        expect(compile(db.selectFrom("users").selectAll().where("name", "=", "a"))).toEqual({
            sql: `select * from "users" where "name" = $1 and "users"."tenant" = $2`,
            parameters: ["a", "acme"],
        })
    })
    it("uses the alias of an aliased table", () => {
        expect(compile(db.selectFrom("users as u").selectAll()).sql).toBe(`select * from "users" as "u" where "u"."tenant" = $1`)
    })
    it("keeps an existing or condition grouped", () => {
        const query = db.selectFrom("users").selectAll().where(eb => eb.or([eb("name", "=", "a"), eb("name", "=", "b")]))
        expect(compile(query).sql).toBe(`select * from "users" where ("name" = $1 or "name" = $2) and "users"."tenant" = $3`)
    })
    it("keeps a raw or condition grouped", () => {
        const query = db.selectFrom("users").selectAll().where(sql<boolean>`name = 'a' or true`)
        expect(compile(query).sql).toBe(`select * from "users" where (name = 'a' or true) and "users"."tenant" = $1`)
    })
    it("filters a joined table in the join condition", () => {
        const query = db.selectFrom("posts").innerJoin("users", "users.id", "posts.user_id").selectAll()
        expect(compile(query)).toEqual({
            sql: `select * from "posts" inner join "users" on "users"."id" = "posts"."user_id" and "users"."tenant" = $1`,
            parameters: ["acme"],
        })
    })
    it("keeps a raw or condition in a join grouped", () => {
        const query = db.selectFrom("posts").innerJoin("users", join => join.on(sql<boolean>`users.id = posts.user_id or true`)).selectAll()
        expect(compile(query).sql).toBe(`select * from "posts" inner join "users" on (users.id = posts.user_id or true) and "users"."tenant" = $1`)
    })
    it("keeps a raw or condition in an update grouped", () => {
        const query = db.updateTable("users").set({ name: "a" }).where(sql<boolean>`id = 1 or true`)
        expect(compile(query).sql).toBe(`update "users" set "name" = $1 where (id = 1 or true) and "users"."tenant" = $2`)
    })
    it("filters updates", () => {
        expect(compile(db.updateTable("users").set({ name: "a" })).sql).toBe(`update "users" set "name" = $1 where "users"."tenant" = $2`)
    })
    it("filters deletes", () => {
        expect(compile(db.deleteFrom("users")).sql).toBe(`delete from "users" where "users"."tenant" = $1`)
    })
    it("combines with an existing where on a delete", () => {
        expect(compile(db.deleteFrom("users").where(sql<boolean>`id = 1 or true`))).toEqual({
            sql: `delete from "users" where (id = 1 or true) and "users"."tenant" = $1`,
            parameters: ["acme"],
        })
    })
    it("uses the alias on an aliased delete", () => {
        expect(compile(db.deleteFrom("users as u")).sql).toBe(`delete from "users" as "u" where "u"."tenant" = $1`)
    })
    it("leaves deletes from other tables alone", () => {
        expect(compile(db.deleteFrom("posts")).sql).toBe(`delete from "posts"`)
    })
    it("adds discriminator columns to on conflict targets", () => {
        const query = db.insertInto("users").values({ name: "a" }).onConflict(oc => oc.column("email").doNothing())
        expect(compile(query).sql).toBe(`insert into "users" ("name") values ($1) on conflict ("email", "tenant") do nothing`)
    })
    it("leaves other tables alone", () => {
        expect(compile(db.selectFrom("posts").selectAll()).sql).toBe(`select * from "posts"`)
    })
    it("passes the query node to a factory", () => {
        const kinds: string[] = []
        const factoryDb = createDb(new DiscriminatorPlugin({
            tables: [{ table: "users", columns: node => (kinds.push(node.kind), { tenant: "acme" }) }],
        }))
        compile(factoryDb.selectFrom("users").selectAll())
        expect(kinds).toEqual(["SelectQueryNode"])
    })
})
