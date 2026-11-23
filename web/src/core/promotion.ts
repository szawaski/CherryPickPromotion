import { AdoClient, fullBranchName, shortBranchName } from "./adoClient";
import { conflictLineOrigins, type FileOrigins } from "./lineOrigins";
import { linkToRelease } from "./workItems";
import { buildPushChanges, prepareMerge, type ConflictFile, type ConflictLabels, type FileResolution } from "./conflicts";
import type {
    GitChange,
    GitCommitRef,
    GitPullRequest,
    GitRepository,
    ItemDependency,
    PlanCommit,
    PlanItem,
    Promotion,
    PromotionPlan,
    PromotionResult,
    PullRequestMatches,
    PushChange
} from "./types";

export type Progress = (message: string) => void;

export interface ConflictRequest {
    commit: GitCommitRef;
    item: PlanItem;
    /** The files that need a decision; empty when Azure DevOps reported a conflict that merged cleanly here. */
    files: ConflictFile[];
    /** Files the commit changes that merged on their own. */
    autoMerged: string[];
    labels: ConflictLabels;
    /** Dates each conflict line of a text conflict on both sides, to suggest the newer one; undefined when it can't. */
    origins?: (file: ConflictFile) => Promise<FileOrigins | undefined>;
}

/**
 * Resolves one conflicting commit: a resolution for every file in the request, "skip" to stop before its item, or
 * "abort" to give up without a pull request.
 */
export type ResolveConflict = (request: ConflictRequest) => Promise<ConflictAnswer>;
export type ConflictAnswer = ReadonlyMap<string, FileResolution> | "skip" | "abort";

/** Thrown when a promotion is aborted at a conflict. Its branches are removed and no pull request is created. */
export class PromotionAborted extends Error {
    constructor() {
        super("Promotion aborted; no pull request was created.");
    }
}

const parallelRequests = 8;
const pollIntervalMs = 1500;
const cherryPickTimeoutMs = 10 * 60 * 1000;
// Azure DevOps returns a 500 reading back a cherry-pick whose request is over about 4,000 characters; each commit
// adds about 55.
export const maxCommitsPerCherryPick = 50;
// Azure DevOps rejects a pull request description over 4,000 characters.
export const maxDescriptionLength = 4000;
// Azure DevOps rejects a pull request title over 400 characters.
const maxTitleLength = 400;
const minDescriptionLineLength = 20;

export async function analyzePromotion(client: AdoClient, repository: GitRepository, sourceBranch: string, targetBranch: string, progress: Progress): Promise<PromotionPlan> {
    progress("Finding commits on the source branch that are not on the target branch…");
    const [sourceOnly, targetOnly] = await Promise.all([
        client.getCommitsBetween(repository.id, sourceBranch, targetBranch, true),
        client.getCommitsBetween(repository.id, targetBranch, sourceBranch, false)
    ]);

    const missingParents = sourceOnly.filter(c => c.parents === undefined);
    if (missingParents.length > 0) {
        progress(`Loading parents for ${missingParents.length} commits…`);
        await forEachParallel(missingParents, async commit => {
            commit.parents = (await client.getCommit(repository.id, commit.commitId)).parents ?? [];
        });
    }

    progress(`Finding pull requests for ${sourceOnly.length} commits…`);
    const matches = sourceOnly.length === 0
        ? { byMergeCommit: new Map(), byCommit: new Map() }
        : await client.queryPullRequestsByCommits(repository.id, sourceOnly.map(c => c.commitId));

    progress("Finding earlier promotions and open pull requests…");
    const generatedPrefix = fullBranchName(generatedBranchPrefix(targetBranch));
    const [completedIntoTarget, activeIntoTarget, activeIntoSource] = await Promise.all([
        client.getPullRequests(repository.id, targetBranch, "completed"),
        client.getPullRequests(repository.id, targetBranch, "active"),
        client.getPullRequests(repository.id, sourceBranch, "active")
    ]);
    // Earlier promotions by this tool, and every open pull request into the target (a pull request straight from the
    // source, or one from Azure DevOps's Cherry-pick button). Their commits are the originals or cherry-picks, which
    // keep the author, date and message. Reading them from the pull request still works after a squash merge.
    // Sync pull requests hold the original commits rather than cherry-picks, possibly thousands of them, and every one is
    // already on the target, so they're left out.
    const syncPrefix = fullBranchName(syncBranchPrefix(targetBranch));
    const isSync = (pr: GitPullRequest) => pr.sourceRefName.startsWith(syncPrefix);
    const promotions: Promotion[] = [];
    await forEachParallel([...completedIntoTarget.filter(pr => pr.sourceRefName.startsWith(generatedPrefix)), ...activeIntoTarget].filter(pr => !isSync(pr)), async pullRequest => {
        promotions.push({ pullRequest, commits: await client.getPullRequestCommits(repository.id, pullRequest.pullRequestId) });
    });

    const plan = buildPlan(sourceBranch, targetBranch, sourceOnly, targetOnly, matches, promotions, activeIntoSource);
    plan.openSyncPullRequest = activeIntoTarget.find(isSync);
    await matchReferencesOnTarget(client, repository, plan, targetOnly, progress);
    await matchMessageOnTarget(client, repository, plan, targetOnly, progress);
    await matchContentOnTarget(client, repository, plan, progress);

    const pullRequestItems = plan.items.filter(i => i.pullRequest);
    progress(`Loading work items for ${pullRequestItems.length} pull requests…`);
    await forEachParallel(pullRequestItems, async item => {
        const workItems = await client.getPullRequestWorkItems(repository.id, item.pullRequest!.pullRequestId);
        item.workItemIds = mergeIds(item.workItemIds, workItems.map(w => Number(w.id)));
    });

    return plan;
}

/** Remembers which pull requests a commit's message names; commits don't change, so entries never go stale. */
export interface ReferenceCache {
    get(commitId: string): number[] | undefined;
    set(commitId: string, pullRequestIds: number[]): void;
}

/**
 * Marks pull requests the target says it holds: a commit on the target whose message names the pull request
 * ("PR 57066", "PRs 59347, 59350", "!57066", "pull request 61413", or a list line starting with its number, as
 * release pull request descriptions list what they carry), or whose first line is the pull request's title. Azure
 * DevOps cuts long messages off at 200 characters, so those are read in full, once per commit thanks to the cache.
 */
