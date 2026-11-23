import { describe, expect, it, vi } from "vitest";
import type { AdoClient } from "../src/core/adoClient";
import type { PlanItem, WorkItem } from "../src/core/types";
import { groupByWorkItem, groupItems, itemDate, linkToRelease, loadWorkItems, releaseTag, releaseTargets, workItemMatches, type WorkItemGroup } from "../src/core/workItems";

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

    it("puts the newest groups first by their earliest item, at every level", () => {
        const dated = (key: string, workItemIds: number[], date: string): PlanItem => ({
            ...item(key, workItemIds),
            commits: [{ commit: { commitId: key, comment: key, author: { name: "Dev", email: "dev@example.com", date } }, order: 0, isMerge: false }]
        });
        // Story 10 (under epic 1) started Sep 1; story 30 Oct 1; task 11 Nov 1 and task 12 Sep 15, both under story 10.
        const workItems = new Map([[1, workItem(1)], [10, workItem(10, 1)], [11, workItem(11, 10)], [12, workItem(12, 10)], [30, workItem(30)], [40, workItem(40)]]);
        const items = [dated("a", [10], "2026-09-01T00:00:00Z"), dated("b", [30], "2026-10-01T00:00:00Z"), dated("c", [11], "2026-11-01T00:00:00Z"), dated("d", [12], "2026-09-15T00:00:00Z"), dated("e", [40], "2026-10-01T00:00:00Z")];

        expect(shape(groupByWorkItem(items, workItems))).toEqual([
            [40, ["e"]],
            [30, ["b"]],
            [1, [], [[10, ["a"], [[11, ["c"]], [12, ["d"]]]]]]
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

describe("workItemMatches", () => {
    const workItems = new Map([
        [1, { ...workItem(1), title: "Modernize Schedules UX", type: "Feature" }],
        [10, workItem(10, 1)],
        [100, workItem(100, 10)]
    ]);

    it("matches a parent's title or id", () => {
        expect(workItemMatches(item("pr:1", [100]), workItems, "schedules")).toBe(true);
        expect(workItemMatches(item("pr:1", [100]), workItems, "1")).toBe(true);
        expect(workItemMatches(item("pr:1", [100]), workItems, "feature")).toBe(true);
        expect(workItemMatches(item("pr:1", [100]), workItems, "billing")).toBe(false);
        expect(workItemMatches(item("pr:2", []), workItems, "schedules")).toBe(false);
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

describe("itemDate", () => {
    it("goes by when the item went into the branch, so the dates follow the list", () => {
        const open = { pullRequestId: 1, title: "PR", status: "active" as const, sourceRefName: "refs/heads/f", targetRefName: "refs/heads/develop", creationDate: "2026-11-01T00:00:00Z", createdBy: { displayName: "Dev" } };
        expect(itemDate({ ...item("pr:1", []), pullRequest: open })).toBe("2026-11-01T00:00:00Z");
        expect(itemDate({ ...item("commit:c", []), landedAt: "2026-10-05T00:00:00Z" })).toBe("2026-10-05T00:00:00Z");
    });
});

describe("release linking", () => {
    const typed = (id: number, type: string, title: string, parentId?: number): WorkItem => ({ id, title, type, state: "Active", parentId });
    // Feature 1 > Release PBI 2 "Release 2.3" > Release task 3; Feature 1 > PBI 10 > Task 100; Bug 20 on its own.
    const all = [
        typed(1, "Feature", "Platform"),
        typed(2, "Product Backlog Item", "Release 2.3", 1),
        typed(3, "Task", "Deploy", 2),
        typed(10, "Product Backlog Item", "Export", 1),
        typed(100, "Task", "Write it", 10),
        typed(20, "Bug", "Crash")
    ];
    const map = new Map(all.map(w => [w.id, w]));

    it("tags with the release's nearest non-Task title", () => {
        expect(releaseTag(3, map)).toBe("Release 2.3");
        expect(releaseTag(2, map)).toBe("Release 2.3");
        expect(releaseTag(3, new Map([[3, typed(3, "Task", "Deploy")]]))).toBeUndefined();
        expect(releaseTag(5, new Map([[5, typed(5, "Bug", "a; b")]]))).toBe("a, b");
    });

    it("links each task's backlog item once and leaves out the release and the ones above it", () => {
        expect(releaseTargets([100, 10, 20, 2, 1, 3], 3, map)).toEqual([10, 20]);
    });

    it("adds only the link and tag each backlog item is missing", async () => {
        const updateWorkItem = vi.fn(async () => {});
        const client = {
            getWorkItems: async (ids: number[]) => all.filter(w => ids.includes(w.id)),
            workItemUrl: (id: number) => `https://dev.azure.com/org/_apis/wit/workItems/${id}`,
            getWorkItemLinks: async () => [
                { id: 10, tags: ["Old"], relations: [] },
                { id: 20, tags: ["release 2.3"], relations: [{ rel: "System.LinkTypes.Related", url: "https://dev.azure.com/org/_apis/wit/workItems/3" }] }
            ],
            updateWorkItem
        } as unknown as AdoClient;

        const result = await linkToRelease(client, [100, 20], 3);

        expect(result).toEqual({ releaseId: 3, tag: "Release 2.3", updated: [10], unchanged: [20], failed: [] });
        expect(updateWorkItem).toHaveBeenCalledTimes(1);
        expect(updateWorkItem).toHaveBeenCalledWith(10, [
            { op: "add", path: "/relations/-", value: { rel: "System.LinkTypes.Related", url: "https://dev.azure.com/org/_apis/wit/workItems/3" } },
            { op: "add", path: "/fields/System.Tags", value: "Old; Release 2.3" }
        ]);
    });

    it("notes a work item it can't update and carries on", async () => {
        const client = {
            getWorkItems: async (ids: number[]) => all.filter(w => ids.includes(w.id)),
            workItemUrl: (id: number) => `https://dev.azure.com/org/_apis/wit/workItems/${id}`,
            getWorkItemLinks: async () => [
                { id: 10, tags: [], relations: [] },
                { id: 20, tags: [], relations: [] }
            ],
            updateWorkItem: async (id: number) => {
                if (id === 10) throw new Error("denied");
            }
        } as unknown as AdoClient;

        const result = await linkToRelease(client, [10, 20], 2);

        expect(result.updated).toEqual([20]);
        expect(result.failed).toEqual([{ id: 10, message: "denied" }]);
    });
});
