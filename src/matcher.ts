import { AliasNode, OperationNode, TableNode } from "kysely"

export type TableTest = string | "*" | RegExp | ((table: string, schema?: string) => boolean)
export type TableTests = TableTest | readonly TableTest[]
export type TableMatchable = { table: string, schema?: string }

export class TableMatcher {

    constructor(private readonly matchers: TableTests) {
    }

    table(node: OperationNode | undefined) {
        if (node === undefined) {
            return
        }
        else if (TableNode.is(node)) {
            return {
                underlying: node,
                alias: node
            }
        }
        else if (AliasNode.is(node) && TableNode.is(node.node)/* && TableNode.is(node.alias)*/) {
            return {
                underlying: node.node,
                alias: node.alias,
            }
        }
    }

    testNode(node: OperationNode | undefined) {
        if (node === undefined) {
            return
        }
        const table = this.table(node)
        if (table === undefined) {
            return
        }
        if (this.test(table.underlying)) {
            return table.alias
        }
    }
    test(node: TableNode | undefined) {
        if (node === undefined) {
            return false
        }
        return [this.matchers].flat().map(_ => TableMatcher.match(_, node)).includes(true)
    }

    private static match(matcher: TableTest, node: TableNode) {
        const table = node.table.identifier.name
        const schema = node.table.schema?.name
        const full = (schema !== undefined ? schema + "." : "") + table
        if (typeof matcher === "function") {
            return matcher(table, schema)
        }
        if (typeof matcher === "object") {
            return matcher.test(full)
        }
        return matcher === "*" || matcher === full
    }

}