export async function matchReferencesOnTarget(
    client: AdoClient,
    repository: GitRepository,
    plan: PromotionPlan,
    targetOnly: GitCommitRef[],
    progress: Progress,
    cache: ReferenceCache = browserReferenceCache()
): Promise<void> {
    const pending = plan.items.filter(i => i.pullRequest && i.hasPendingCommits);
    if (pending.length === 0 || targetOnly.length === 0) return;

    const unread = targetOnly.filter(c => c.commentTruncated && !cache.get(c.commitId));
    if (unread.length > 0) progress(`Reading ${unread.length} long commit messages on ${plan.targetBranch}…`);
    const referencedBy = new Map<number, string>();
    await forEachParallel(targetOnly, async commit => {
        let ids = commit.commentTruncated ? cache.get(commit.commitId) : referencedPullRequests(commit.comment);
        if (!ids) {
            try {
                ids = referencedPullRequests((await client.getCommit(repository.id, commit.commitId)).comment);
                cache.set(commit.commitId, ids);
            } catch {
                ids = referencedPullRequests(commit.comment);
            }
        }
        for (const id of ids) if (!referencedBy.has(id)) referencedBy.set(id, commit.commitId);
    });
    const byTitle = new Map(targetOnly.map(c => [normalizedMessage(c.comment), c.commitId]));

    for (const item of pending) {
        const pullRequest = item.pullRequest!;
        const title = normalizedMessage(pullRequest.title);
        const referenced = referencedBy.get(pullRequest.pullRequestId);
        // A short title like "Fix tests" could be anything, so only a distinctive one counts.
        const sameTitle = title.length >= 20 ? byTitle.get(title) : undefined;
        const by = referenced ?? sameTitle;
        if (!by) continue;
        const reason = referenced ? `named by ${by.substring(0, 8)} on ${plan.targetBranch}` : `same title as ${by.substring(0, 8)} on ${plan.targetBranch}`;
        for (const commit of item.commits) if (!commit.isMerge && !commit.promotedReason) commit.promotedReason = reason;
        item.hasPendingCommits = false;
    }
}

/** The pull request numbers a commit message names. */
export function referencedPullRequests(message: string): number[] {
    const number = String.raw`!?\d{4,6}`;
    const patterns = [
        new RegExp(String.raw`(?:\bPRs?\b|\bpull requests?\b)\s*[#:]?\s*((?:${number})(?:\s*(?:,|&|\band\b)\s*${number})*)`, "gi"),
        /(?<![\w/])!(\d{4,6})\b/g,
        /^[ \t]*[>*+-][ \t]*!?(\d{5,6})\b(?=[ \t])/gm
    ];
    const ids = new Set<number>();
    for (const pattern of patterns) {
        for (const match of message.matchAll(pattern)) for (const id of match[1].match(/\d{4,6}/g) ?? []) ids.add(Number(id));
    }
    return [...ids];
}

/** A ReferenceCache in the browser's local storage, or in memory where there is none. */
function browserReferenceCache(): ReferenceCache {
    const key = "cherryPickPromotion.commitReferences";
    let entries: Record<string, number[]> = {};
    let storage: Storage | undefined;
    try {
        storage = globalThis.localStorage;
        entries = JSON.parse(storage?.getItem(key) ?? "{}");
    } catch {
        storage = undefined;
    }
    let saving: ReturnType<typeof setTimeout> | undefined;
    return {
        get: commitId => entries[commitId],
        set: (commitId, ids) => {
            entries[commitId] = ids;
            // Written once the burst of lookups is over, not once per commit.
            saving ??= setTimeout(() => {
                saving = undefined;
                try {
                    storage?.setItem(key, JSON.stringify(entries));
                } catch {
                    // full or unavailable: the lookups run again next time
                }
            });
        }
    };
}

/**
 * Marks commits recommitted on the target by hand, when a target commit changes exactly the same files and either:
 * - has the same message, ignoring a "Merged PR n:" prefix and leading [tags] (so a squash merge matches the commit it
 *   squashed); the author and date can differ;
 * - or has the same author and the same author time to the second, with its message reworded (a cherry-pick whose
 *   message was rewritten keeps both).
 * The target may have changed those files since. Only commits with such a candidate are looked up, two requests each;
 * a failed lookup leaves the commit to promote.
 */
export async function matchMessageOnTarget(client: AdoClient, repository: GitRepository, plan: PromotionPlan, targetOnly: GitCommitRef[], progress: Progress): Promise<void> {
    const byMessage = new Map<string, GitCommitRef[]>();
    const byAuthorTime = new Map<string, GitCommitRef[]>();
    const add = (map: Map<string, GitCommitRef[]>, key: string, commit: GitCommitRef) => map.set(key, [...(map.get(key) ?? []), commit]);
    const authorTime = (commit: GitCommitRef) => `${commit.author.email.toLowerCase()}|${Date.parse(commit.author.date)}`;
    for (const commit of targetOnly) {
        const message = normalizedMessage(commit.comment);
        if (message) add(byMessage, message, commit);
        add(byAuthorTime, authorTime(commit), commit);
    }
    const candidates = plan.items
        .flatMap(i => i.commits)
        .filter(c => !c.isMerge && !c.promotedReason)
        .map(c => {
            const sameMessage = byMessage.get(normalizedMessage(c.commit.comment)) ?? [];
            const sameAuthorTime = (byAuthorTime.get(authorTime(c.commit)) ?? []).filter(t => !sameMessage.includes(t));
            return [c, [...sameMessage.map(t => ({ commit: t, why: "message" })), ...sameAuthorTime.map(t => ({ commit: t, why: "author, time" }))]] as const;
        })
        .filter(([, matches]) => matches.length > 0);
    if (candidates.length === 0) return;

    progress(`Comparing ${candidates.length} commits with likely copies on ${plan.targetBranch}…`);
    const paths = new Map<string, Promise<string | undefined>>();
    // The files a commit changes, as one comparable string; undefined when they can't be read.
    const filesOf = (commitId: string) => {
        let files = paths.get(commitId);
        if (!files) {
            files = client.getCommitChanges(repository.id, commitId).then(
                changes => changes.filter(c => !c.item.isFolder && c.item.gitObjectType !== "tree").flatMap(changedPaths).sort().join("\n"),
                () => undefined
            );
            paths.set(commitId, files);
        }
        return files;
    };
    await forEachParallel([...candidates], async ([commit, matches]) => {
        const files = await filesOf(commit.commit.commitId);
        if (!files) return;
        for (const match of matches) {
            if ((await filesOf(match.commit.commitId)) !== files) continue;
            commit.promotedReason = `same ${match.why} and files as ${match.commit.commitId.substring(0, 8)} on ${plan.targetBranch}`;
            return;
        }
    });
    for (const item of plan.items) {
        if (item.commits.length > 0) item.hasPendingCommits = item.commits.some(c => !c.isMerge && !c.promotedReason);
    }
}

/** A commit's first line, lowercase, without a "Merged PR n:" prefix or leading [tags]. */
function normalizedMessage(comment: string): string {
    return firstLine(comment)
        .toLowerCase()
        .replace(/^(\s*(merged pr \d+:|\[[^\]]*\]))+/, "")
        .trim();
}

/**
 * Marks commits whose changes are already on the target by content, for promotions history can't trace, such as
 * several pull requests squashed into one commit. A commit counts when, for every file it changes, the target has the
 * version it left or the version a later source commit left (the target took a newer copy). Anything else, including a
 * failed lookup, leaves the commit to promote.
 */
