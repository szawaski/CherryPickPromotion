import { AdoClient, fullBranchName, shortBranchName } from "./adoClient";
import { buildPushChanges, prepareMerge, type ConflictFile, type ConflictLabels, type FileResolution } from "./conflicts";
import type {
    GitCommitRef,
    GitPullRequest,
    GitRepository,
    PlanCommit,
    PlanItem,
    Promotion,
    PromotionPlan,
    PromotionResult,
    PullRequestMatches
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
    await matchContentOnTarget(client, repository, plan, progress);

    const pullRequestItems = plan.items.filter(i => i.pullRequest);
    progress(`Loading work items for ${pullRequestItems.length} pull requests…`);
    await forEachParallel(pullRequestItems, async item => {
        const workItems = await client.getPullRequestWorkItems(repository.id, item.pullRequest!.pullRequestId);
        item.workItemIds = mergeIds(item.workItemIds, workItems.map(w => Number(w.id)));
    });

    return plan;
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

    // Completed promotions go last so they win over open ones holding the same change.
    const promotedBy = new Map<string, GitPullRequest>();
    for (const promotion of [...promotions].sort((a, b) => Number(a.pullRequest.status === "completed") - Number(b.pullRequest.status === "completed"))) {
        for (const commit of promotion.commits) promotedBy.set(equivalenceKey(commit), promotion.pullRequest);
    }

    const promotedReason = (commit: GitCommitRef): string | undefined => {
        const intoTarget = [...completed(matches.byMergeCommit.get(commit.commitId)), ...completed(matches.byCommit.get(commit.commitId))].find(pr => pr.targetRefName === targetRef);
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
    // brings the commits it merged in with it. Newest first so nested merges pass the reason down.
    const byId = new Map(planned.map(p => [p.planCommit.commit.commitId, p.planCommit]));
    for (let i = planned.length - 1; i >= 0; i--) {
        const merge = planned[i].planCommit;
        if (!merge.isMerge || !merge.promotedReason) continue;
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

    // An item lands when its last commit does, which for a pull request is its merge.
    const landed = (item: PlanItem) => item.commits[item.commits.length - 1].order;
    const items = [...itemsByKey.values()].sort((a, b) => landed(a) - landed(b));

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

export function selectWorkItemIds(plan: PromotionPlan, selectedKeys: ReadonlySet<string>): number[] {
    return plan.items
        .filter(i => selectedKeys.has(i.key))
        .reduce<number[]>((ids, i) => mergeIds(ids, i.workItemIds), [])
        .sort((a, b) => a - b);
}

export function defaultTitle(plan: PromotionPlan, selectedKeys: ReadonlySet<string>): string {
    const items = plan.items.filter(i => selectedKeys.has(i.key) && i.hasPendingCommits);
    const pullRequests = items.filter(i => i.pullRequest).length;
    const commits = selectCommits(plan, selectedKeys).length;
    return `Promote ${pullRequests} PRs ${commits} commits ${plan.sourceBranch} to ${plan.targetBranch}`;
}

/**
 * Cherry-picks the selected items onto a new branch and opens one pull request into the target.
 *
 * The commits go in chunks of maxCommitsPerCherryPick, each onto the branch the previous chunk made. On a conflict,
 * resolveConflict (when given) gets to resolve it, and the resolved commit is pushed before carrying on. If it's skipped,
 * or there is no resolveConflict, only the items that landed before the conflicting one are kept, so the pull request
 * holds everything up to it and no item is promoted halfway.
 */
export async function createPromotionPullRequest(
    client: AdoClient,
    repository: GitRepository,
    plan: PromotionPlan,
    selectedKeys: ReadonlySet<string>,
    title: string,
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
                title,
                workItemIds: selectWorkItemIds(plan, included)
            })
        );
        return { pullRequest, includedKeys: [...included], conflict, resolvedConflicts };
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
    const parents = new Set(commits.flatMap(c => c.commit.parents ?? []));
    const head = commits.filter(c => !parents.has(c.commit.commitId)).sort((a, b) => b.order - a.order)[0];
    if (!head) return {};

    // The mainline, oldest first.
    const mainline: PlanCommit[] = [];
    for (let c: PlanCommit | undefined = head; c; c = byId.get(c.commit.parents?.[0] ?? "")) mainline.unshift(c);

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
 * Opens a pull request that merges the source, as of the sync point, into the target. It changes few or no files, but
 * once it's completed as a merge the target has the source's history up to there.
 */
export async function createSyncPullRequest(client: AdoClient, repository: GitRepository, plan: PromotionPlan, point: SyncPoint, progress: Progress): Promise<GitPullRequest> {
    const branch = `${syncBranchPrefix(plan.targetBranch)}${timestamp(new Date())}`;
    const sha = point.commit.commitId.substring(0, 8);
    progress(`Creating ${branch} at ${sha}…`);
    await client.createBranch(repository.id, branch, point.commit.commitId);
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
                "Expect few or no file changes; any that show up are differences between the cherry-picks and the originals, such as conflict resolutions, and are worth a look."
            ].join("\n"),
            workItemIds: [],
            mergeStrategy: "noFastForward"
        })
    );
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
    const answer = await resolveConflict({ commit: full, item, files: prepared.conflicts, autoMerged: prepared.merged.map(m => m.path), labels });
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
 */
function choosePullRequest(commitId: string, sourceRef: string, targetRef: string, matches: PullRequestMatches): GitPullRequest | undefined {
    const notIntoTarget = (pr: GitPullRequest) => pr.targetRefName !== targetRef;
    const merged = completed(matches.byMergeCommit.get(commitId)).filter(notIntoTarget);
    const containing = completed(matches.byCommit.get(commitId)).filter(notIntoTarget);
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
