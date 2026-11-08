import { DummyDriver, Kysely, KyselyPlugin, PostgresAdapter, PostgresIntrospector, PostgresQueryCompiler } from "kysely"

/**
 * A Kysely instance that compiles queries for Postgres but never executes them.
 */
export function createDb(...plugins: KyselyPlugin[]) {
    return new Kysely<any>({
        dialect: {
            createAdapter: () => new PostgresAdapter(),
            createDriver: () => new DummyDriver(),
            createIntrospector: db => new PostgresIntrospector(db),
            createQueryCompiler: () => new PostgresQueryCompiler(),
        },
        plugins,
    })
}

export function compile(query: { compile(): { sql: string, parameters: readonly unknown[] } }) {
    const { sql, parameters } = query.compile()
    return { sql, parameters: [...parameters] }
}