export async function matchContentOnTarget(client: AdoClient, repository: GitRepository, plan: PromotionPlan, progress: Progress): Promise<void> {
    const pending = plan.items.flatMap(i => i.commits).filter(c => !c.isMerge && !c.promotedReason);
    if (pending.length === 0) return;

    progress(`Comparing the files of ${pending.length} commits with ${plan.targetBranch}…`);
    // The blob each commit left at each path it touched; undefined for a delete.
    const touched = new Map<PlanCommit, Map<string, string | undefined>>();
    await forEachParallel(pending, async commit => {
        try {
            const changes = await client.getCommitChanges(repository.id, commit.commit.commitId);
            const files = new Map<string, string | undefined>();
            for (const change of changes) {
                if (change.item.isFolder || change.item.gitObjectType === "tree") continue;
                const deleted = change.changeType.includes("delete");
                // Without the blob there's nothing to compare, so the commit stays to promote.
                if (!deleted && !change.item.objectId) return;
                files.set(change.item.path, deleted ? undefined : change.item.objectId);
                if (change.changeType.includes("rename") && change.sourceServerItem) files.set(change.sourceServerItem, undefined);
            }
            if (files.size > 0) touched.set(commit, files);
        } catch {
            // left to promote
        }
    });

    const paths = [...new Set([...touched.values()].flatMap(f => [...f.keys()]))];
    progress(`Comparing ${paths.length} files with ${plan.targetBranch}…`);
    const onTarget = new Map<string, string | undefined>();
    const onSource = new Map<string, string | undefined>();
    const failed = new Set<string>();
    await forEachParallel(paths, async path => {
        try {
            const [target, source] = await Promise.all([client.getBranchObjectId(repository.id, path, plan.targetBranch), client.getBranchObjectId(repository.id, path, plan.sourceBranch)]);
            onTarget.set(path, target);
            onSource.set(path, source);
        } catch {
            failed.add(path);
        }
    });

    const byOrder = [...touched].sort(([a], [b]) => a.order - b.order);
    for (const [index, [commit, files]] of byOrder.entries()) {
        const matches = [...files].every(([path, version]) => {
            if (failed.has(path)) return false;
            const target = onTarget.get(path);
            if (target === version || target === onSource.get(path)) return true;
            return byOrder.slice(index + 1).some(([, later]) => later.has(path) && later.get(path) === target);
        });
        if (matches) commit.promotedReason = `same file contents on ${plan.targetBranch}`;
    }
    for (const item of plan.items) {
        if (item.commits.length > 0) item.hasPendingCommits = item.commits.some(c => !c.isMerge && !c.promotedReason);
    }
    findDependencies(plan, touched, onTarget, failed);
}

/**
 * Sets dependsOn: for each file a commit to promote changes, the earlier commits to promote in its history that changed
 * the file after the version the target has. The commit was written on top of their changes, so without them it likely
 * conflicts. Changes to different lines of the same file count too, so this errs toward warning.
 */
function findDependencies(plan: PromotionPlan, touched: Map<PlanCommit, Map<string, string | undefined>>, onTarget: Map<string, string | undefined>, failed: Set<string>): void {
    const pending = [...touched].filter(([c]) => !c.promotedReason).sort(([a], [b]) => a.order - b.order);
    const itemOf = new Map(plan.items.flatMap(i => i.commits.map(c => [c, i] as const)));
    const byId = new Map(plan.items.flatMap(i => i.commits).map(c => [c.commit.commitId, c]));

    for (const [index, [commit, files]] of pending.entries()) {
        const item = itemOf.get(commit)!;
        let ancestors: Set<string> | undefined;
        for (const path of files.keys()) {
            // Newest first, back to the version the target already has.
            for (let i = index - 1; i >= 0; i--) {
                const [earlier, earlierFiles] = pending[i];
                if (!earlierFiles.has(path)) continue;
                ancestors ??= reachable(byId, commit.commit.parents ?? []);
                if (!ancestors.has(earlier.commit.commitId)) continue;
                if (!failed.has(path) && earlierFiles.get(path) === onTarget.get(path)) break;
                const other = itemOf.get(earlier)!;
                if (other === item) continue;
                item.dependsOn ??= [];
                let dependency = item.dependsOn.find(d => d.key === other.key);
                if (!dependency) item.dependsOn.push((dependency = { key: other.key, paths: [] }));
                if (!dependency.paths.includes(path)) dependency.paths.push(path);
            }
        }
    }
}

/** The items the selected ones depend on that aren't selected and still have commits to promote, by selected item key. */
export function missingDependencies(plan: PromotionPlan, selectedKeys: ReadonlySet<string>): Map<string, ItemDependency[]> {
    const pending = new Set(plan.items.filter(i => i.hasPendingCommits).map(i => i.key));
    const missing = new Map<string, ItemDependency[]>();
    for (const item of plan.items) {
        if (!selectedKeys.has(item.key) || !item.hasPendingCommits) continue;
        const needed = (item.dependsOn ?? []).filter(d => pending.has(d.key) && !selectedKeys.has(d.key));
        if (needed.length > 0) missing.set(item.key, needed);
    }
    return missing;
}

/** The selection plus everything it depends on, directly or not. */
export function withDependencies(plan: PromotionPlan, selectedKeys: ReadonlySet<string>): Set<string> {
    const result = new Set(selectedKeys);
    for (let missing = missingDependencies(plan, result); missing.size > 0; missing = missingDependencies(plan, result)) {
        for (const dependencies of missing.values()) for (const d of dependencies) result.add(d.key);
    }
    return result;
}

/**
 * Groups the source-only commits (newest first, as Azure DevOps returns them) into pull requests and
 * orphaned commits, ordered oldest first by when each item landed on the source branch.
 *
 * A commit counts as already promoted when an equivalent commit is on the target, when a completed pull
 * request into the target contains it, when an earlier promotion cherry-picked it, or when an open pull request into
 * the target holds it or a cherry-pick of it.
 * Active pull requests into the source are added as unselectable items at the end.
 */
