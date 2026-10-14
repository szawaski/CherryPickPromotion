import { describe, expect, it } from "vitest";
import { buildPlan, selectCommits, selectWorkItemIds } from "../src/core/promotion";
import type { GitCommitRef, GitPullRequest, PullRequestMatches } from "../src/core/types";

function commit(id: string, parents: string[], comment = `commit ${id}`, workItems: number[] = []): GitCommitRef {
    return {
        commitId: id.padEnd(40, "0"),
        comment,
        author: { name: "Dev", email: "Dev@Example.com", date: `2026-01-01T00:00:${id.length.toString().padStart(2, "0")}Z-${id}` },
        parents: parents.map(p => p.padEnd(40, "0")),
        workItems: workItems.map(w => ({ id: String(w) }))
    };
}

function pr(id: number, targetBranch: string, closedDate = "2026-01-02T00:00:00Z", status: GitPullRequest["status"] = "completed"): GitPullRequest {
    return {
        pullRequestId: id,
        title: `PR ${id}`,
        status,
        sourceRefName: `refs/heads/feature/${id}`,
        targetRefName: `refs/heads/${targetBranch}`,
        creationDate: "2026-01-01T00:00:00Z",
        closedDate,
        createdBy: { displayName: "Dev" }
    };
}

function matches(merge: Record<string, GitPullRequest[]> = {}, contains: Record<string, GitPullRequest[]> = {}): PullRequestMatches {
    const toMap = (record: Record<string, GitPullRequest[]>) => new Map(Object.entries(record).map(([k, v]) => [k.padEnd(40, "0"), v]));
    return { byMergeCommit: toMap(merge), byCommit: toMap(contains) };
}

const keys = (...values: string[]) => new Set(values);

