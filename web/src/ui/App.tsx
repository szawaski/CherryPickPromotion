import { lazy, Suspense, useEffect, useMemo, useState, type ReactElement } from "react";
import { AdoClient, shortBranchName } from "../core/adoClient";
import {
    analyzePromotion,
    commitUrl,
    createPromotionPullRequest,
    createSyncPullRequest,
    setAutoComplete,
    findSyncPoint,
    defaultTitle,
    firstLine,
    pullRequestUrl,
    selectCommits,
    selectWorkItemIds,
    workItemUrl,
    PromotionAborted,
    type ConflictAnswer,
    type ConflictRequest,
    type ResolveConflict
} from "../core/promotion";
import type { GitPullRequest, GitRepository, PlanCommit, PlanItem, PromotionPlan } from "../core/types";
import { groupByWorkItem, groupItems, loadWorkItems, workItemMatches, type WorkItemGroup, type WorkItemMap } from "../core/workItems";
import "./styles.css";

// Monaco is a few megabytes, so the editor loads the first time a conflict needs it.
const ConflictEditor = lazy(() => import("./ConflictEditor"));

interface PendingConflict {
    request: ConflictRequest;
    resolve(answer: ConflictAnswer): void;
}

interface Props {
    client: AdoClient;
}

interface Status {
    kind: "info" | "error" | "success";
    message: string;
    link?: string;
}