export function buildPlan(
    sourceBranch: string,
    targetBranch: string,
    sourceOnly: GitCommitRef[],
    targetOnly: GitCommitRef[],
    matches: PullRequestMatches,
    promotions: Promotion[] = [],
    openPullRequests: GitPullRequest[] = []
): PromotionPlan {
    const equivalents = new Map(targetOnly.map(c => [equivalenceKey(c), c.commitId]));
    const sourceRef = fullBranchName(sourceBranch);
    const targetRef = fullBranchName(targetBranch);
    const target = shortBranchName(targetBranch);
    const openPromotions = new Map<string, number>();

    // A completed pull request counts only while its merge is still on the target: resetting or force-pushing the
    // target drops it, and the pull request still says completed.
    const onTarget = new Set(targetOnly.map(c => c.commitId));
    const stillMerged = (pr: GitPullRequest) => !pr.lastMergeCommit || onTarget.has(pr.lastMergeCommit.commitId);

    // Completed promotions go last so they win over open ones holding the same change.
    const promotedBy = new Map<string, GitPullRequest>();
    const counted = promotions.filter(p => p.pullRequest.status !== "completed" || stillMerged(p.pullRequest));
    for (const promotion of counted.sort((a, b) => Number(a.pullRequest.status === "completed") - Number(b.pullRequest.status === "completed"))) {
        for (const commit of promotion.commits) promotedBy.set(equivalenceKey(commit), promotion.pullRequest);
    }

    const promotedReason = (commit: GitCommitRef): string | undefined => {
        const intoTarget = [...completed(matches.byMergeCommit.get(commit.commitId)), ...completed(matches.byCommit.get(commit.commitId))].find(pr => pr.targetRefName === targetRef && stillMerged(pr));
        if (intoTarget) return `in !${intoTarget.pullRequestId} into ${target}`;
        const equivalent = equivalents.get(equivalenceKey(commit));
        if (equivalent) return `same author, date and message as ${equivalent.substring(0, 8)} on ${target}`;
        const promotion = promotedBy.get(equivalenceKey(commit));
        if (!promotion) return undefined;
        if (promotion.status === "completed") return `promoted in !${promotion.pullRequestId}`;
        openPromotions.set(commit.commitId, promotion.pullRequestId);
        return `in open PR !${promotion.pullRequestId} into ${target}`;
    };

    const planned = orderOldestFirst(sourceOnly).map((commit, order) => {
        const pullRequest = choosePullRequest(commit.commitId, sourceRef, targetRef, matches);
        const planCommit: PlanCommit = {
            commit,
            order,
            isMerge: (commit.parents?.length ?? 0) > 1,
            promotedReason: promotedReason(commit)
        };
        return { planCommit, pullRequest };
    });
    for (const { planCommit } of planned) planCommit.inOpenPullRequest = openPromotions.get(planCommit.commit.commitId);

    // A merge commit already on the target (Azure DevOps cherry-picks a pull request as its merge commit)
    // brings the commits it merged in with it: those reachable from its other parents but not its mainline. That set
    // already covers nested merges, so only merges on the target in their own right pass a reason down. A nested merge
    // marked here doesn't: it's measured against its own mainline, so a "merge main into the feature branch" commit
    // would hand the reason to commits from main that the outer merge never brought.
    const byId = new Map(planned.map(p => [p.planCommit.commit.commitId, p.planCommit]));
    const promotedMerges = planned.map(p => p.planCommit).filter(c => c.isMerge && c.promotedReason);
    for (const merge of promotedMerges.reverse()) {
        const [mainline, ...mergedIn] = merge.commit.parents!;
        const onMainline = reachable(byId, [mainline]);
        for (const id of reachable(byId, mergedIn)) {
            const merged = byId.get(id)!;
            if (!onMainline.has(id) && !merged.promotedReason) {
                merged.promotedReason = `merged in by ${merge.commit.commitId.substring(0, 8)}, which is ${merge.promotedReason}`;
                merged.inOpenPullRequest = merge.inOpenPullRequest;
            }
        }
    }

    const itemsByKey = new Map<string, PlanItem>();
    for (const { planCommit, pullRequest } of planned) {
        const commit = planCommit.commit;
        const key = pullRequest ? `pr:${pullRequest.pullRequestId}` : `commit:${commit.commitId}`;
        let item = itemsByKey.get(key);
        if (!item) {
            item = { key, pullRequest, commits: [], workItemIds: [], hasPendingCommits: false };
            itemsByKey.set(key, item);
        }
        item.commits.push(planCommit);
        item.workItemIds = mergeIds(item.workItemIds, (commit.workItems ?? []).map(w => Number(w.id)));
        if (!planCommit.isMerge && !planCommit.promotedReason) item.hasPendingCommits = true;
        item.promotedIn ??= openPromotions.get(commit.commitId);
    }

    // An item lands when the source's first-parent line brings in its last commit, which for a pull request is its
    // merge. Items brought in by the same commit keep their order.
    const landing = landingCommits(planned.map(p => p.planCommit));
    const steps = new Map<PlanItem, number>();
    for (const item of itemsByKey.values()) {
        const lands = item.commits.map(c => landing.get(c.commit.commitId)).reduce((a, b) => (b && (!a || b.step > a.step) ? b : a), undefined);
        const by = lands?.by ?? item.commits[item.commits.length - 1];
        steps.set(item, lands?.step ?? -1);
        item.landedAt = by.commit.committer?.date ?? by.commit.author.date;
    }
    const last = (item: PlanItem) => item.commits[item.commits.length - 1].order;
    const items = [...itemsByKey.values()].sort((a, b) => steps.get(a)! - steps.get(b)! || last(a) - last(b));

    // Open pull requests haven't landed yet, so they go after everything that has.
    for (const pullRequest of [...openPullRequests].sort((a, b) => a.creationDate.localeCompare(b.creationDate))) {
        const key = `pr:${pullRequest.pullRequestId}`;
        if (!itemsByKey.has(key)) items.push({ key, pullRequest, commits: [], workItemIds: [], hasPendingCommits: false, openPullRequest: true });
    }

    return { sourceBranch: shortBranchName(sourceBranch), targetBranch: shortBranchName(targetBranch), items };
}

/**
 * The commits to cherry-pick for the selected items: item by item in the order they landed, each item's commits
 * in source branch order. A merge-commit pull request's commits can be older than items that landed before it, so
 * ordering by commit alone would interleave pull requests.
 */
export function selectCommits(plan: PromotionPlan, selectedKeys: ReadonlySet<string>): PlanCommit[] {
    return plan.items
        .filter(i => selectedKeys.has(i.key))
        .flatMap(i => i.commits.filter(c => !c.isMerge && !c.promotedReason).sort((a, b) => a.order - b.order));
}

/**
 * The selection's ids, one per line, oldest first: a pull request's number, or a direct commit's full id. Items
 * already on the target are left out.
 */
export function cherryPickList(plan: PromotionPlan, selectedKeys: ReadonlySet<string>): string {
    return plan.items
        .filter(i => selectedKeys.has(i.key) && i.hasPendingCommits)
        .map(i => (i.pullRequest ? String(i.pullRequest.pullRequestId) : i.commits[i.commits.length - 1].commit.commitId))
        .join("\n");
}

export function selectWorkItemIds(plan: PromotionPlan, selectedKeys: ReadonlySet<string>): number[] {
    return plan.items
        .filter(i => selectedKeys.has(i.key))
        .reduce<number[]>((ids, i) => mergeIds(ids, i.workItemIds), [])
        .sort((a, b) => a - b);
}

/**
 * "[target] " followed by: the linked work item's number and title when there is one; else the one item's title, with
 * its work items in front unless the title already names them; else every selected work item's number, then the pull
 * request or commit of each item without one.
 */
