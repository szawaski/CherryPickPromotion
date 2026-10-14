import { afterEach, describe, expect, it, vi } from "vitest";
import { AdoClient, AdoError } from "../src/core/adoClient";
import { buildPlan, createPromotionPullRequest, maxCommitsPerCherryPick } from "../src/core/promotion";
import type { GitCherryPick, GitCommitRef, GitRepository } from "../src/core/types";

const repository: GitRepository = { id: "repo", name: "repo", webUrl: "https://dev.azure.com/org/project/_git/repo" };
const commit: GitCommitRef = { commitId: "a".repeat(40), comment: "change", author: { name: "Dev", email: "dev@example.com", date: "2026-01-01T00:00:00Z" }, parents: [] };
const plan = buildPlan("develop", "main", [commit], [], { byMergeCommit: new Map(), byCommit: new Map() });
const selected = new Set(plan.items.map(i => i.key));

function fakeClient(overrides: Partial<Record<keyof AdoClient, unknown>>): AdoClient {
    return {
        createCherryPick: async () => ({ cherryPickId: 1, status: "queued" }) satisfies GitCherryPick,
        createPullRequest: async () => ({ pullRequestId: 99 }),
        deleteBranch: async () => {},
        ...overrides
    } as unknown as AdoClient;
}

async function run(client: AdoClient) {
    const result = createPromotionPullRequest(client, repository, plan, selected, "title", () => {});
    const settled = result.then(
        value => ({ value }),
        error => ({ error: error as Error })
    );
    await vi.runAllTimersAsync();
    return settled;
}

