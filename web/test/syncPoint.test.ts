import { describe, expect, it } from "vitest";
import { buildPlan, findSyncPoint } from "../src/core/promotion";
import type { GitCommitRef, GitPullRequest } from "../src/core/types";

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
