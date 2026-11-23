import type { AdoClient } from "./adoClient";
import type { PlanItem, ReleaseLinkResult, WorkItem, WorkItemPatch } from "./types";

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
 * Builds the work item tree for the items, keeping their order within each work item and putting the newest groups first. An item linked to several work
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

    // Newest first by the date each group shows, its earliest item's; the higher id first on the same day.
    const since = new Map<WorkItemGroup, number>();
    const earliest = (group: WorkItemGroup): number => {
        let value = since.get(group);
        if (value === undefined) {
            const dates = [...group.items.map(i => Date.parse(itemDate(i) ?? "")), ...group.children.map(earliest)].filter(Number.isFinite);
            value = dates.length > 0 ? Math.min(...dates) : -Infinity;
            since.set(group, value);
        }
        return value;
    };
    const sort = (groups: WorkItemGroup[]) => {
        groups.sort((a, b) => earliest(b) - earliest(a) || b.id! - a.id!);
        for (const group of groups) sort(group.children);
    };
    sort(roots);
    return none.items.length > 0 ? [...roots, none] : roots;
}

/**
 * When the item went into the branch (landedAt), so the dates follow the branch's order. Without commits, the pull
 * request's completion, or its creation while it's open.
 */
export function itemDate(item: PlanItem): string | undefined {
    return item.landedAt ?? item.pullRequest?.closedDate ?? item.pullRequest?.creationDate ?? item.commits[item.commits.length - 1]?.commit.author.date;
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

const relatedLink = "System.LinkTypes.Related";

function isTask(workItem: WorkItem): boolean {
    return workItem.type.trim().toLowerCase() === "task";
}

/** The work item itself when it isn't a Task, else its nearest ancestor that isn't; undefined when there is none. */
export function nonTaskAncestor(id: number, workItems: WorkItemMap): number | undefined {
    const seen = new Set<number>();
    for (let current: number | undefined = id; current !== undefined && !seen.has(current); current = workItems.get(current)?.parentId) {
        seen.add(current);
        const workItem = workItems.get(current);
        if (!workItem) return undefined;
        if (!isTask(workItem)) return current;
    }
    return undefined;
}

/** The release's tag: the title of the release work item, or its nearest non-Task ancestor, without the ";" tags are split on. */
export function releaseTag(releaseId: number, workItems: WorkItemMap): string | undefined {
    const id = nonTaskAncestor(releaseId, workItems);
    const title = id === undefined ? undefined : workItems.get(id)?.title.replace(/;/g, ",").trim();
    return title ? title : undefined;
}

/**
 * The backlog items to link to the release: each work item's nearest non-Task ancestor (a task's backlog item), once
 * each, leaving out the release work item and the ones above it.
 */
export function releaseTargets(ids: Iterable<number>, releaseId: number, workItems: WorkItemMap): number[] {
    const above = new Set<number>();
    for (let current: number | undefined = releaseId; current !== undefined && !above.has(current); current = workItems.get(current)?.parentId) above.add(current);
    const targets = new Set<number>();
    for (const id of ids) {
        const target = nonTaskAncestor(id, workItems);
        if (target !== undefined && !above.has(target)) targets.add(target);
    }
    return [...targets].sort((a, b) => a - b);
}

/**
 * Links the backlog items behind ids to the release work item with a Related link and tags them with the release's
 * title (see releaseTag and releaseTargets). Links and tags they already have are left alone. A work item that can't
 * be updated is noted in failed rather than stopping the others.
 */
export async function linkToRelease(client: AdoClient, ids: Iterable<number>, releaseId: number): Promise<ReleaseLinkResult> {
    const workItems = await loadWorkItems(client, [...ids, releaseId], new Map());
    if (!workItems.get(releaseId)) throw new Error(`Work item #${releaseId} wasn't found or you don't have access.`);
    const tag = releaseTag(releaseId, workItems);
    const targets = releaseTargets(ids, releaseId, workItems);
    const result: ReleaseLinkResult = { releaseId, tag, updated: [], unchanged: [], failed: [] };
    if (targets.length === 0) return result;

    const releaseUrl = client.workItemUrl(releaseId).toLowerCase();
    const linksTo = (url: string) => url.toLowerCase() === releaseUrl || url.toLowerCase().endsWith(`/workitems/${releaseId}`);
    const current = new Map((await client.getWorkItemLinks(targets)).map(w => [w.id, w]));
    for (const id of targets) {
        const links = current.get(id);
        if (!links) {
            result.failed.push({ id, message: "not found or no access" });
            continue;
        }
        const operations: WorkItemPatch[] = [];
        if (!links.relations.some(r => r.rel === relatedLink && linksTo(r.url))) {
            operations.push({ op: "add", path: "/relations/-", value: { rel: relatedLink, url: client.workItemUrl(releaseId) } });
        }
        if (tag && !links.tags.some(t => t.toLowerCase() === tag.toLowerCase())) {
            operations.push({ op: "add", path: "/fields/System.Tags", value: [...links.tags, tag].join("; ") });
        }
        if (operations.length === 0) {
            result.unchanged.push(id);
            continue;
        }
        try {
            await client.updateWorkItem(id, operations);
            result.updated.push(id);
        } catch (error) {
            if (error instanceof Error && error.name === "AbortError") throw error;
            result.failed.push({ id, message: error instanceof Error ? error.message : String(error) });
        }
    }
    return result;
}

function hasCycle(parentId: number, id: number, workItems: WorkItemMap): boolean {
    const seen = new Set([id]);
    for (let p: number | undefined = parentId; p !== undefined; p = workItems.get(p)?.parentId) {
        if (seen.has(p)) return true;
        seen.add(p);
    }
    return false;
}