export function App({ client }: Props) {
    const storageKey = `cherry-pick-promotion:${client.connection.project}`;
    const saved = useMemo(() => loadSettings(storageKey), [storageKey]);

    const [repositories, setRepositories] = useState<GitRepository[]>([]);
    const [repositoryId, setRepositoryId] = useState<string>("");
    const [branches, setBranches] = useState<string[]>([]);
    const [branchesVersion, setBranchesVersion] = useState(0);
    const [sourceBranch, setSourceBranch] = useState(saved.sourceBranch ?? "");
    const [targetBranch, setTargetBranch] = useState(saved.targetBranch ?? "");
    const [plan, setPlan] = useState<PromotionPlan>();
    const [selected, setSelected] = useState<Set<string>>(new Set());
    const [expanded, setExpanded] = useState<Set<string>>(new Set());
    const [showPromoted, setShowPromoted] = useState(false);
    const [groupByWorkItems, setGroupByWorkItems] = useState(saved.groupByWorkItem ?? false);
    const [autoComplete, setAutoCompleteOption] = useState(saved.autoComplete ?? false);
    const [workItems, setWorkItems] = useState<WorkItemMap>(new Map());
    // Work item groups start collapsed.
    const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set());
    const [filter, setFilter] = useState("");
    const [conflictKey, setConflictKey] = useState<string>();
    const [pendingConflict, setPendingConflict] = useState<PendingConflict>();
    // Undefined until edited, so the title follows the selection.
    const [customTitle, setCustomTitle] = useState<string>();
    const [busy, setBusy] = useState(false);
    const [status, setStatus] = useState<Status>();

    const repository = repositories.find(r => r.id === repositoryId);

    useEffect(() => {
        run(async () => {
            const result = await client.getRepositories();
            setRepositories(result);
            const initial = result.find(r => r.id === saved.repositoryId) ?? result[0];
            if (initial) setRepositoryId(initial.id);
        });
    }, [client]);

    useEffect(() => {
        if (!repositoryId) return;
        let current = true;
        run(async () => {
            const result = (await client.getBranches(repositoryId)).map(b => shortBranchName(b.name));
            if (!current) return;
            setBranches(result);
            setSourceBranch(branch => (result.includes(branch) ? branch : ""));
            setTargetBranch(branch => (result.includes(branch) ? branch : ""));
        });
        return () => {
            current = false;
        };
    }, [client, repositoryId, branchesVersion]);

    // Work items load the first time they're grouped by, along with their parents.
    const missingWorkItems = groupByWorkItems && plan ? [...new Set(plan.items.flatMap(i => i.workItemIds))].filter(id => !workItems.has(id)) : [];
    useEffect(() => {
        if (missingWorkItems.length === 0) return;
        let current = true;
        run(async () => {
            progress(`Loading ${missingWorkItems.length} work items and their parents…`);
            const result = await loadWorkItems(client, missingWorkItems, workItems);
            if (!current) return;
            setWorkItems(result);
            setStatus(undefined);
        });
        return () => {
            current = false;
        };
    }, [client, missingWorkItems.join(",")]);

    function changeGrouping(value: boolean) {
        setGroupByWorkItems(value);
        saveSettings(storageKey, { ...loadSettings(storageKey), groupByWorkItem: value });
    }

    function changeAutoComplete(value: boolean) {
        setAutoCompleteOption(value);
        saveSettings(storageKey, { ...loadSettings(storageKey), autoComplete: value });
    }

    /** Sets auto-complete when it's checked. The pull request stands either way, so a failure is only noted. */
    async function applyAutoComplete(pullRequest: GitPullRequest, sync: boolean): Promise<string> {
        if (!autoComplete || !repository) return "";
        progress("Setting auto-complete…");
        try {
            await setAutoComplete(client, repository, pullRequest, sync);
            return " Auto-complete is set.";
        } catch (error) {
            return ` Setting auto-complete failed: ${error instanceof Error ? error.message : String(error)}`;
        }
    }

    function changeRepository(id: string) {
        setPlan(undefined);
        setBranches([]);
        setRepositoryId(id);
    }

    async function run(action: () => Promise<void>) {
        setBusy(true);
        setStatus(undefined);
        try {
            await action();
        } catch (error) {
            setStatus({ kind: "error", message: error instanceof Error ? error.message : String(error) });
        } finally {
            setBusy(false);
        }
    }

    const progress = (message: string) => setStatus({ kind: "info", message });

    function findChanges() {
        if (!repository) return;
        if (!sourceBranch || !targetBranch) {
            setStatus({ kind: "error", message: "Pick a source and a target branch." });
            return;
        }
        if (sourceBranch === targetBranch) {
            setStatus({ kind: "error", message: "The source and target branches must be different." });
            return;
        }
        saveSettings(storageKey, { repositoryId, sourceBranch, targetBranch, groupByWorkItem: groupByWorkItems, autoComplete });
        run(async () => {
            const result = await analyzePromotion(client, repository, sourceBranch, targetBranch, progress);
            setPlan(result);
            setConflictKey(undefined);
            setSelected(new Set());
            setExpanded(new Set());
            setCustomTitle(undefined);
            const pending = result.items.filter(i => i.hasPendingCommits).length;
            setStatus({ kind: "info", message: pending === 0 ? `Nothing to promote from ${sourceBranch} to ${targetBranch}.` : `${pending} items to promote.` });
        });
    }

    function createPullRequest() {
        if (!repository || !plan) return;
        run(async () => {
            const requested = plan.items.filter(i => selected.has(i.key) && i.hasPendingCommits).length;
            // Each conflict opens the editor; the cherry-pick waits until it's resolved or skipped.
            const resolveConflict: ResolveConflict = request => new Promise(resolve => setPendingConflict({ request, resolve }));
            let result;
            try {
                result = await createPromotionPullRequest(client, repository, plan, selected, title.trim() || defaultTitle(plan, selected), progress, resolveConflict);
            } catch (error) {
                if (!(error instanceof PromotionAborted)) throw error;
                setStatus({ kind: "info", message: "Aborted. No pull request was created, and the branches made along the way were removed." });
                return;
            }
            const id = result.pullRequest.pullRequestId;
            const included = new Set(result.includedKeys);
            const resolvedNote = (result.resolvedConflicts > 0 ? ` Resolved ${result.resolvedConflicts} conflicting commits.` : "") + (await applyAutoComplete(result.pullRequest, false));

            setPlan({ ...plan, items: plan.items.map(i => (included.has(i.key) ? { ...i, promotedIn: id, hasPendingCommits: false } : i)) });
            setSelected(new Set([...selected].filter(key => !included.has(key))));
            setConflictKey(result.conflict?.itemKey);

            const link = pullRequestUrl(repository, id);
            if (result.conflict) {
                const commit = result.conflict.commit;
                setStatus({
                    kind: "error",
                    message: `Created pull request !${id} with ${included.size} of ${requested} items.${resolvedNote} Stopped at a conflict in commit ${commit.commitId.substring(0, 8)} "${firstLine(commit.comment)}"; that item and the ones after it are still selected.`,
                    link
                });
            } else {
                setStatus({ kind: "success", message: `Created pull request !${id} with all ${included.size} items.${resolvedNote}`, link });
            }
        });
    }

    const syncSearch = useMemo(() => (plan ? findSyncPoint(plan) : {}), [plan]);
    const syncPoint = syncSearch.point;
    const syncBlocker = syncSearch.blockedBy;

    function createSyncPull() {
        if (!repository || !plan || !syncPoint) return;
        run(async () => {
            const pullRequest = await createSyncPullRequest(client, repository, plan, syncPoint, progress);
            const autoCompleteNote = await applyAutoComplete(pullRequest, true);
            setPlan({ ...plan, openSyncPullRequest: pullRequest });
            setStatus({
                kind: "success",
                message: `Created rebase PR !${pullRequest.pullRequestId}. Complete it with Merge (no fast-forward), not squash, so the histories join.${autoCompleteNote}`,
                link: pullRequestUrl(repository, pullRequest.pullRequestId)
            });
        });
    }

    // A filter searches everything, including already promoted items.
    const query = filter.trim().toLowerCase().replace(/^[!#]/, "");
    // Newest first for display; cherry-picks still apply oldest first.
    // Items in an open promotion and open pull requests into the source stay visible, though they can't be selected.
    const shown = (i: PlanItem) => i.hasPendingCommits || i.promotedIn !== undefined || i.openPullRequest === true;
    // Loaded work items count too, parents included, so searching for a feature finds what's under it.
    const visibleItems = plan ? plan.items.filter(i => (query ? matchesFilter(i, query) || workItemMatches(i, workItems, query) : showPromoted || shown(i))).reverse() : [];
    const hiddenCount = plan ? plan.items.filter(i => !shown(i)).length : 0;
    const selectedCommits = plan ? selectCommits(plan, selected).length : 0;
    const selectedWorkItems = plan ? selectWorkItemIds(plan, selected).length : 0;
    const title = customTitle ?? (plan ? defaultTitle(plan, selected) : "");
    const selectable = visibleItems.filter(i => i.hasPendingCommits);
    const allSelected = selectable.length > 0 && selectable.every(i => selected.has(i.key));

    const groups = groupByWorkItems && missingWorkItems.length === 0 ? groupByWorkItem(visibleItems, workItems) : undefined;

    function selectAll(keys: string[], value: boolean) {
        const next = new Set(selected);
        for (const key of keys) {
            if (value) next.add(key);
            else next.delete(key);
        }
        setSelected(next);
    }

    const renderItem = (item: PlanItem) => (
        <ItemRow
            key={item.key}
            item={item}
            repository={repository!}
            checked={selected.has(item.key)}
            expanded={expanded.has(item.key)}
            conflict={item.key === conflictKey}
            disabled={busy || !item.hasPendingCommits}
            onCheck={() => toggle(selected, item.key, setSelected)}
            onExpand={() => toggle(expanded, item.key, setExpanded)}
        />
    );

    function toggle(set: Set<string>, key: string, update: (value: Set<string>) => void) {
        const next = new Set(set);
        if (next.has(key)) next.delete(key);
        else next.add(key);
        update(next);
    }

    const statusBox = status ? (
        <div className={`cpp-status cpp-status-${status.kind}`} role={status.kind === "error" ? "alert" : "status"}>
            {busy && status.kind === "info" && <span className="cpp-spinner" />}
            {status.message}{" "}
            {status.link && (
                <a href={status.link} target="_blank" rel="noopener noreferrer">
                    Open pull request
                </a>
            )}
        </div>
    ) : busy ? (
        <div className="cpp-status" role="status">
            <span className="cpp-spinner" />
            Loading…
        </div>
    ) : undefined;

    return (
        <div className="cpp">
            {pendingConflict && (
                <Suspense fallback={<div className="cpp-conflict"><div className="cpp-status"><span className="cpp-spinner" />Loading the conflict editor…</div></div>}>
                    <ConflictEditor
                        key={pendingConflict.request.commit.commitId}
                        request={pendingConflict.request}
                        onDone={answer => {
                            setPendingConflict(undefined);
                            pendingConflict.resolve(answer);
                        }}
                    />
                </Suspense>
            )}
            <section className="cpp-bar">
                <label>
                    Repository
                    <select value={repositoryId} disabled={busy} onChange={e => changeRepository(e.target.value)}>
                        {repositories.map(r => (
                            <option key={r.id} value={r.id}>{r.name}</option>
                        ))}
                    </select>
                </label>
                <label>
                    Source branch
                    <BranchSelect branches={branches} value={sourceBranch} disabled={busy} onChange={setSourceBranch} />
                </label>
                <label>
                    Target branch
                    <BranchSelect branches={branches} value={targetBranch} disabled={busy} onChange={setTargetBranch} />
                </label>
                <button className="cpp-icon" title="Reload branches" aria-label="Reload branches" disabled={busy || !repository} onClick={() => setBranchesVersion(v => v + 1)}>
                    <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
                        <path d="M13.5 8a5.5 5.5 0 1 1-1.6-3.9" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
                        <path d="M12.5 1.5v3h-3" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                </button>
                <button className="cpp-primary" disabled={busy || !repository} onClick={findChanges}>
                    Find changes
                </button>
            </section>

            {!plan && statusBox}

            {plan && repository && (
                <>
                    {plan.openSyncPullRequest ? (
                        <div className="cpp-status">
                            Rebase PR{" "}
                            <a href={pullRequestUrl(repository, plan.openSyncPullRequest.pullRequestId)} target="_blank" rel="noopener noreferrer">
                                !{plan.openSyncPullRequest.pullRequestId}
                            </a>{" "}
                            is open. Complete it with Merge (no fast-forward) and the commits before it drop off this list.
                        </div>
                    ) : (
                        (syncPoint || syncBlocker) && (
                            <div className="cpp-status cpp-sync">
                                <span>
                                    {syncPoint ? (
                                        <>
                                            Everything on {plan.sourceBranch} up to{" "}
                                            <a className="cpp-sha" href={commitUrl(repository, syncPoint.commit.commitId)} target="_blank" rel="noopener noreferrer">
                                                {syncPoint.commit.commitId.substring(0, 8)}
                                            </a>{" "}
                                            ({formatDate(syncPoint.commit.committer?.date ?? syncPoint.commit.author.date)}) is already on {plan.targetBranch}. A rebase PR merging it into {plan.targetBranch} takes{" "}
                                            {syncPoint.commitCount} commits off this list once completed.
                                        </>
                                    ) : (
                                        <>No rebase PR possible yet: the oldest change on {plan.sourceBranch} isn't on {plan.targetBranch}.</>
                                    )}
                                    {syncBlocker && (
                                        <>
                                            {" "}
                                            {syncPoint ? "It can move further once" : "Promote"}{" "}
                                            <button className="cpp-link" title="Find it in the list" onClick={() => setFilter(syncBlocker.item?.pullRequest ? `!${syncBlocker.item.pullRequest.pullRequestId}` : syncBlocker.commit.commit.commitId.substring(0, 8))}>
                                                {syncBlocker.item?.pullRequest ? `!${syncBlocker.item.pullRequest.pullRequestId}` : syncBlocker.commit.commit.commitId.substring(0, 8)} "
                                                {syncBlocker.item?.pullRequest ? syncBlocker.item.pullRequest.title : firstLine(syncBlocker.commit.commit.comment)}"
                                            </button>{" "}
                                            {syncPoint ? "is on the target" : "first"}
                                            {syncBlocker.commit.inOpenPullRequest !== undefined ? ` (it's in open !${syncBlocker.commit.inOpenPullRequest}, which needs completing)` : ""}.
                                        </>
                                    )}
                                </span>
                                {syncPoint && (
                                    <button disabled={busy} onClick={createSyncPull}>
                                        Create rebase PR into {plan.targetBranch}
                                    </button>
                                )}
                            </div>
                        )
                    )}
                    <section className="cpp-toolbar">
                        <label className="cpp-check">
                            <input
                                type="checkbox"
                                checked={allSelected}
                                disabled={busy || selectable.length === 0}
                                onChange={() => setSelected(allSelected ? new Set() : new Set(selectable.map(i => i.key)))}
                            />
                            Select all
                        </label>
                        <span className="cpp-search">
                            <input value={filter} placeholder="Search PRs, commits, people" onChange={e => setFilter(e.target.value)} onKeyDown={e => e.key === "Escape" && setFilter("")} />
                            {filter && (
                                <button className="cpp-search-clear" title="Clear search" aria-label="Clear search" onClick={() => setFilter("")}>
                                    ×
                                </button>
                            )}
                        </span>
                        {hiddenCount > 0 && (
                            <label className="cpp-check">
                                <input type="checkbox" checked={showPromoted} disabled={query.length > 0} onChange={() => setShowPromoted(!showPromoted)} />
                                Show {hiddenCount} already promoted
                            </label>
                        )}
                        <label className="cpp-check">
                            <input type="checkbox" checked={groupByWorkItems} disabled={busy} onChange={() => changeGrouping(!groupByWorkItems)} />
                            Group by work item
                        </label>
                    </section>

                    {query.length > 0 && visibleItems.length === 0 && (
                        <div className="cpp-status">
                            Nothing on {plan.sourceBranch} that isn't on {plan.targetBranch} matches "{filter.trim()}".
                        </div>
                    )}

                    <ol className="cpp-list">
                        {groups
                            ? groups.map(group => (
                                  <WorkItemGroupRow
                                      key={group.key}
                                      group={group}
                                      repository={repository}
                                      selected={selected}
                                      expandedGroups={expandedGroups}
                                      expandAll={query.length > 0}
                                      conflictKey={conflictKey}
                                      disabled={busy}
                                      onSelect={selectAll}
                                      onExpand={key => toggle(expandedGroups, key, setExpandedGroups)}
                                      renderItem={renderItem}
                                  />
                              ))
                            : visibleItems.map(renderItem)}
                    </ol>

                    {/* Once there is a list, status lives in the sticky footer so it shows next to the button. */}
                    <section className="cpp-footer">
                        {statusBox}
                        <div className="cpp-footer-row">
                            <label className="cpp-title">
                                Pull request title
                                <input value={title} disabled={busy} onChange={e => setCustomTitle(e.target.value)} />
                            </label>
                            <label className="cpp-check" title="Complete the pull request on its own once its policies pass, and delete its branch">
                                <input type="checkbox" checked={autoComplete} disabled={busy} onChange={() => changeAutoComplete(!autoComplete)} />
                                Auto-complete
                            </label>
                            <span className="cpp-summary">
                                {selected.size} items · {selectedCommits} commits · {selectedWorkItems} work items
                            </span>
                            <button className="cpp-primary" disabled={busy || selectedCommits === 0} onClick={createPullRequest}>
                                Cherry-pick into {plan.targetBranch}
                            </button>
                        </div>
                    </section>
                </>
            )}
        </div>
    );
}

function BranchSelect({ branches, value, disabled, onChange }: { branches: string[]; value: string; disabled: boolean; onChange(value: string): void }) {
    return (
        <select value={value} disabled={disabled} onChange={e => onChange(e.target.value)}>
            <option value="">Select a branch</option>
            {branches.map(b => (
                <option key={b} value={b}>{b}</option>
            ))}
        </select>
    );
}

interface WorkItemGroupRowProps {
    group: WorkItemGroup;
    repository: GitRepository;
    selected: ReadonlySet<string>;
    expandedGroups: ReadonlySet<string>;
    /** While searching, every group is open so the matches show. */
    expandAll: boolean;
    /** The item a promotion stopped at, if any. */
    conflictKey?: string;
    disabled: boolean;
    onSelect(keys: string[], value: boolean): void;
    onExpand(key: string): void;
    renderItem(item: PlanItem): ReactElement;
}

function WorkItemGroupRow(props: WorkItemGroupRowProps) {
    const { group, repository, selected, expandedGroups, expandAll, conflictKey, disabled, onSelect, onExpand, renderItem } = props;
    const all = groupItems(group);
    const selectable = all.filter(i => i.hasPendingCommits).map(i => i.key);
    const count = selectable.filter(key => selected.has(key)).length;
    const isCollapsed = !expandAll && !expandedGroups.has(group.key);
    const workItem = group.workItem;
    // Roll up where the items went: in an open promotion, or already on the target.
    const inPromotion = all.filter(i => i.promotedIn !== undefined);
    const promotedIn = [...new Set(inPromotion.map(i => i.promotedIn!))].sort((a, b) => a - b);
    const onTarget = all.filter(i => i.promotedIn === undefined && !i.hasPendingCommits && !i.openPullRequest).length;
    const done = inPromotion.length + onTarget;
    // And what's holding the rest back, so the reason shows without opening the group.
    const openPullRequests = all.filter(i => i.openPullRequest).length;
    const toPromote = selectable.length;
    const hasConflict = conflictKey !== undefined && all.some(i => i.key === conflictKey);
    return (
        <li className="cpp-group">
            <div className="cpp-row cpp-group-row">
                <button className="cpp-link cpp-twisty" aria-expanded={!isCollapsed} aria-label={isCollapsed ? "Expand" : "Collapse"} disabled={expandAll} onClick={() => onExpand(group.key)}>
                    {isCollapsed ? "▸" : "▾"}
                </button>
                <input
                    type="checkbox"
                    checked={selectable.length > 0 && count === selectable.length}
                    ref={el => {
                        if (el) el.indeterminate = count > 0 && count < selectable.length;
                    }}
                    disabled={disabled || selectable.length === 0}
                    onChange={() => onSelect(selectable, count < selectable.length)}
                />
                <span className="cpp-name">
                    {group.id === undefined ? (
                        "No work item"
                    ) : (
                        <>
                            {workItem && <span className="cpp-wi-type">{workItem.type}</span>}
                            <a href={workItemUrl(repository, group.id)} target="_blank" rel="noopener noreferrer">
                                #{group.id}
                            </a>{" "}
                            {workItem ? workItem.title : <span className="cpp-meta">not found or no access</span>}
                            {workItem?.state && <span className="cpp-tag">{workItem.state}</span>}
                        </>
                    )}
                </span>
                {done > 0 && (
                    <span className="cpp-tag cpp-tag-done">
                        ✓ {done < all.length ? `${done} of ${all.length} ` : ""}
                        {promotedIn.length > 0 ? "in " : "on target"}
                        {promotedIn.map((id, i) => (
                            <span key={id}>
                                {i > 0 && ", "}
                                <a href={pullRequestUrl(repository, id)} target="_blank" rel="noopener noreferrer">
                                    !{id}
                                </a>
                            </span>
                        ))}
                        {promotedIn.length > 0 && onTarget > 0 ? " or on target" : ""}
                    </span>
                )}
                {openPullRequests > 0 && (
                    <span className="cpp-tag cpp-tag-open">
                        {openPullRequests < all.length ? `${openPullRequests} of ${all.length} ` : ""}
                        {openPullRequests === 1 ? "open PR" : "open PRs"}, not merged into source yet
                    </span>
                )}
                {hasConflict && <span className="cpp-tag cpp-tag-conflict">conflicts</span>}
                {toPromote > 0 && toPromote < all.length && <span className="cpp-tag">{toPromote} to promote</span>}
                <span className="cpp-meta">
                    {all.length} items{count > 0 ? ` · ${count} selected` : ""}
                </span>
            </div>
            {!isCollapsed && (
                <ol className="cpp-list cpp-group-children">
                    {group.children.map(child => (
                        <WorkItemGroupRow key={child.key} {...props} group={child} />
                    ))}
                    {group.items.map(renderItem)}
                </ol>
            )}
        </li>
    );
}

interface ItemRowProps {
    item: PlanItem;
    repository: GitRepository;
    checked: boolean;
    expanded: boolean;
    conflict: boolean;
    disabled: boolean;
    onCheck(): void;
    onExpand(): void;
}

function ItemRow({ item, repository, checked, expanded, conflict, disabled, onCheck, onExpand }: ItemRowProps) {
    const pullRequest = item.pullRequest;
    const last = item.commits[item.commits.length - 1]?.commit;
    const dimmed = !item.hasPendingCommits && item.promotedIn === undefined;
    // Merge commits and commits already on the target are listed but not cherry-picked.
    const toPick = item.commits.filter(c => !c.isMerge && !c.promotedReason).length;
    return (
        <li className={`cpp-item${dimmed ? " cpp-promoted" : ""}`}>
            <div className="cpp-row">
                <input type="checkbox" checked={checked} disabled={disabled} onChange={onCheck} />
                {pullRequest ? <PullRequestSummary item={item} pullRequest={pullRequest} repository={repository} /> : <CommitSummary commit={item.commits[0]} repository={repository} hideReason={item.promotedIn !== undefined} />}
                {item.promotedIn !== undefined && (
                    <span className="cpp-tag cpp-tag-done">
                        ✓ in{" "}
                        <a href={pullRequestUrl(repository, item.promotedIn)} target="_blank" rel="noopener noreferrer">
                            !{item.promotedIn}
                        </a>
                    </span>
                )}
                {conflict && <span className="cpp-tag cpp-tag-conflict">conflicts</span>}
                <span className="cpp-meta">
                    {pullRequest ? pullRequest.createdBy.displayName : last!.author.name} · {formatDate(pullRequest ? (pullRequest.closedDate ?? pullRequest.creationDate) : last!.author.date)}
                </span>
                <span className="cpp-workitems">
                    {item.workItemIds.map(id => (
                        <a key={id} href={workItemUrl(repository, id)} target="_blank" rel="noopener noreferrer">
                            #{id}
                        </a>
                    ))}
                </span>
                {pullRequest && item.commits.length > 0 && (
                    <button className="cpp-link" onClick={onExpand}>
                        {expanded ? "Hide" : "Show"} {item.commits.length} commits{toPick > 0 && toPick < item.commits.length ? ` (${toPick} to cherry-pick)` : ""}
                    </button>
                )}
            </div>
            {pullRequest && expanded && (
                <ul className="cpp-commits">
                    {[...item.commits].reverse().map(c => (
                        <li key={c.commit.commitId}>
                            <CommitSummary commit={c} repository={repository} />
                            <span className="cpp-meta">
                                {c.commit.author.name} · {formatDate(c.commit.author.date)}
                            </span>
                        </li>
                    ))}
                </ul>
            )}
        </li>
    );
}

function PullRequestSummary({ item, pullRequest, repository }: { item: PlanItem; pullRequest: GitPullRequest; repository: GitRepository }) {
    const reason = item.hasPendingCommits || item.promotedIn !== undefined ? undefined : item.commits.find(c => c.promotedReason)?.promotedReason;
    return (
        <span className="cpp-name">
            <a href={pullRequestUrl(repository, pullRequest.pullRequestId)} target="_blank" rel="noopener noreferrer">
                !{pullRequest.pullRequestId}
            </a>{" "}
            {pullRequest.title}
            {item.openPullRequest && <span className="cpp-tag cpp-tag-open">{pullRequest.isDraft ? "draft" : "open"} PR, not merged into source yet</span>}
            {reason && <span className="cpp-tag">already on target: {reason}</span>}
        </span>
    );
}

function CommitSummary({ commit, repository, hideReason }: { commit: PlanCommit; repository: GitRepository; hideReason?: boolean }) {
    const reason = hideReason ? undefined : commit.promotedReason;
    return (
        <span className="cpp-name">
            <a className="cpp-sha" href={commitUrl(repository, commit.commit.commitId)} target="_blank" rel="noopener noreferrer">
                {commit.commit.commitId.substring(0, 8)}
            </a>{" "}
            {firstLine(commit.commit.comment)}
            {commit.isMerge && <span className="cpp-tag">merge, skipped</span>}
            {reason && <span className="cpp-tag">{reason.startsWith("in open PR") ? reason : `already on target: ${reason}`}</span>}
        </span>
    );
}

function matchesFilter(item: PlanItem, query: string): boolean {
    const pullRequest = item.pullRequest;
    if (
        pullRequest &&
        (String(pullRequest.pullRequestId) === query || pullRequest.title.toLowerCase().includes(query) || pullRequest.createdBy.displayName.toLowerCase().includes(query))
    )
        return true;
    if (item.workItemIds.some(id => String(id) === query)) return true;
    return item.commits.some(
        c =>
            c.commit.commitId.startsWith(query) ||
            c.commit.comment.toLowerCase().includes(query) ||
            c.commit.author.name.toLowerCase().includes(query) ||
            c.commit.author.email.toLowerCase().includes(query)
    );
}

function formatDate(value: string): string {
    return new Date(value).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

interface Settings {
    repositoryId?: string;
    sourceBranch?: string;
    targetBranch?: string;
    groupByWorkItem?: boolean;
    autoComplete?: boolean;
}

function loadSettings(key: string): Settings {
    try {
        return JSON.parse(localStorage.getItem(key) ?? "{}") as Settings;
    } catch {
        return {};
    }
}

function saveSettings(key: string, settings: Settings) {
    try {
        localStorage.setItem(key, JSON.stringify(settings));
    } catch {
        // storage is unavailable in some hosts; settings are a convenience
    }
}
