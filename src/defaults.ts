import { ColumnNode, ColumnUpdateNode, InsertQueryNode, KyselyPlugin, OperationNode, OperationNodeTransformer, PluginTransformQueryArgs, PluginTransformResultArgs, UpdateQueryNode, ValueListNode, ValueNode, ValuesNode } from "kysely"
import { ValueOrFactory, callOrGet } from "value-or-factory"
import { TableMatcher, TableTests } from "./matcher"

export type DefaultColumns = Record<string, DefaultColumn>
export type DefaultTable = { table: TableTests, defaults?: DefaultColumns, overrides?: DefaultColumns }
export type DefaultColumn = [InsertDefault] | [InsertDefault, UpdateDefault] | { insert?: InsertDefault, update?: UpdateDefault, always?: UpdateDefault }
export type DefaultValue<Q> = ValueOrFactory<OperationNode | number | string | boolean | bigint | null, [Q]>
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

export class DefaultsTransformer extends OperationNodeTransformer {

    readonly matcher

    constructor(private readonly options: DefaultsTransformerOptions) {
        super()
        this.matcher = new TableMatcher(options.table.table)
    }

    private valueToNode<Q>(factory: DefaultValue<Q>, node: Q) {
        const value = callOrGet(factory, node)
        if (typeof value === "object" && value !== null) {
            return value
        }
        return ValueNode.create(value)
    }
    private insertValues(node: InsertQueryNode, columns?: DefaultColumns) {
        return Object.fromEntries(Object.entries(columns ?? {}).flatMap(([key, config]) => {
            if (Array.isArray(config)) {
                if (config[0] === undefined) {
                    return []
                }
                return [[key, this.valueToNode(config[0], node)] as const]
            }
            const data = config.insert ?? config.always
            if (data === undefined) {
                return []
            }
            return [[key, this.valueToNode(data, node)] as const]
        }))
    }
    private updateValues(node: InsertQueryNode | UpdateQueryNode, columns?: DefaultColumns) {
        return Object.fromEntries(Object.entries(columns ?? {}).flatMap(([key, config]) => {
            if (Array.isArray(config)) {
                if (config[1] === undefined) {
                    return []
                }
                return [[key, this.valueToNode(config[1], node)] as const]
            }
            const data = config.update ?? config.always
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
                throw new Error("This type of update query is not supported by the DiscriminatorPlugin.")
            }
            return node
        }
        if (!this.matcher.test(table.underlying)) {
            return node
        }
        const defaults = this.updateValues(node, this.options.table.defaults)
        const overrides = this.updateValues(node, this.options.table.overrides)
        const updates = {
            ...defaults,
            //@ts-ignore TODO
            ...Object.fromEntries((node.updates ?? []).map(_ => [_.column.column.name, _.value])),
            ...overrides,
        }
        return {
            ...node,
            updates: Object.entries(updates).map(update => {
                //@ts-ignore TODO
                return ColumnUpdateNode.create(ColumnNode.create(update[0]), update[1])
            })
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
        const originalColumnNames = node.columns?.map(_ => _.column.name) ?? []
        const columnNames = [...Object.keys(insertDefaults), ...originalColumnNames, ...Object.keys(insertOverrides)].filter((value, index, array) => array.indexOf(value) === index)
        //@ts-ignore TODO
        return {
            ...node,
            onConflict: (() => {
                if (node.onConflict === undefined) {
                    return
                }
                const updates = {
                    ...updateDefaults,
                    //@ts-ignore TODO
                    ...Object.fromEntries((node.onConflict.updates ?? []).map(_ => [_.column.column.name, _.value])),
                    ...updateOverrides,
                }
                return {
                    ...node.onConflict,
                    updates: Object.entries(updates).map(update => {
                        //@ts-ignore TODO
                        return ColumnUpdateNode.create(ColumnNode.create(update[0]), update[1])
                    })
                }
            })(),
            columns: columnNames.map(name => ColumnNode.create(name)),
            values: ValuesNode.create(node.values.values.map(list => {
                return ValueListNode.create((() => {
                    const original = list.kind === "ValueListNode" ? list.values : list.values.map(value => ({ kind: "ValueNode" as const, value }))
                    const values = {
                        ...insertDefaults,
                        ...Object.fromEntries((originalColumnNames).map((name, index) => [name, original[index]])),
                        ...insertOverrides,
                    }
                    return columnNames.map(name => values[name]!)
                })())
            }))
        }
    }

}