export function defaultTitle(plan: PromotionPlan, selectedKeys: ReadonlySet<string>, workItem?: { id: number; title: string }): string {
    const prefix = `[${plan.targetBranch}]`;
    const tag = (ids: number[]) => ids.map(id => `#${id}`).join(" ");
    let title: string;
    const items = plan.items.filter(i => selectedKeys.has(i.key) && i.hasPendingCommits);
    if (workItem?.title.trim()) {
        title = `${tag([workItem.id])} ${workItem.title.trim()}`;
    } else if (items.length === 1) {
        const item = items[0];
        const itemTitle = (item.pullRequest ? item.pullRequest.title : firstLine(item.commits[0].commit.comment)).trim();
        const unnamed = [...item.workItemIds].sort((a, b) => a - b).filter(id => !new RegExp(`#${id}(?!\\d)`).test(itemTitle));
        title = unnamed.length > 0 ? `${tag(unnamed)} ${itemTitle}` : itemTitle;
    } else {
        // An item without work items is named by its pull request, or its commit when it has none.
        const ids = items.reduce<number[]>((all, i) => mergeIds(all, i.workItemIds), []).sort((a, b) => a - b);
        const unlinked = items.filter(i => i.workItemIds.length === 0).map(i => (i.pullRequest ? `!${i.pullRequest.pullRequestId}` : i.commits[0].commit.commitId.substring(0, 8)));
        title = [tag(ids), ...unlinked].filter(Boolean).join(" ");
    }
    return shorten(`${prefix} ${title}`, maxTitleLength);
}

/** Cuts the text at the last space within max characters, ending it with an ellipsis. */
function shorten(text: string, max: number): string {
    if (text.length <= max) return text;
    const cut = text.lastIndexOf(" ", max - 1);
    return `${text.substring(0, cut > 0 ? cut : max - 1)}…`;
}

/**
 * A line per item starting with its id, "!" and the pull request's number or a direct commit's short id, then its title
 * (the pull request's, or the commit's first line). If that's over max, the titles are left out.
 */
export function promotionDescription(items: PlanItem[], max = maxDescriptionLength): string {
    const id = (i: PlanItem) => (i.pullRequest ? `!${i.pullRequest.pullRequestId}` : i.commits[0].commit.commitId.substring(0, 8));
    const title = (i: PlanItem) => (i.pullRequest ? i.pullRequest.title : firstLine(i.commits[0].commit.comment)).trim();
    // Titles only while everything fits; past the limit, just the ids, which are what a later run looks for.
    const titled = items.map(i => `- ${id(i)} ${title(i)}`).join("\n");
    return titled.length <= max ? titled : fitLines(items.map(i => `- ${id(i)}`), max);
}

/**
 * Joins the lines within max characters. Too long, the longest lines are shortened to the same width, so every line
 * keeps its start. If they don't fit even at minDescriptionLineLength, the last ones are replaced by a count.
 */
export function fitLines(lines: string[], max: number): string {
    const length = (width: number, count: number) => lines.slice(0, count).reduce((sum, l) => sum + Math.min(l.length, width), 0) + Math.max(0, count - 1);
    if (length(Infinity, lines.length) <= max) return lines.join("\n");

    if (length(minDescriptionLineLength, lines.length) <= max) {
        let low = minDescriptionLineLength;
        let high = Math.max(...lines.map(l => l.length));
        while (low < high) {
            const mid = Math.ceil((low + high) / 2);
            if (length(mid, lines.length) <= max) low = mid;
            else high = mid - 1;
        }
        return lines.map(l => truncate(l, low)).join("\n");
    }

    const more = (count: number) => `- …and ${lines.length - count} more`;
    let count = lines.length - 1;
    while (count > 0 && length(minDescriptionLineLength, count) + 1 + more(count).length > max) count--;
    return [...lines.slice(0, count).map(l => truncate(l, minDescriptionLineLength)), more(count)].join("\n");
}

function truncate(text: string, width: number): string {
    return text.length <= width ? text : `${text.substring(0, width - 1).trimEnd()}…`;
}

/**
 * Cherry-picks the selected items onto a new branch and opens one pull request into the target.
 *
 * The commits go in chunks of maxCommitsPerCherryPick, each onto the branch the previous chunk made. On a conflict,
 * resolveConflict (when given) gets to resolve it, and the resolved commit is pushed before carrying on. If it's skipped,
 * or there is no resolveConflict, only the items that landed before the conflicting one are kept, so the pull request
 * holds everything up to it and no item is promoted halfway. Its description lists the included items' titles.
 * With details.workItemId, the included items' backlog items then get a Related link to it and a tag of its title
 * (see linkToRelease).
 */