describe("buildPlan", () => {
    it("groups commits by pull request and keeps orphans in landing order", () => {
        // a <- b (orphan) <- c (squash PR 1) <- d (orphan), newest first from the server
        const source = [commit("d", ["c"]), commit("c", ["b"]), commit("b", ["a"]), commit("a", [])];
        const plan = buildPlan("develop", "main", source, [], matches({ c: [pr(1, "develop")] }));

        expect(plan.items.map(i => i.key)).toEqual([`commit:${"a".padEnd(40, "0")}`, `commit:${"b".padEnd(40, "0")}`, "pr:1", `commit:${"d".padEnd(40, "0")}`]);
        expect(plan.sourceBranch).toBe("develop");
        expect(plan.targetBranch).toBe("main");
    });

    it("puts the commits of a merge-commit pull request under it and skips the merge commit", () => {
        // base <- f1 <- f2 ; base <- m (merge of f2), PR 7 merged into develop with merge commit m
        const source = [commit("m", ["base", "f2"]), commit("f2", ["f1"]), commit("f1", ["base"])];
        const plan = buildPlan("develop", "main", source, [], matches({ m: [pr(7, "develop")] }, { f1: [pr(7, "develop")], f2: [pr(7, "develop")] }));

        expect(plan.items).toHaveLength(1);
        const item = plan.items[0];
        expect(item.pullRequest?.pullRequestId).toBe(7);
        expect(item.commits.map(c => c.commit.commitId[0])).toEqual(["f", "f", "m"]);
        expect(item.commits.map(c => c.isMerge)).toEqual([false, false, true]);
        expect(selectCommits(plan, keys("pr:7")).map(c => c.commit.commitId.substring(0, 2))).toEqual(["f1", "f2"]);
    });

    it("orders parents before children even when the server order disagrees", () => {
        const source = [commit("x", ["y"]), commit("z", []), commit("y", ["z"])];
        const plan = buildPlan("develop", "main", source, [], matches());

        expect(plan.items.map(i => i.commits[0].commit.commitId[0])).toEqual(["z", "y", "x"]);
    });

    it("prefers the pull request into the source branch over one into another branch", () => {
        const source = [commit("a", [])];
        const intoFeature = pr(1, "feature/x", "2026-01-01T00:00:00Z");
        const intoDevelop = pr(2, "develop", "2026-01-05T00:00:00Z");
        const plan = buildPlan("refs/heads/develop", "main", source, [], matches({}, { a: [intoFeature, intoDevelop] }));

        expect(plan.items[0].pullRequest?.pullRequestId).toBe(2);
    });

    it("ignores pull requests that were not completed", () => {
        const source = [commit("a", [])];
        const plan = buildPlan("develop", "main", source, [], matches({}, { a: [pr(3, "develop", undefined, "abandoned"), pr(4, "develop", undefined, "active")] }));

        expect(plan.items[0].pullRequest).toBeUndefined();
    });

    it("marks commits already cherry-picked to the target", () => {
        const picked = commit("a", []);
        const copy = { ...commit("a2", ["t"]), author: { ...picked.author, email: "dev@example.com" }, comment: `${picked.comment}\n\nmore` };
        const source = [commit("b", ["a"]), picked];
        const plan = buildPlan("develop", "main", source, [copy], matches());

        expect(plan.items.map(i => i.hasPendingCommits)).toEqual([false, true]);
        expect(selectCommits(plan, new Set(plan.items.map(i => i.key))).map(c => c.commit.commitId[0])).toEqual(["b"]);
    });

    it("treats commits in a completed pull request into the target as promoted", () => {
        // a reached develop through PR 1 and was also squash-merged into main through PR 2
        const source = [commit("b", ["a"]), commit("a", [])];
        const plan = buildPlan("develop", "main", source, [], matches({}, { a: [pr(1, "develop"), pr(2, "main")], b: [pr(3, "main")] }));

        expect(plan.items.map(i => i.key)).toEqual(["pr:1", `commit:${"b".padEnd(40, "0")}`]);
        expect(plan.items.map(i => i.commits[0].promotedReason)).toEqual(["in !2 into main", "in !3 into main"]);
    });

    it("treats the commits under a merge commit already on the target as promoted", () => {
        // PR 7 merged f into develop with merge commit m; m alone was cherry-picked to main
        const merge = commit("m", ["base", "f"], "Merged PR 7: change");
        const copy = { ...commit("c", ["t"]), author: merge.author, comment: merge.comment };
        const source = [merge, commit("f", ["base"], "change"), commit("base", [])];
        const plan = buildPlan("develop", "main", source, [copy], matches({ m: [pr(7, "develop")] }, { f: [pr(7, "develop")] }));

        const item = plan.items.find(i => i.key === "pr:7")!;
        expect(item.hasPendingCommits).toBe(false);
        expect(item.commits.map(c => c.promotedReason)).toEqual([
            `merged in by m0000000, which is same author, date and message as c0000000 on main`,
            `same author, date and message as c0000000 on main`
        ]);
        expect(plan.items.find(i => i.key !== "pr:7")!.hasPendingCommits).toBe(true);
    });

    // A promotion's commits are cherry-picks: new ids, same author, date and message.
    const picked = (original: GitCommitRef, id: string): GitCommitRef => ({ ...original, commitId: id.padEnd(40, "0"), parents: [] });

    it("treats commits cherry-picked by an earlier promotion as promoted, even after a squash merge", () => {
        const source = [commit("c", ["b"]), commit("b", ["a"]), commit("a", [])];
        // The promotion was squash-merged, so its cherry-picks never reached the target; only the pull request has them.
        const promotion = { pullRequest: pr(50, "main"), commits: [picked(source[2], "p1"), picked(source[1], "p2")] };
        const plan = buildPlan("develop", "main", source, [], matches({ a: [pr(1, "develop")] }), [promotion]);

        expect(plan.items.map(i => i.hasPendingCommits)).toEqual([false, false, true]);
        expect(plan.items.map(i => i.commits[0].promotedReason)).toEqual(["promoted in !50", "promoted in !50", undefined]);
    });

    it("marks items in an open promotion and lets a completed promotion win", () => {
        const source = [commit("b", ["a"]), commit("a", [])];
        const open = { pullRequest: pr(50, "main", undefined, "active"), commits: [picked(source[1], "p1"), picked(source[0], "p2")] };
        const done = { pullRequest: pr(51, "main"), commits: [picked(source[1], "p3")] };
        const plan = buildPlan("develop", "main", source, [], matches({ a: [pr(1, "develop")], b: [pr(2, "develop")] }), [done, open]);

        expect(plan.items.map(i => i.promotedIn)).toEqual([undefined, 50]);
        expect(plan.items.map(i => i.commits[0].promotedReason)).toEqual(["promoted in !51", "in open PR !50 into main"]);
        expect(plan.items.every(i => !i.hasPendingCommits)).toBe(true);
    });

    it("marks items in an open pull request straight from the source into the target", () => {
        const source = [commit("c", ["b"]), commit("b", ["a"]), commit("a", [])];
        // Not made by this tool: the source branch itself, holding the original commits.
        const direct = { pullRequest: { ...pr(60, "main", undefined, "active"), sourceRefName: "refs/heads/develop" }, commits: [source[2], source[1]] };
        const plan = buildPlan("develop", "main", source, [], matches({ a: [pr(1, "develop")] }), [direct]);

        expect(plan.items.map(i => i.promotedIn)).toEqual([60, 60, undefined]);
        expect(plan.items.map(i => i.hasPendingCommits)).toEqual([false, false, true]);
        expect(plan.items[0].commits[0].promotedReason).toBe("in open PR !60 into main");
    });

    it("adds open pull requests into the source as unselectable items at the end", () => {
        const source = [commit("a", [])];
        const landed = pr(1, "develop");
        const open = [{ ...pr(9, "develop", undefined, "active"), creationDate: "2026-02-02T00:00:00Z" }, { ...pr(8, "develop", undefined, "active"), creationDate: "2026-02-01T00:00:00Z" }];
        const plan = buildPlan("develop", "main", source, [], matches({ a: [landed] }), undefined, open);

        expect(plan.items.map(i => i.key)).toEqual(["pr:1", "pr:8", "pr:9"]);
        expect(plan.items.map(i => i.openPullRequest ?? false)).toEqual([false, true, true]);
        expect(plan.items.slice(1).every(i => !i.hasPendingCommits && i.commits.length === 0)).toBe(true);
    });

    it("collects work items from pull requests and commits without duplicates", () => {
        const source = [commit("b", ["a"], "b", [5, 3]), commit("a", [], "a", [3])];
        const plan = buildPlan("develop", "main", source, [], matches({ b: [pr(1, "develop")] }, { a: [pr(1, "develop")] }));
        plan.items[0].workItemIds.push(9);

        expect(selectWorkItemIds(plan, keys("pr:1"))).toEqual([3, 5, 9]);
    });
});
