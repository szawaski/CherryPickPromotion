import type { AdoClient } from "./adoClient";
import type { PlanItem, WorkItem } from "./types";

/** Work items by id; undefined for ones that are deleted or can't be read, so they aren't asked for again. */
export type WorkItemMap = ReadonlyMap<number, WorkItem | undefined>;

export interface WorkItemGroup {
    key: string;
    /** Undefined for the group of items with no work item. */
    id?: number;
    /** Undefined when the work item couldn't be read. */
    workItem?: WorkItem;
    children: WorkItemGroup[];
    /** Items linked to this work item directly. */
    items: PlanItem[];
}

/** Loads the work items not in known yet, and their parents up to the top of the tree. */
export async function loadWorkItems(client: AdoClient, ids: Iterable<number>, known: WorkItemMap): Promise<Map<number, WorkItem | undefined>> {
    const result = new Map(known);
    let missing = [...new Set(ids)].filter(id => !result.has(id));
    while (missing.length > 0) {
        const loaded = await client.getWorkItems(missing);
        for (const id of missing) result.set(id, undefined);
        for (const workItem of loaded) result.set(workItem.id, workItem);
        missing = [...new Set(loaded.map(w => w.parentId).filter((id): id is number => id !== undefined && !result.has(id)))];
    }
    return result;
}

/**
 * Builds the work item tree for the items, keeping their order within each work item. An item linked to several work
 * items shows up under each one. Parents with no items of their own are included so related work stays together.
 * Items with no work item go in a last group with no id.
 */
export function groupByWorkItem(items: PlanItem[], workItems: WorkItemMap): WorkItemGroup[] {
    const nodes = new Map<number, WorkItemGroup>();
    const roots: WorkItemGroup[] = [];
    const none: WorkItemGroup = { key: "wi:none", children: [], items: [] };

    const node = (id: number): WorkItemGroup => {
        const existing = nodes.get(id);
        if (existing) return existing;
        const workItem = workItems.get(id);
        const group: WorkItemGroup = { key: `wi:${id}`, id, workItem, children: [], items: [] };
        nodes.set(id, group);
        const parentId = workItem?.parentId;
        if (parentId !== undefined && !hasCycle(parentId, id, workItems)) node(parentId).children.push(group);
        else roots.push(group);
        return group;
    };

    for (const item of items) {
        if (item.workItemIds.length === 0) none.items.push(item);
        for (const id of item.workItemIds) node(id).items.push(item);
    }

    const sort = (groups: WorkItemGroup[]) => {
        groups.sort((a, b) => b.id! - a.id!);
        for (const group of groups) sort(group.children);
    };
    sort(roots);
    return none.items.length > 0 ? [...roots, none] : roots;
}

/** Every item in the group and the groups under it, each once. */
export function groupItems(group: WorkItemGroup): PlanItem[] {
    const items = new Map<string, PlanItem>();
    const visit = (g: WorkItemGroup) => {
        for (const item of g.items) items.set(item.key, item);
        g.children.forEach(visit);
    };
    visit(group);
    return [...items.values()];
}

/**
 * Whether the query (lowercase) is the id of, or part of the title or type of, one of the item's work items or
 * their parents, so searching for a feature finds everything under it.
 */
export function workItemMatches(item: PlanItem, workItems: WorkItemMap, query: string): boolean {
    const seen = new Set<number>();
    for (const id of item.workItemIds) {
        for (let current: number | undefined = id; current !== undefined && !seen.has(current); current = workItems.get(current)?.parentId) {
            seen.add(current);
            const workItem = workItems.get(current);
            if (String(current) === query || workItem?.title.toLowerCase().includes(query) || workItem?.type.toLowerCase() === query) return true;
        }
    }
    return false;
}

function hasCycle(parentId: number, id: number, workItems: WorkItemMap): boolean {
    const seen = new Set([id]);
    for (let p: number | undefined = parentId; p !== undefined; p = workItems.get(p)?.parentId) {
        if (seen.has(p)) return true;
        seen.add(p);
    }
    return false;
}