export async function createPromotionPullRequest(
    client: AdoClient,
    repository: GitRepository,
    plan: PromotionPlan,
    selectedKeys: ReadonlySet<string>,
    details: { title: string; /** Linked on top of the items' work items. */ workItemId?: number },
    progress: Progress,
    resolveConflict?: ResolveConflict
): Promise<PromotionResult> {
    const items = plan.items.filter(i => selectedKeys.has(i.key) && i.hasPendingCommits);
    const commits = selectCommits(plan, new Set(items.map(i => i.key)));
    if (commits.length === 0) throw new Error("The selection has no commits left to cherry-pick.");
    const itemOf = new Map(items.flatMap(i => i.commits.map(c => [c, i] as const)));

    const stamp = timestamp(new Date());
    const created: string[] = [];
    const nextBranch = () => `${generatedBranchPrefix(plan.targetBranch)}${stamp}-${created.length + 1}`;
    // Each completed step leaves a branch holding the first `count` commits; the target holds none.
    const checkpoints = [{ count: 0, branch: plan.targetBranch }];
    let end = commits.length;
    let conflict: PromotionResult["conflict"];
    let resolvedConflicts = 0;
    let finalBranch: string | undefined;
    let creatingPullRequest = false;

    try {
        while (checkpoints[checkpoints.length - 1].count < end) {
            const from = checkpoints[checkpoints.length - 1];
            const branch = nextBranch();
            const chunk = commits.slice(from.count, Math.min(end, from.count + maxCommitsPerCherryPick));
            const label = `Cherry-picking commits ${from.count + 1}–${from.count + chunk.length} of ${end} onto ${plan.targetBranch}`;

            created.push(branch);
            const conflictCommitId = await runCherryPick(client, repository, chunk, from.branch, branch, label, progress);
            if (conflictCommitId === undefined) {
                checkpoints.push({ count: from.count + chunk.length, branch });
                continue;
            }

            // Azure DevOps may report an abbreviated commit id.
            const conflicting = chunk.find(c => c.commit.commitId.startsWith(conflictCommitId.toLowerCase()));
            if (!conflicting) throw new Error(`Cherry-pick hit a conflict at commit ${conflictCommitId.substring(0, 8)}.`);
            const conflictItem = itemOf.get(conflicting)!;

            if (resolveConflict) {
                // Bring a branch up to just before the conflicting commit, then apply that commit by hand.
                const index = commits.indexOf(conflicting);
                let base = from;
                if (index > from.count) {
                    const before = nextBranch();
                    created.push(before);
                    const again = await runCherryPick(client, repository, commits.slice(from.count, index), from.branch, before, `Cherry-picking commits ${from.count + 1}–${index} of ${end} onto ${plan.targetBranch}`, progress);
                    if (again !== undefined) throw new Error(`Cherry-picking the commits before ${commitLabel(conflicting.commit)} hit a conflict at ${again.substring(0, 8)} that the first attempt didn't report.`);
                    base = { count: index, branch: before };
                    checkpoints.push(base);
                }
                const resolved = await resolveInteractively(client, repository, plan, conflicting, conflictItem, base.branch, nextBranch(), created, resolveConflict, progress);
                if (resolved) {
                    checkpoints.push({ count: index + 1, branch: resolved });
                    resolvedConflicts++;
                    continue;
                }
            }

            conflict = { commit: conflicting.commit, itemKey: conflictItem.key };

            // Stop before the conflicting item's first commit, and drop chunks that already hold part of it.
            end = commits.findIndex(c => itemOf.get(c) === conflictItem);
            if (end === 0) throw new Error(`The first selected change conflicts with ${plan.targetBranch} at commit ${commitLabel(conflict.commit)}, so nothing could be promoted. Resolve it locally or leave that item out.`);
            while (checkpoints[checkpoints.length - 1].count > end) checkpoints.pop();
            progress(`Conflict at commit ${commitLabel(conflicting.commit)}; keeping the ${items.indexOf(conflictItem)} items before it…`);
        }

        finalBranch = checkpoints[checkpoints.length - 1].branch;
        const included = new Set(conflict ? items.slice(0, items.findIndex(i => i.key === conflict!.itemKey)).map(i => i.key) : items.map(i => i.key));
        progress("Creating the pull request…");
        creatingPullRequest = true;
        const pullRequest = await withStep(`The cherry-pick worked and is on ${finalBranch}, but creating the pull request`, () =>
            client.createPullRequest(repository.id, {
                sourceBranch: finalBranch!,
                targetBranch: plan.targetBranch,
                title: details.title,
                description: promotionDescription(items.filter(i => included.has(i.key))),
                workItemIds: details.workItemId === undefined ? selectWorkItemIds(plan, included) : mergeIds(selectWorkItemIds(plan, included), [details.workItemId])
            })
        );
        let release: PromotionResult["release"];
        if (details.workItemId !== undefined) {
            // The pull request stands either way, so a failure here is only reported.
            progress(`Linking the work items to #${details.workItemId}…`);
            try {
                release = await linkToRelease(client, selectWorkItemIds(plan, included), details.workItemId);
            } catch (error) {
                release = { releaseId: details.workItemId, updated: [], unchanged: [], failed: [{ id: details.workItemId, message: error instanceof Error ? error.message : String(error) }] };
            }
        }
        return { pullRequest, includedKeys: [...included], conflict, resolvedConflicts, release };
    } catch (error) {
        // Without a pull request nothing is kept, unless only the pull request failed and its branch is ready to use.
        if (!creatingPullRequest) finalBranch = undefined;
        throw error;
    } finally {
        // The final branch stays; every other branch made along the way is removed.
        for (const branch of created.filter(b => b !== finalBranch)) {
            try {
                await client.deleteBranch(repository.id, branch);
            } catch {
                // best effort; a leftover branch is harmless and named for this promotion
            }
        }
    }
}

export interface SyncPoint {
    /** The newest commit on the source's first-parent line whose every change is already on the target. */
    commit: GitCommitRef;
    /** How many of the source-only commits a merge of it would take off the list. */
    commitCount: number;
}

export interface SyncSearch {
    point?: SyncPoint;
    /** The oldest change that isn't on the target, which keeps the sync point from moving past it. */
    blockedBy?: { commit: PlanCommit; item?: PlanItem };
}

/**
 * The latest point where both branches have the same changes: the newest commit on the source's mainline such that
 * every commit behind it that isn't on the target has an equivalent there (a completed promotion, a cherry-pick or the
 * same change). Merging it into the target joins the histories, so later comparisons start from it. Commits only in an
 * open pull request don't count, as they aren't on the target yet.
 */
export function findSyncPoint(plan: PromotionPlan): SyncSearch {
    const commits = plan.items.flatMap(i => i.commits);
    if (commits.length === 0) return {};
    const byId = new Map(commits.map(c => [c.commit.commitId, c]));
    const mainline = mainlineOf(commits);
    if (mainline.length === 0) return {};

    // Each mainline commit brings in the ones behind it; once one of those isn't on the target, nothing later qualifies.
    const behind = new Set<string>();
    let point: SyncPoint | undefined;
    for (const step of mainline) {
        // Every commit this step brings in, oldest first, so the one reported is the oldest in the way.
        const added = [...reachable(byId, [step.commit.commitId])].filter(id => !behind.has(id)).map(id => byId.get(id)!).sort((x, y) => x.order - y.order);
        const blocking = added.find(c => !c.isMerge && (!c.promotedReason || c.inOpenPullRequest !== undefined));
        if (blocking) return { point, blockedBy: { commit: blocking, item: plan.items.find(i => i.commits.includes(blocking)) } };
        for (const c of added) behind.add(c.commit.commitId);
        point = { commit: step.commit, commitCount: behind.size };
    }
    return { point };
}

/**
 * Opens a pull request that joins the source's history, up to the sync point, to the target's without changing a file.
 *
 * Merging the sync point as it is would go wrong: the target took newer versions of many files through later
 * promotions, including files deleted on the source since, and a three-way merge from an old common ancestor can't
 * tell those are right. It conflicts, and where it doesn't, it can bring back what the target left behind. Every change
 * up to the sync point is on the target already, so the target's files are the answer (git's "ours" merge). Azure
 * DevOps can't push a merge commit, so the branch starts at the sync point and one commit sets every file both sides
 * changed since their common ancestor to the target's version. Merging that only meets changes identical to the
 * target's or ones the target made alone, so it can't conflict and leaves the target's files exactly as they are.
 */
