import { describe, expect, it } from "vitest";
import type { AdoClient } from "../src/core/adoClient";
import { buildPlan, createSyncPullRequest, findSyncPoint } from "../src/core/promotion";
import type { GitChange, GitCommitRef, GitPullRequest, GitRepository, PushChange } from "../src/core/types";

const id = (name: string) => name.padEnd(40, "0");

function commit(name: string, parents: string[]): GitCommitRef {
    return { commitId: id(name), comment: `commit ${name}`, author: { name: "Dev", email: "dev@example.com", date: `2026-01-01T00:00:00Z-${name}` }, parents: parents.map(id) };
}

/** The same change cherry-picked onto the target: same author, date and message, different id. */
const copy = (c: GitCommitRef): GitCommitRef => ({ ...c, commitId: `f${c.commitId.substring(1)}`, parents: [] });

const noMatches = { byMergeCommit: new Map(), byCommit: new Map() };
const openPromotion: GitPullRequest = {
    pullRequestId: 9,
    title: "Promote",
    status: "active",
    sourceRefName: "refs/heads/cherry-pick/main/x-1",
    targetRefName: "refs/heads/main",
    creationDate: "2026-01-02T00:00:00Z",
    createdBy: { displayName: "Dev" }
};

describe("findSyncPoint", () => {
    // a <- b <- c <- d, newest first from the server
    const [a, b, c, d] = [commit("a", []), commit("b", ["a"]), commit("c", ["b"]), commit("d", ["c"])];
    const source = [d, c, b, a];

    it("is the newest commit with everything behind it on the target", () => {
        const plan = buildPlan("develop", "main", source, [copy(a), copy(b), copy(d)], noMatches);

        const { point } = findSyncPoint(plan);

        expect(point?.commit.commitId).toBe(b.commitId);
        expect(point?.commitCount).toBe(2);
    });

    it("doesn't count changes that are only in an open pull request", () => {
        const plan = buildPlan("develop", "main", source, [copy(a), copy(b)], noMatches, [{ pullRequest: openPromotion, commits: [copy(c)] }]);

        expect(findSyncPoint(plan).point?.commit.commitId).toBe(b.commitId);
    });

    it("is undefined when the oldest change isn't on the target", () => {
        const plan = buildPlan("develop", "main", source, [copy(b), copy(c)], noMatches);

        expect(findSyncPoint(plan).point).toBeUndefined();
        expect(findSyncPoint(plan).blockedBy?.commit.commit.commitId).toBe(a.commitId);
    });

    it("passes over merge commits and checks the commits they merged in", () => {
        // a <- m (merges f, branched from a) <- d
        const f = commit("e", ["a"]);
        const m = commit("m", ["a", "e"]);
        const after = commit("d", ["m"]);
        const merged = [after, m, f, a];

        expect(findSyncPoint(buildPlan("develop", "main", merged, [copy(a), copy(f)], noMatches)).point?.commit.commitId).toBe(m.commitId);
        expect(findSyncPoint(buildPlan("develop", "main", merged, [copy(a)], noMatches)).point?.commit.commitId).toBe(a.commitId);
    });
});

describe("createSyncPullRequest", () => {
    it("sets the files both branches changed to the target's versions on top of the sync point", async () => {
        const change = (changeType: string, path: string, objectId?: string, sourceServerItem?: string): GitChange => ({ changeType, item: { path, objectId }, sourceServerItem });
        const calls: string[] = [];
        let pushed: { changes: PushChange[] } | undefined;
        let request: { sourceBranch: string; targetBranch: string } | undefined;
        const client = {
            getBranchHead: async (_repo: string, branch: string) => (branch === "main" ? "head" : "?"),
            getMergeBase: async (_repo: string, a: string, b: string) => (a === id("a") && b === "head" ? "base" : "?"),
            getDiff: async (_repo: string, from: string, to: string) =>
                from === "base" && to === id("a")
                    ? // What the source changed since the common ancestor.
                      [{ changeType: "edit", item: { path: "/src", isFolder: true } }, change("edit", "/both.cs", "s1"), change("add", "/gone.cs", "s2"), change("edit", "/same.cs", "s3"), change("add", "/old.cs", "s4"), change("delete", "/readded.cs", "s5")]
                    : from === id("a") && to === "head"
                      ? // Where the target differs from the sync point.
                        [change("edit", "/both.cs", "t1"), change("delete", "/gone.cs", "s2"), change("edit", "/targetOnly.cs", "t2"), change("rename", "/new.cs", "t3", "/old.cs"), change("add", "/readded.cs", "t4")]
                      : [],
            getFileBase64: async (_repo: string, path: string, commit: string) => `${path}@${commit}`,
            createBranch: async (_repo: string, _branch: string, from: string) => void calls.push(`branch from ${from}`),
            pushCommit: async (_repo: string, _branch: string, old: string, commit: { changes: PushChange[] }) => {
                calls.push(`push onto ${old}`);
                pushed = commit;
            },
            createPullRequest: async (_repo: string, r: { sourceBranch: string; targetBranch: string }) => {
                calls.push("pull request");
                request = r;
                return { pullRequestId: 1 } as GitPullRequest;
            }
        } as unknown as AdoClient;
        const repository: GitRepository = { id: "repo", name: "repo", webUrl: "https://dev.azure.com/org/project/_git/repo" };
        const plan = buildPlan("develop", "main", [commit("a", [])], [], noMatches);

        await createSyncPullRequest(client, repository, plan, { commit: plan.items[0].commits[0].commit, commitCount: 1 }, () => {});

        expect(calls).toEqual([`branch from ${id("a")}`, `push onto ${id("a")}`, "pull request"]);
        // same.cs is the same on both, targetOnly.cs only changed on the target, and new.cs isn't one the source touched:
        // the merge takes the target's version of each by itself.
        expect(pushed?.changes).toEqual([
            { changeType: "edit", item: { path: "/both.cs" }, newContent: { content: "/both.cs@head", contentType: "base64encoded" } },
            { changeType: "delete", item: { path: "/gone.cs" } },
            { changeType: "delete", item: { path: "/old.cs" } },
            { changeType: "add", item: { path: "/readded.cs" }, newContent: { content: "/readded.cs@head", contentType: "base64encoded" } }
        ]);
        expect(request?.targetBranch).toBe("main");
        expect(request?.sourceBranch.startsWith("cherry-pick/main/sync/")).toBe(true);
    });
});
