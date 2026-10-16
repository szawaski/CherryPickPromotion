import { describe, expect, it, vi } from "vitest";
import type { AdoClient } from "../src/core/adoClient";
import type { PlanItem, WorkItem } from "../src/core/types";
import { groupByWorkItem, groupItems, loadWorkItems, type WorkItemGroup } from "../src/core/workItems";

const item = (key: string, workItemIds: number[]): PlanItem => ({ key, commits: [], workItemIds, hasPendingCommits: true });
const workItem = (id: number, parentId?: number): WorkItem => ({ id, title: `WI ${id}`, type: "Task", state: "Active", parentId });

/** The tree as "id: items [children]" strings, to compare shapes. */
function shape(groups: WorkItemGroup[]): unknown[] {
    return groups.map(g => [g.id ?? "none", g.items.map(i => i.key), ...(g.children.length ? [shape(g.children)] : [])]);
}

describe("groupByWorkItem", () => {
    it("nests work items under their parents and lists an item under each of its work items", () => {
        // Epic 1 > Story 10 > Tasks 100, 101; Story 20 is on its own.
        const workItems = new Map([
            [1, workItem(1)],
            [10, workItem(10, 1)],
            [100, workItem(100, 10)],
            [101, workItem(101, 10)],
            [20, workItem(20)]
        ]);
        const items = [item("pr:3", [100, 20]), item("pr:2", [101]), item("pr:1", [10]), item("commit:x", [])];

        expect(shape(groupByWorkItem(items, workItems))).toEqual([
            [20, ["pr:3"]],
            [1, [], [[10, ["pr:1"], [[101, ["pr:2"]], [100, ["pr:3"]]]]]],
            ["none", ["commit:x"]]
        ]);
    });

    it("keeps work items it couldn't read, and doesn't loop on a parent cycle", () => {
        const workItems = new Map<number, WorkItem | undefined>([
            [5, undefined],
            [6, workItem(6, 7)],
            [7, workItem(7, 6)]
        ]);
        const groups = groupByWorkItem([item("pr:1", [5, 6])], workItems);

        expect(groups.map(g => g.id).sort()).toEqual([5, 6]);
        expect(groups.find(g => g.id === 5)!.workItem).toBeUndefined();
        expect(groupItems(groups.find(g => g.id === 6)!).map(i => i.key)).toEqual(["pr:1"]);
    });
});

describe("loadWorkItems", () => {
    it("loads parents up the tree and remembers ones that couldn't be read", async () => {
        const all = new Map([
            [100, workItem(100, 10)],
            [10, workItem(10, 1)],
            [1, workItem(1)]
        ]);
        const getWorkItems = vi.fn(async (ids: number[]) => ids.flatMap(id => (all.has(id) ? [all.get(id)!] : [])));
        const client = { getWorkItems } as unknown as AdoClient;

        const result = await loadWorkItems(client, [100, 404, 100], new Map());

        expect(getWorkItems.mock.calls).toEqual([[[100, 404]], [[10]], [[1]]]);
        expect([...result.keys()].sort((a, b) => a - b)).toEqual([1, 10, 100, 404]);
        expect(result.get(404)).toBeUndefined();
    });
});