export async function createSyncPullRequest(client: AdoClient, repository: GitRepository, plan: PromotionPlan, point: SyncPoint, progress: Progress): Promise<GitPullRequest> {
    const branch = `${syncBranchPrefix(plan.targetBranch)}${timestamp(new Date())}`;
    const syncId = point.commit.commitId;
    const sha = syncId.substring(0, 8);

    progress(`Comparing ${plan.sourceBranch} at ${sha} with ${plan.targetBranch}…`);
    const head = await client.getBranchHead(repository.id, plan.targetBranch);
    const base = await client.getMergeBase(repository.id, syncId, head);
    const [sourceChanges, toTarget] = await Promise.all([client.getDiff(repository.id, base, syncId), client.getDiff(repository.id, syncId, head)]);
    const changedOnSource = new Set(sourceChanges.flatMap(changedPaths));
    // The files the target has differently: its blob for each, or undefined where the target doesn't have it.
    const onTarget = new Map<string, string | undefined>();
    for (const change of toTarget) {
        if (change.item.isFolder || change.item.gitObjectType === "tree") continue;
        onTarget.set(change.item.path, change.changeType.includes("delete") ? undefined : change.item.objectId);
        if (change.changeType.includes("rename") && change.sourceServerItem) onTarget.set(change.sourceServerItem, undefined);
    }
    const toAlign = [...onTarget].filter(([path]) => changedOnSource.has(path));

    progress(`Creating ${branch} at ${sha}…`);
    await client.createBranch(repository.id, branch, syncId);
    if (toAlign.length > 0) {
        progress(`Setting ${toAlign.length} files to ${plan.targetBranch}'s versions…`);
        // A file the target has is edited where the sync point has it too, and added where it doesn't.
        const atSyncPoint = new Set(toTarget.filter(c => !c.changeType.includes("add")).map(c => (c.changeType.includes("rename") && c.sourceServerItem ? c.sourceServerItem : c.item.path)));
        const changes: PushChange[] = [];
        await forEachParallel(toAlign, async ([path, blob]) => {
            if (blob === undefined) {
                changes.push({ changeType: "delete", item: { path } });
            } else {
                const content = await client.getFileBase64(repository.id, path, head);
                changes.push({ changeType: atSyncPoint.has(path) ? "edit" : "add", item: { path }, newContent: { content, contentType: "base64encoded" } });
            }
        });
        changes.sort((a, b) => a.item.path.localeCompare(b.item.path));
        await withStep(`The branch ${branch} is created, but setting its files to ${plan.targetBranch}'s`, () =>
            client.pushCommit(repository.id, branch, syncId, {
                comment: `Match ${plan.targetBranch}'s files on top of ${plan.sourceBranch} at ${sha}, so merging it changes nothing`,
                changes
            })
        );
    }
    progress("Creating the rebase PR…");
    return withStep(`The branch ${branch} is ready, but creating the pull request`, () =>
        client.createPullRequest(repository.id, {
            sourceBranch: branch,
            targetBranch: plan.targetBranch,
            title: `Rebase ${plan.targetBranch} on ${plan.sourceBranch} at ${sha}`,
            description: [
                `Every change on ${plan.sourceBranch} up to ${sha} is already on ${plan.targetBranch}, through promotions or cherry-picks. ` +
                    `This merges ${plan.sourceBranch} as of ${sha} so the two branches share that history, and the next promotion only lists what came after it.`,
                "",
                "**Complete it with Merge (no fast-forward).** A squash merge would leave the histories apart and the commits listed again.",
                "",
                `It changes no files. ${plan.targetBranch} took newer versions of some files through later promotions, so the branch's last commit replaces ${plan.sourceBranch}'s versions of the ` +
                    `${toAlign.length} files both branches changed with ${plan.targetBranch}'s, and merging leaves ${plan.targetBranch} as it is.`
            ].join("\n"),
            workItemIds: [],
            mergeStrategy: "noFastForward"
        })
    );
}

/** The paths a change touches: its own, and the old one of a rename. */
function changedPaths(change: GitChange): string[] {
    if (change.item.isFolder || change.item.gitObjectType === "tree") return [];
    return change.changeType.includes("rename") && change.sourceServerItem ? [change.item.path, change.sourceServerItem] : [change.item.path];
}

/**
 * Sets a pull request this tool created to complete on its own once its policies pass, deleting its generated branch.
 * A sync pull request keeps its merge, since a squash would undo what it's for; promotions use the target's default.
 */
export async function setAutoComplete(client: AdoClient, repository: GitRepository, pullRequest: GitPullRequest, sync = false): Promise<void> {
    const userId = pullRequest.createdBy.id;
    if (!userId) throw new Error("Azure DevOps didn't say who created the pull request.");
    await client.setAutoComplete(repository.id, pullRequest.pullRequestId, userId, { deleteSourceBranch: true, ...(sync ? { mergeStrategy: "noFastForward" as const } : {}) });
}

/**
 * Merges a conflicting commit onto a branch, asks for the conflicts to be resolved and pushes the result as a new branch
 * holding one commit with the original author, date and message. Returns that branch, or undefined if it was skipped.
 */
async function resolveInteractively(
    client: AdoClient,
    repository: GitRepository,
    plan: PromotionPlan,
    commit: PlanCommit,
    item: PlanItem,
    baseBranch: string,
    newBranch: string,
    created: string[],
    resolveConflict: ResolveConflict,
    progress: Progress
): Promise<string | undefined> {
    progress(`Conflict at commit ${commitLabel(commit.commit)}; loading its changes…`);
    const head = await client.getBranchHead(repository.id, baseBranch);
    // The batch list can cut long messages short; the cherry-pick has to keep the whole one.
    const full = commit.commit.commentTruncated ? await client.getCommit(repository.id, commit.commit.commitId) : commit.commit;
    const labels = { current: plan.targetBranch, incoming: `${full.commitId.substring(0, 8)} (${plan.sourceBranch})` };
    const prepared = await prepareMerge(client, repository.id, { ...full, parents: full.parents ?? commit.commit.parents }, head, labels);

    progress(`Waiting for the conflicts in commit ${commitLabel(full)} to be resolved…`);
    const answer = await resolveConflict({
        commit: full,
        item,
        files: prepared.conflicts,
        autoMerged: prepared.merged.map(m => m.path),
        labels,
        origins: file => conflictLineOrigins(client, repository.id, file)
    });
    if (answer === "abort") throw new PromotionAborted();
    if (answer === "skip") return undefined;

    progress(`Committing the resolved commit ${commitLabel(full)}…`);
    const changes = await buildPushChanges(client, repository.id, prepared, answer);
    created.push(newBranch);
    await client.createBranch(repository.id, newBranch, head);
    if (changes.length > 0) await client.pushCommit(repository.id, newBranch, head, { comment: full.comment, author: full.author, changes });
    return newBranch;
}

/** Runs one cherry-pick operation. Returns the conflicting commit id on a conflict, or undefined when it completed. */
async function runCherryPick(client: AdoClient, repository: GitRepository, commits: PlanCommit[], ontoBranch: string, generatedBranch: string, label: string, progress: Progress): Promise<string | undefined> {
    progress(`${label}…`);
    let operation = await withStep(`Starting the cherry-pick onto a new ${generatedBranch} branch`, () =>
        client.createCherryPick(repository.id, commits.map(c => c.commit.commitId), ontoBranch, generatedBranch)
    );

    const started = Date.now();
    const cherryPickId = operation.cherryPickId;
    while (operation.status === "queued" || operation.status === "inProgress") {
        if (Date.now() - started > cherryPickTimeoutMs) throw new Error(`Cherry-pick ${cherryPickId} did not finish within 10 minutes. Check whether the ${generatedBranch} branch was created before trying again.`);
        await delay(pollIntervalMs);
        try {
            operation = await client.getCherryPick(repository.id, cherryPickId);
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            throw new Error(`Checking on cherry-pick ${cherryPickId} failed: ${message} The cherry-pick may still finish on the server; check whether the ${generatedBranch} branch was created before trying again.`);
        }
        const done = operation.detailedStatus?.progress;
        if (done !== undefined) progress(`${label}… ${Math.round(done * 100)}%`);
    }

    if (operation.status === "completed") return undefined;

    const detail = operation.detailedStatus;
    if (detail?.conflict && detail.currentCommitId) return detail.currentCommitId;
    const reasons = [
        detail?.failureMessage,
        detail?.status && detail.status !== "none" ? `reason: ${detail.status}` : undefined,
        detail?.timedout ? "timed out on the server" : undefined,
        detail?.conflict ? "conflict at an unknown commit" : undefined
    ].filter(Boolean);
    throw new Error(`Cherry-pick ${operation.status}: ${reasons.length > 0 ? reasons.join("; ") : `no details returned (${JSON.stringify(detail ?? {})})`}`);
}

