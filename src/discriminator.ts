import { AndNode, BinaryOperationNode, ColumnNode, DeleteQueryNode, InsertQueryNode, JoinNode, KyselyPlugin, OnNode, OperationNode, OperationNodeTransformer, OperatorNode, ParensNode, PluginTransformQueryArgs, PluginTransformResultArgs, QueryId, ReferenceNode, SelectQueryNode, UpdateQueryNode, ValueNode, WhereNode } from "kysely"
import { ValueOrFactory, callOrGet } from "value-or-factory"
import { TableMatcher, TableTests } from "./matcher.js"

export type DiscriminatedNode = InsertQueryNode | SelectQueryNode | UpdateQueryNode | DeleteQueryNode | JoinNode
export type Discriminator = { readonly table: TableTests, readonly columns: ValueOrFactory<Record<string, unknown>, [DiscriminatedNode]> }

export interface DiscriminatorTransformerConfig {

    readonly discriminator: Discriminator
    readonly throwOnUnsupported?: boolean | undefined

}

function group(node: OperationNode): OperationNode {
    if (BinaryOperationNode.is(node) || ParensNode.is(node)) {
        return node
    }
    return ParensNode.create(node)
}

function maybe<I, O>(value: I | undefined | null, func: (value: I) => O) {
    if (value === undefined || value === null) {
        return undefined
    }
    return func(value)
}

export class DiscriminatorTransformer extends OperationNodeTransformer {

    private readonly matcher

    constructor(private readonly config: DiscriminatorTransformerConfig) {
        super()
        this.matcher = new TableMatcher(config.discriminator.table)
    }

    /**
     * Turn a list of conditions into a node.
     * @param conditions Conditions
     * @returns A condition node.
     */
    private combineConditions(...conditions: (OperationNode | undefined)[]) {
        const filtered = conditions.filter((_): _ is OperationNode => _ !== undefined)
        if (filtered.length === 0) {
            return
        }
        // Group every condition (unless it's already a single comparison or parenthesised).
        // Otherwise an "or" inside an existing condition, such as a raw SQL fragment, would bind looser than our "and" and escape the discriminator.
        return filtered.map(group).reduce((prev, current) => AndNode.create(prev, current))
    }
    /**
     * Apply the conditions of this discriminator to a table.
     * @param table 
     * @param node 
     * @returns 
     */
    private conditions(table: OperationNode, node: DiscriminatedNode) {
        return Object.entries(callOrGet(this.config.discriminator.columns, node)).map(([column, value]) => {
            // @ts-ignore TODO
            return BinaryOperationNode.create(ReferenceNode.create(ColumnNode.create(column), table),
                OperatorNode.create("="),
                ValueNode.create(value))
        })
    }

    protected override transformJoin(originalNode: JoinNode, queryId?: QueryId | undefined) {
        const node = super.transformJoin(originalNode, queryId)
        const table = this.matcher.testNode(node.table)
        if (table === undefined) {
            return node
        }
        const conditions = this.combineConditions(node.on?.on, ...this.conditions(table, node))
        return {
            ...node,
            on: maybe(conditions, on => OnNode.create(on))
        }
    }

    protected override transformDeleteQuery(originalNode: DeleteQueryNode) {
        const node = super.transformDeleteQuery(originalNode)
        const filters = node.from.froms.flatMap(from => {
            const table = this.matcher.testNode(from)
            if (table === undefined) {
                return []
            }
            return this.conditions(table, node)
        })
        if (filters.length === 0) {
            return node
        }
        const conditions = this.combineConditions(node.where?.where, ...filters)
        return {
            ...node,
            where: maybe(conditions, WhereNode.create)
        }
    }
    protected override transformUpdateQuery(originalNode: UpdateQueryNode) {
        const node = super.transformUpdateQuery(originalNode)
        const table = this.matcher.testNode(node.table)
        if (table === undefined) {
            return node
        }
        const conditions = this.combineConditions(node.where?.where, ...this.conditions(table, node))
        return {
            ...node,
            where: maybe(conditions, WhereNode.create)
        }
    }
    protected override transformInsertQuery(originalNode: InsertQueryNode): InsertQueryNode {
        const node = super.transformInsertQuery(originalNode)
        if (!this.matcher.test(node.into)) {
            return node
        }
        return {
            ...node,
            onConflict: (() => {
                if (node.onConflict === undefined) {
                    return
                }
                return {
                    ...node.onConflict,
                    columns: (() => {
                        if (node.onConflict.columns === undefined) {
                            return
                        }
                        const columns = Object.keys(callOrGet(this.config.discriminator.columns, node)).map(column => ColumnNode.create(column))
                        return [
                            ...node.onConflict.columns,
                            ...columns
                        ]
                    })()
                }
            })()
        }
    }
    protected override transformSelectQuery(originalNode: SelectQueryNode): SelectQueryNode {
        const node = super.transformSelectQuery(originalNode)
        const filters = (node.from?.froms ?? []).flatMap(from => {
            const table = this.matcher.testNode(from)
            if (table === undefined) {
                return []
            }
            return this.conditions(table, node)
        })
        const conditions = this.combineConditions(node.where?.where, ...filters)
        return {
            ...node,
            where: maybe(conditions, WhereNode.create)
        }
    }

}

export type DiscriminatorPluginOptions = { tables: Discriminator[], throwOnUnsupported?: boolean }

export class DiscriminatorPlugin implements KyselyPlugin {

    private readonly transformers

    constructor(options: DiscriminatorPluginOptions) {
        this.transformers = options.tables.map(discriminator => {
            return new DiscriminatorTransformer({ discriminator, throwOnUnsupported: options.throwOnUnsupported })
        })
    }

    transformQuery(args: PluginTransformQueryArgs) {
        return this.transformers.reduce((node, transformer) => transformer.transformNode(node), args.node)
    }
    async transformResult(args: PluginTransformResultArgs) {
        return args.result
    }

}
