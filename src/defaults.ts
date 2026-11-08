import { ColumnNode, ColumnUpdateNode, DefaultInsertValueNode, InsertQueryNode, KyselyPlugin, OnConflictNode, OperationNode, OperationNodeTransformer, PluginTransformQueryArgs, PluginTransformResultArgs, ReferenceNode, UpdateQueryNode, ValueListNode, ValueNode, ValuesNode } from "kysely"
import { ValueOrFactory, callOrGet } from "value-or-factory"
import { TableMatcher, TableTests } from "./matcher.js"

export type DefaultColumns = Record<string, DefaultColumn>
export type DefaultTable = { table: TableTests, defaults?: DefaultColumns, overrides?: DefaultColumns }
export type DefaultColumn = [InsertDefault] | [InsertDefault, UpdateDefault] | { insert?: InsertDefault, update?: UpdateDefault, always?: UpdateDefault }
export type DefaultValue<Q> = ValueOrFactory<OperationNode | Date | number | string | boolean | bigint | null, [Q]>
export type InsertDefault = DefaultValue<InsertQueryNode>
export type UpdateDefault = DefaultValue<InsertQueryNode | UpdateQueryNode>

export interface DefaultsPluginOptions {

    readonly tables: readonly DefaultTable[]
    readonly throwOnUnsupported?: boolean | undefined

}

export class DefaultsPlugin implements KyselyPlugin {

    private readonly transformers

    constructor(options: DefaultsPluginOptions) {
        this.transformers = options.tables.map(table => {
            return new DefaultsTransformer({
                table,
                throwOnUnsupported: options.throwOnUnsupported,
            })
        })
    }

    transformQuery(args: PluginTransformQueryArgs) {
        if (args.node.kind !== "InsertQueryNode" && args.node.kind !== "UpdateQueryNode") {
            return args.node
        }
        return this.transformers.reduce((node, transformer) => transformer.transformNode(node), args.node)
    }
    async transformResult(args: PluginTransformResultArgs) {
        return args.result
    }

}

export interface DefaultsTransformerOptions {

    readonly table: DefaultTable
    readonly throwOnUnsupported?: boolean | undefined

}

type ColumnValues = ReadonlyMap<string, OperationNode>

function isOperationNode(value: object): value is OperationNode {
    return !(value instanceof Date) && typeof (value as { kind?: unknown }).kind === "string"
}

/**
 * The column name targeted by a column update, whether it was built from `.set({ column: value })` (a ColumnNode) or `.set("column", value)` (a ReferenceNode).
 */
function columnName(node: OperationNode) {
    if (ColumnNode.is(node)) {
        return node.column.name
    }
    if (ReferenceNode.is(node) && ColumnNode.is(node.column)) {
        return node.column.column.name
    }
    return
}

/**
 * Merges defaults and overrides into a list of column updates.
 * Existing updates are kept as they are (preserving table-qualified references), unless an override replaces them.
 */
function mergeUpdates(updates: readonly ColumnUpdateNode[], defaults: ColumnValues, overrides: ColumnValues) {
    const existing = new Set(updates.map(update => columnName(update.column)))
    return [
        ...[...defaults].filter(([name]) => !existing.has(name) && !overrides.has(name)).map(([name, value]) => ColumnUpdateNode.create(ColumnNode.create(name), value)),
        ...updates.filter(update => {
            const name = columnName(update.column)
            return name === undefined || !overrides.has(name)
        }),
        ...[...overrides].map(([name, value]) => ColumnUpdateNode.create(ColumnNode.create(name), value)),
    ]
}

export class DefaultsTransformer extends OperationNodeTransformer {

    readonly matcher

    constructor(private readonly options: DefaultsTransformerOptions) {
        super()
        this.matcher = new TableMatcher(options.table.table)
    }

    private valueToNode<Q>(factory: DefaultValue<Q>, node: Q): OperationNode {
        const value = callOrGet(factory, node)
        if (typeof value === "object" && value !== null && isOperationNode(value)) {
            return value
        }
        return ValueNode.create(value)
    }
    private insertValues(node: InsertQueryNode, columns?: DefaultColumns): ColumnValues {
        return new Map(Object.entries(columns ?? {}).flatMap(([key, config]) => {
            const data = Array.isArray(config) ? config[0] : config.insert ?? config.always
            if (data === undefined) {
                return []
            }
            return [[key, this.valueToNode(data, node)] as const]
        }))
    }
    private updateValues(node: InsertQueryNode | UpdateQueryNode, columns?: DefaultColumns): ColumnValues {
        return new Map(Object.entries(columns ?? {}).flatMap(([key, config]) => {
            const data = Array.isArray(config) ? config[1] : config.update ?? config.always
            if (data === undefined) {
                return []
            }
            return [[key, this.valueToNode(data, node)] as const]
        }))
    }

    protected override transformUpdateQuery(originalNode: UpdateQueryNode): UpdateQueryNode {
        const node = super.transformUpdateQuery(originalNode)
        const table = this.matcher.table(node.table)
        if (table === undefined) {
            if (this.options.throwOnUnsupported ?? true) {
                throw new Error("This type of update query is not supported by the DefaultsPlugin.")
            }
            return node
        }
        if (!this.matcher.test(table.underlying)) {
            return node
        }
        const defaults = this.updateValues(node, this.options.table.defaults)
        const overrides = this.updateValues(node, this.options.table.overrides)
        return {
            ...node,
            updates: mergeUpdates(node.updates ?? [], defaults, overrides),
        }
    }

    protected override transformInsertQuery(originalNode: InsertQueryNode): InsertQueryNode {
        const node = super.transformInsertQuery(originalNode)
        if (!this.matcher.test(node.into)) {
            return node
        }
        if (node.values === undefined) {
            return node
        }
        if (!ValuesNode.is(node.values)) {
            if (this.options.throwOnUnsupported ?? true) {
                throw new Error("This type of ValuesNode is not supported by the DefaultsPlugin.")
            }
            return node
        }
        const insertDefaults = this.insertValues(node, this.options.table.defaults)
        const insertOverrides = this.insertValues(node, this.options.table.overrides)
        const updateDefaults = this.updateValues(node, this.options.table.defaults)
        const updateOverrides = this.updateValues(node, this.options.table.overrides)
        const originalColumnNames = node.columns?.map(column => column.column.name) ?? []
        const columnNames = [...new Set([...insertDefaults.keys(), ...originalColumnNames, ...insertOverrides.keys()])]
        const onConflict = node.onConflict === undefined ? undefined : OnConflictNode.cloneWith(node.onConflict, {
            updates: mergeUpdates(node.onConflict.updates ?? [], updateDefaults, updateOverrides),
        })
        const values = ValuesNode.create(node.values.values.map(list => {
            const original = list.kind === "ValueListNode" ? list.values : list.values.map(value => ValueNode.create(value))
            const row = new Map(insertDefaults)
            originalColumnNames.forEach((name, index) => {
                const value = original[index]
                if (value === undefined) {
                    return
                }
                // A row that omits a column set by another row in the same insert gets DEFAULT; our default takes precedence over that.
                if (DefaultInsertValueNode.is(value) && row.has(name)) {
                    return
                }
                row.set(name, value)
            })
            insertOverrides.forEach((value, name) => row.set(name, value))
            return ValueListNode.create(columnNames.map(name => row.get(name) ?? DefaultInsertValueNode.create()))
        }))
        return InsertQueryNode.cloneWith(node, {
            columns: columnNames.map(name => ColumnNode.create(name)),
            values,
            ...onConflict === undefined ? {} : { onConflict },
        })
    }

}