function commitLabel(commit: GitCommitRef): string {
    return `${commit.commitId.substring(0, 8)} "${firstLine(commit.comment)}"`;
}

export function pullRequestUrl(repository: GitRepository, pullRequestId: number): string {
    return `${repository.webUrl}/pullrequest/${pullRequestId}`;
}

export function commitUrl(repository: GitRepository, commitId: string): string {
    return `${repository.webUrl}/commit/${commitId}`;
}

export function workItemUrl(repository: GitRepository, workItemId: number): string {
    return `${repository.webUrl.split("/_git/")[0]}/_workitems/edit/${workItemId}`;
}

export function firstLine(text: string): string {
    const index = text.indexOf("\n");
    return (index < 0 ? text : text.substring(0, index)).trim();
}

/** Where every branch this tool creates lives, whatever the target. */
const generatedRefPrefix = "refs/heads/cherry-pick/";

function generatedBranchPrefix(targetBranch: string): string {
    return `cherry-pick/${shortBranchName(targetBranch)}/`;
}

function syncBranchPrefix(targetBranch: string): string {
    return `${generatedBranchPrefix(targetBranch)}sync/`;
}

/**
 * Prefers the pull request that brought the commit into the source branch, then any completed one other
 * than a pull request into the target. Merge commit matches beat plain commit matches, and the earliest
 * completion wins within a tier.
 *
 * Pull requests that can't have brought the commit into the source are left out: this tool's own (a rebase pull
 * request holds the source's history, a promotion holds copies), and ones from the source branch itself. Without
 * them, a commit pushed straight to the source shows as itself rather than under some later pull request.
 */
function choosePullRequest(commitId: string, sourceRef: string, targetRef: string, matches: PullRequestMatches): GitPullRequest | undefined {
    const carriedIt = (pr: GitPullRequest) => pr.targetRefName !== targetRef && pr.sourceRefName !== sourceRef && !pr.sourceRefName.startsWith(generatedRefPrefix);
    const merged = completed(matches.byMergeCommit.get(commitId)).filter(carriedIt);
    const containing = completed(matches.byCommit.get(commitId)).filter(carriedIt);
    const intoSource = (pr: GitPullRequest) => pr.targetRefName === sourceRef;
    const tiers = [merged.filter(intoSource), containing.filter(intoSource), merged, containing];
    for (const tier of tiers) {
        if (tier.length > 0) return tier.reduce((a, b) => ((a.closedDate ?? "") <= (b.closedDate ?? "") ? a : b));
    }
    return undefined;
}

function completed(pullRequests: GitPullRequest[] | undefined): GitPullRequest[] {
    return (pullRequests ?? []).filter(pr => pr.status === "completed");
}

/** Cherry-picks keep the author, author date and message, so a match means the change is already on the target. */
function equivalenceKey(commit: GitCommitRef): string {
    return `${commit.author.email.toLowerCase()}|${commit.author.date}|${firstLine(commit.comment)}`;
}

/** Parents before children; otherwise the reverse of the server's newest-first order. */
function orderOldestFirst(commits: GitCommitRef[]): GitCommitRef[] {
    const reversed = [...commits].reverse();
    const byId = new Map(reversed.map(c => [c.commitId, c]));
    const visited = new Set<string>();
    const result: GitCommitRef[] = [];

    for (const root of reversed) {
        if (visited.has(root.commitId)) continue;
        visited.add(root.commitId);
        const stack = [{ commit: root, next: 0 }];
        while (stack.length > 0) {
            const frame = stack[stack.length - 1];
            const parents = frame.commit.parents ?? [];
            if (frame.next < parents.length) {
                const parent = byId.get(parents[frame.next++]);
                if (parent && !visited.has(parent.commitId)) {
                    visited.add(parent.commitId);
                    stack.push({ commit: parent, next: 0 });
                }
            } else {
                stack.pop();
                result.push(frame.commit);
            }
        }
    }
    return result;
}

async function withStep<T>(step: string, action: () => Promise<T>): Promise<T> {
    try {
        return await action();
    } catch (error) {
        throw new Error(`${step} failed: ${error instanceof Error ? error.message : String(error)}`);
    }
}

/** The source's first-parent line among the commits, oldest first, from the newest commit nothing else builds on. */
function mainlineOf(commits: PlanCommit[]): PlanCommit[] {
    const byId = new Map(commits.map(c => [c.commit.commitId, c]));
    const parents = new Set(commits.flatMap(c => c.commit.parents ?? []));
    const head = commits.filter(c => !parents.has(c.commit.commitId)).sort((a, b) => b.order - a.order)[0];
    const mainline: PlanCommit[] = [];
    for (let c: PlanCommit | undefined = head; c; c = byId.get(c.commit.parents?.[0] ?? "")) mainline.unshift(c);
    return mainline;
}

/** For each commit, the first-parent commit that brought it into the source, and that commit's place on the line. */
function landingCommits(commits: PlanCommit[]): Map<string, { by: PlanCommit; step: number }> {
    const byId = new Map(commits.map(c => [c.commit.commitId, c]));
    const landing = new Map<string, { by: PlanCommit; step: number }>();
    for (const [step, by] of mainlineOf(commits).entries()) {
        for (const id of reachable(byId, [by.commit.commitId])) if (!landing.has(id)) landing.set(id, { by, step });
    }
    return landing;
}

/** Commit ids in the plan reachable from the starting ids through parents that are also in the plan. */
function reachable(byId: Map<string, PlanCommit>, start: string[]): Set<string> {
    const found = new Set<string>();
    const stack = [...start];
    while (stack.length > 0) {
        const id = stack.pop()!;
        const commit = byId.get(id);
        if (!commit || found.has(id)) continue;
        found.add(id);
        stack.push(...(commit.commit.parents ?? []));
    }
    return found;
}

function mergeIds(existing: number[], added: number[]): number[] {
    const result = [...existing];
    for (const id of added) {
        if (!Number.isNaN(id) && !result.includes(id)) result.push(id);
    }
    return result;
}

async function forEachParallel<T>(items: T[], action: (item: T) => Promise<void>): Promise<void> {
    let next = 0;
    const worker = async () => {
        while (next < items.length) await action(items[next++]);
    };
    await Promise.all(Array.from({ length: Math.min(parallelRequests, items.length) }, worker));
}

function timestamp(date: Date): string {
    const pad = (n: number) => String(n).padStart(2, "0");
    return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

function delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}