describe("createPromotionPullRequest", () => {
    afterEach(() => {
        vi.useRealTimers();
    });

    it("creates the pull request once the cherry-pick completes", async () => {
        vi.useFakeTimers();
        const getCherryPick = vi.fn(async () => ({ cherryPickId: 1, status: "completed" }));

        const result = await run(fakeClient({ getCherryPick }));

        expect(result).toEqual({ value: { pullRequest: { pullRequestId: 99 }, includedKeys: plan.items.map(i => i.key), conflict: undefined, resolvedConflicts: 0 } });
    });

    it("on a conflict, opens the resolver, pushes the resolved commit and carries on", async () => {
        // Items a, b, c, d; c conflicts.
        const commits = ["d", "c", "b", "a"].map((id, i, all) => ({ ...commit, commitId: id.repeat(40), comment: `change ${id}`, parents: i < all.length - 1 ? [all[i + 1].repeat(40)] : [] }));
        const bigPlan = buildPlan("develop", "main", commits, [], { byMergeCommit: new Map(), byCommit: new Map() });
        const calls: string[] = [];
        const createCherryPick = vi.fn(async (_repo: unknown, ids: string[], onto: string, branch: string) => {
            calls.push(`cherry-pick ${ids.map(id => id[0]).join("")} onto ${onto.endsWith("main") ? "main" : onto.slice(-2)} as ${branch.slice(-2)}`);
            return ids.includes("c".repeat(40)) && ids.length > 1 && calls.length === 1
                ? { cherryPickId: 1, status: "failed", detailedStatus: { conflict: true, currentCommitId: "cccccc" } }
                : { cherryPickId: 2, status: "completed" };
        });
        const resolveConflict = vi.fn(async (request: { commit: GitCommitRef; files: unknown[] }) => {
            calls.push(`resolve ${request.commit.commitId[0]} (${request.files.length} files)`);
            return new Map([["/a.cs", { content: "resolved\n" }]]);
        });
        const client = fakeClient({
            createCherryPick,
            getBranchHead: async (_repo: unknown, branch: string) => `head of ${branch.slice(-2)}`,
            getCommitChanges: async () => [{ changeType: "edit", item: { path: "/a.cs" } }],
            getFile: async (_repo: unknown, _path: string, at: string) => ({ objectId: at, isBinary: false, content: `${at}\n` }),
            createBranch: async (_repo: unknown, branch: string, from: string) => calls.push(`branch ${branch.slice(-2)} from ${from}`),
            pushCommit: async (_repo: unknown, branch: string, _old: string, pushed: { comment: string; author: unknown; changes: unknown[] }) =>
                calls.push(`push "${pushed.comment}" to ${branch.slice(-2)} (${pushed.changes.length} changes)`)
        });

        const value = await createPromotionPullRequest(client, repository, bigPlan, new Set(bigPlan.items.map(i => i.key)), "title", () => {}, resolveConflict);

        expect(calls).toEqual([
            "cherry-pick abcd onto main as -1",
            "cherry-pick ab onto main as -2",
            "resolve c (1 files)",
            "branch -3 from head of -2",
            'push "change c" to -3 (1 changes)',
            "cherry-pick d onto -3 as -4"
        ]);
        expect(value.includedKeys).toHaveLength(4);
        expect(value.conflict).toBeUndefined();
        expect(value.resolvedConflicts).toBe(1);
    });

    it("on a skipped conflict, stops before the item as without a resolver", async () => {
        const commits = ["c", "b", "a"].map((id, i, all) => ({ ...commit, commitId: id.repeat(40), comment: `change ${id}`, parents: i < all.length - 1 ? [all[i + 1].repeat(40)] : [] }));
        const bigPlan = buildPlan("develop", "main", commits, [], { byMergeCommit: new Map(), byCommit: new Map() });
        let picks = 0;
        const createCherryPick = async () =>
            ++picks === 1 ? { cherryPickId: 1, status: "failed", detailedStatus: { conflict: true, currentCommitId: "bbbbbb" } } : { cherryPickId: 2, status: "completed" };
        const client = fakeClient({
            createCherryPick,
            getBranchHead: async () => "head",
            getCommitChanges: async () => [],
            pushCommit: vi.fn()
        });

        const value = await createPromotionPullRequest(client, repository, bigPlan, new Set(bigPlan.items.map(i => i.key)), "title", () => {}, async () => "skip");

        expect(value.includedKeys).toEqual([`commit:${"a".repeat(40)}`]);
        expect(value.conflict?.itemKey).toBe(`commit:${"b".repeat(40)}`);
        expect(value.resolvedConflicts).toBe(0);
    });

    it("stops on the first failed status check and points at the branch", async () => {
        vi.useFakeTimers();
        const getCherryPick = vi.fn(async () => {
            throw new AdoError("GET cherryPicks/1 returned 500 Internal Server Error.", 500);
        });
        const createPullRequest = vi.fn();

        const result = await run(fakeClient({ getCherryPick, createPullRequest }));

        expect("error" in result && result.error.message).toMatch(
            /Checking on cherry-pick 1 failed: GET cherryPicks\/1 returned 500 Internal Server Error\. The cherry-pick may still finish on the server; check whether the cherry-pick\/main\/\d{8}-\d{6}-1 branch was created/
        );
        expect(getCherryPick).toHaveBeenCalledTimes(1);
        expect(createPullRequest).not.toHaveBeenCalled();
    });

    it("on a conflict, promotes the items before it and reports where it stopped", async () => {
        const commits = ["d", "c", "b", "a"].map((id, i, all) => ({ ...commit, commitId: id.repeat(40), comment: `change ${id}`, parents: i < all.length - 1 ? [all[i + 1].repeat(40)] : [] }));
        const bigPlan = buildPlan("develop", "main", commits, [], { byMergeCommit: new Map(), byCommit: new Map() });
        const picked: string[][] = [];
        const createCherryPick = vi.fn(async (_repo: unknown, ids: string[]) => {
            picked.push(ids.map(id => id[0]));
            return picked.length === 1
                ? { cherryPickId: 1, status: "failed", detailedStatus: { conflict: true, currentCommitId: "cccccc" } }
                : { cherryPickId: 2, status: "completed" };
        });

        const value = await createPromotionPullRequest(fakeClient({ createCherryPick }), repository, bigPlan, new Set(bigPlan.items.map(i => i.key)), "title", () => {});

        expect(picked).toEqual([["a", "b", "c", "d"], ["a", "b"]]);
        expect(value.includedKeys).toEqual([`commit:${"a".repeat(40)}`, `commit:${"b".repeat(40)}`]);
        expect(value.conflict?.itemKey).toBe(`commit:${"c".repeat(40)}`);
    });

    it("on a conflict, keeps the pull requests that landed before it even when its commits are older", async () => {
        // f1 is written first, then PR 1 (x) lands on main, then PR 2 merges f1 with merge commit m.
        const make = (id: string, parents: string[], comment: string) => ({ ...commit, commitId: id.padEnd(40, "0"), comment, parents: parents.map(p => p.padEnd(40, "0")) });
        const source = [make("m", ["x", "f1"], "Merged PR 2"), make("x", ["base"], "PR 1 change"), make("f1", ["base"], "PR 2 change")];
        const pr = (id: number) => ({ pullRequestId: id, title: `PR ${id}`, status: "completed", sourceRefName: "refs/heads/f", targetRefName: "refs/heads/develop", creationDate: "", closedDate: "", createdBy: { displayName: "Dev" } }) as const;
        const matches = { byMergeCommit: new Map([["m".padEnd(40, "0"), [pr(2)]], ["x".padEnd(40, "0"), [pr(1)]]]), byCommit: new Map([["f1".padEnd(40, "0"), [pr(2)]]]) };
        const mergePlan = buildPlan("develop", "main", source, [], matches);
        const picked: string[][] = [];
        const createCherryPick = vi.fn(async (_repo: unknown, ids: string[]) => {
            picked.push(ids.map(id => id.replace(/0+$/, "")));
            return picked.length === 1
                ? { cherryPickId: 1, status: "failed", detailedStatus: { conflict: true, currentCommitId: "f10000" } }
                : { cherryPickId: 2, status: "completed" };
        });

        const value = await createPromotionPullRequest(fakeClient({ createCherryPick }), repository, mergePlan, new Set(["pr:1", "pr:2"]), "title", () => {});

        expect(mergePlan.items.map(i => i.key)).toEqual(["pr:1", "pr:2"]);
        expect(picked).toEqual([["x", "f1"], ["x"]]);
        expect(value.includedKeys).toEqual(["pr:1"]);
        expect(value.conflict?.itemKey).toBe("pr:2");
    });

    it("cherry-picks in fixed-size chunks, backs up to the item before a conflict and removes extra branches", async () => {
        const target = "main";
        // 300 single-commit items, oldest first. The conflict is at item 250, a few requests in.
        const ids = Array.from({ length: 300 }, (_, i) => `c${String(i).padStart(3, "0")}`.padEnd(40, "0"));
        const source = ids.map((id, i) => ({ ...commit, commitId: id, comment: `change ${i}`, parents: i > 0 ? [ids[i - 1]] : [] })).reverse();
        const bigPlan = buildPlan("develop", target, source, [], { byMergeCommit: new Map(), byCommit: new Map() });

        // Track what each branch holds, as the server would.
        const holds = new Map<string, string[]>([[target, []]]);
        const branches: string[] = [];
        const createCherryPick = vi.fn(async (_repo: unknown, commitIds: string[], onto: string, branch: string) => {
            expect(commitIds.length).toBeLessThanOrEqual(maxCommitsPerCherryPick);
            branches.push(branch);
            if (commitIds.includes(ids[250])) return { cherryPickId: 1, status: "failed", detailedStatus: { conflict: true, currentCommitId: ids[250].substring(0, 6) } };
            holds.set(branch, [...holds.get(onto)!, ...commitIds]);
            return { cherryPickId: 1, status: "completed" };
        });
        const deleteBranch = vi.fn(async () => {});
        const createPullRequest = vi.fn(async (_repo: unknown, request: { sourceBranch: string }) => ({ pullRequestId: 99, sourceBranch: request.sourceBranch }));

        const value = await createPromotionPullRequest(fakeClient({ createCherryPick, deleteBranch, createPullRequest }), repository, bigPlan, new Set(bigPlan.items.map(i => i.key)), "title", () => {});

        const finalBranch = (value.pullRequest as unknown as { sourceBranch: string }).sourceBranch;
        expect(createCherryPick.mock.calls.length).toBeGreaterThan(2);
        expect(holds.get(finalBranch)).toEqual(ids.slice(0, 250));
        expect(value.includedKeys).toHaveLength(250);
        expect(value.conflict?.itemKey).toBe(`commit:${ids[250]}`);
        expect(deleteBranch.mock.calls.map(c => (c as unknown[])[1])).toEqual(branches.filter(b => b !== finalBranch));
    });

    it("removes every branch it made when it fails before the pull request", async () => {
        vi.useFakeTimers();
        const deleteBranch = vi.fn(async () => {});
        const createCherryPick = async () => ({ cherryPickId: 1, status: "failed", detailedStatus: { status: "other" } });

        const result = await run(fakeClient({ createCherryPick, deleteBranch }));

        expect("error" in result).toBe(true);
        expect(deleteBranch).toHaveBeenCalledTimes(1);
    });

    it("keeps the branch when only creating the pull request fails", async () => {
        vi.useFakeTimers();
        const deleteBranch = vi.fn(async () => {});
        const createCherryPick = async () => ({ cherryPickId: 1, status: "completed" });
        const createPullRequest = async () => {
            throw new AdoError("POST pullrequests returned 403 Forbidden.", 403);
        };

        const result = await run(fakeClient({ createCherryPick, createPullRequest, deleteBranch }));

        expect("error" in result && result.error.message).toMatch(/The cherry-pick worked and is on cherry-pick\/main\/\d{8}-\d{6}-1, but creating the pull request failed/);
        expect(deleteBranch).not.toHaveBeenCalled();
    });

    it("fails when the first item conflicts", async () => {
        vi.useFakeTimers();
        const createCherryPick = async () => ({ cherryPickId: 1, status: "failed", detailedStatus: { conflict: true, currentCommitId: commit.commitId } });

        const result = await run(fakeClient({ createCherryPick }));

        expect("error" in result && result.error.message).toMatch(/first selected change conflicts with main at commit aaaaaaaa "change"/);
    });

    it("reports the failure reason when it isn't a conflict", async () => {
        vi.useFakeTimers();
        const createCherryPick = async () => ({ cherryPickId: 1, status: "failed", detailedStatus: { status: "createBranchPermissionRequired" } });

        const result = await run(fakeClient({ createCherryPick }));

        expect("error" in result && result.error.message).toBe("Cherry-pick failed: reason: createBranchPermissionRequired");
    });

    it("does not retry a client error", async () => {
        vi.useFakeTimers();
        const getCherryPick = vi.fn(async () => {
            throw new AdoError("401", 401);
        });

        const result = await run(fakeClient({ getCherryPick }));

        expect("error" in result).toBe(true);
        expect(getCherryPick).toHaveBeenCalledTimes(1);
    });
});
