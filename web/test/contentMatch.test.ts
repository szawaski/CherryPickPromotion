import { describe, expect, it } from "vitest";
import type { AdoClient } from "../src/core/adoClient";
import { buildPlan, matchContentOnTarget, matchMessageOnTarget, matchReferencesOnTarget, referencedPullRequests, type ReferenceCache } from "../src/core/promotion";
import type { GitPullRequest } from "../src/core/types";
import type { GitChange, GitCommitRef, GitRepository } from "../src/core/types";

const repository: GitRepository = { id: "repo", name: "repo", webUrl: "https://dev.azure.com/org/project/_git/repo" };
const id = (name: string) => name.padEnd(40, "0");

function commit(name: string, parents: string[]): GitCommitRef {
    return { commitId: id(name), comment: `commit ${name}`, author: { name: "Dev", email: "dev@example.com", date: `2026-01-01T00:00:00Z-${name}` }, parents: parents.map(id) };
}

const edit = (path: string, objectId: string): GitChange => ({ changeType: "edit", item: { path, objectId } });
const remove = (path: string): GitChange => ({ changeType: "delete", item: { path, objectId: "old" } });

function fakeClient(changes: Record<string, GitChange[]>, branches: Record<string, Record<string, string>>): AdoClient {
    return {
        getCommitChanges: async (_repo: string, commitId: string) => changes[commitId[0]] ?? [],
        getBranchObjectId: async (_repo: string, path: string, branch: string) => branches[branch][path]
    } as unknown as AdoClient;
}

describe("matchContentOnTarget", () => {
    // a <- b <- c <- d, none of them traceable to the target by history or message.
    const source = [commit("d", ["c"]), commit("c", ["b"]), commit("b", ["a"]), commit("a", [])];
    const changes = {
        a: [edit("/x.cs", "x1")],
        b: [edit("/x.cs", "x2")],
        c: [edit("/y.cs", "y1")],
        d: [remove("/z.cs")]
    };

    it("treats commits whose files already match the target as promoted", async () => {
        const plan = buildPlan("develop", "main", source, [], { byMergeCommit: new Map(), byCommit: new Map() });
        // The target took x and the delete of z, squashed into one commit, but not y.
        const client = fakeClient(changes, {
            main: { "/x.cs": "x2", "/y.cs": "y0" },
            develop: { "/x.cs": "x2", "/y.cs": "y1" }
        });

        await matchContentOnTarget(client, repository, plan, () => {});

        const reason = (name: string) => plan.items.flatMap(i => i.commits).find(c => c.commit.commitId === id(name))!.promotedReason;
        expect(reason("a")).toBe("same file contents on main");
        expect(reason("b")).toBe("same file contents on main");
        expect(reason("c")).toBeUndefined();
        expect(reason("d")).toBe("same file contents on main");
        expect(plan.items.filter(i => i.hasPendingCommits).map(i => i.key)).toEqual([`commit:${id("c")}`]);
    });

    it("leaves commits to promote when a lookup fails", async () => {
        const plan = buildPlan("develop", "main", source, [], { byMergeCommit: new Map(), byCommit: new Map() });
        const client = {
            getCommitChanges: async (_repo: string, commitId: string) => changes[commitId[0] as keyof typeof changes],
            getBranchObjectId: async () => {
                throw new Error("500");
            }
        } as unknown as AdoClient;

        await matchContentOnTarget(client, repository, plan, () => {});

        expect(plan.items.every(i => i.hasPendingCommits)).toBe(true);
    });
});

describe("matchMessageOnTarget", () => {
    it("marks a commit recommitted on the target with the same message and files", async () => {
        const squash = { ...commit("a", []), comment: "Merged PR 7: #12 Fix the export\n\nDetails" };
        const other = { ...commit("b", ["a"]), comment: "Fix the export" };
        const lookalike = { ...commit("c", ["b"]), comment: "Tidy" };
        const plan = buildPlan("develop", "main", [lookalike, other, squash], [], { byMergeCommit: new Map(), byCommit: new Map() });
        // On the target: a hand recommit of a (new author and date), one of b touching different files, and c's message.
        const target = [
            { ...commit("x", []), author: { name: "Other", email: "other@example.com", date: "2026-02-01T00:00:00Z" }, comment: "#12 Fix the export" },
            { ...commit("y", []), comment: "fix the export" },
            { ...commit("z", []), comment: "[release/main] Tidy" }
        ];
        const files: Record<string, GitChange[]> = {
            a: [edit("/x.cs", "1"), edit("/y.cs", "2")],
            x: [edit("/y.cs", "9"), edit("/x.cs", "8")],
            b: [edit("/x.cs", "3")],
            y: [edit("/z.cs", "4")],
            c: [edit("/t.cs", "5")]
        };
        const client = {
            getCommitChanges: async (_repo: string, commitId: string) => {
                if (commitId[0] === "z") throw new Error("500");
                return files[commitId[0]] ?? [];
            }
        } as unknown as AdoClient;

        await matchMessageOnTarget(client, repository, plan, target, () => {});

        const reason = (name: string) => plan.items.flatMap(i => i.commits).find(c => c.commit.commitId === id(name))!.promotedReason;
        expect(reason("a")).toBe(`same message and files as ${id("x").substring(0, 8)} on main`);
        expect(reason("b")).toBeUndefined();
        expect(reason("c")).toBeUndefined();
    });
});

describe("referencedPullRequests", () => {
    it("finds the pull requests release messages name", () => {
        expect(referencedPullRequests("#134301 Add AI Agent sync resolution (cherry-pick of PR 57066 to release/main)")).toEqual([57066]);
        expect(referencedPullRequests("Merged PR 59755: [release/main] #136888 future pay rate Info names its date (PRs 59347, 59350, 59666)")).toEqual([59755, 59347, 59350, 59666]);
        expect(referencedPullRequests("Merged PR 58107: Merged PR 57613: [Payroll] Wage Determination")).toEqual([58107, 57613]);
        expect(referencedPullRequests("Merge pull request 61413 from work/138269 into main")).toEqual([61413]);
        expect(referencedPullRequests("Fixes the export from !57173")).toEqual([57173]);
        expect(referencedPullRequests("## Summary\n\n```diff\n release/main\n+ 58061  Hub Imported Hours entity\n+ 58260  Payroll connector\n```")).toEqual([58061, 58260]);
    });

    it("ignores numbers that aren't named as pull requests", () => {
        expect(referencedPullRequests("#134572 Certified Payroll over 12345 rows, a 62000 limit and work/138269")).toEqual([]);
        expect(referencedPullRequests("Assert.Equal(62.00m, total);\n    38080 cents")).toEqual([]);
    });
});

describe("matchReferencesOnTarget", () => {
    const pullRequest = (id: number, title: string): GitPullRequest => ({ pullRequestId: id, title, status: "completed", sourceRefName: "refs/heads/f", targetRefName: "refs/heads/develop", creationDate: "2026-01-01", createdBy: { displayName: "Dev" } });

    it("marks pull requests the target names or repeats the title of, reading long messages once", async () => {
        const source = [commit("c", ["b"]), commit("b", ["a"]), commit("a", [])];
        const plan = buildPlan("develop", "main", source, [], {
            byMergeCommit: new Map([
                [id("a"), [pullRequest(50101, "Named in a long message")]],
                [id("b"), [pullRequest(50102, "[Payroll] Log and skip Check webhooks with an unknown topic")]],
                [id("c"), [pullRequest(50103, "Not on the target")]]
            ]),
            byCommit: new Map()
        });
        const target = [
            { ...commit("x", []), comment: "Merged PR 900: [release/main] a bundle whose list is past the cut", commentTruncated: true },
            { ...commit("y", []), comment: "Merged PR 901: [Payroll] Log and skip Check webhooks with an unknown topic" }
        ];
        const getCommit = async (_repo: string, commitId: string) => ({ ...target[0], comment: `${target[0].comment}\n\n+ 50101  the change` , commitId });
        const reads: string[] = [];
        const client = { getCommit: async (repo: string, commitId: string) => (reads.push(commitId), getCommit(repo, commitId)) } as unknown as AdoClient;
        const stored = new Map<string, number[]>();
        const cache: ReferenceCache = { get: c => stored.get(c), set: (c, ids) => void stored.set(c, ids) };

        await matchReferencesOnTarget(client, repository, plan, target, () => {}, cache);
        const reason = (key: string) => plan.items.find(i => i.key === key)!.commits[0].promotedReason;
        expect(reason("pr:50101")).toBe(`named by ${id("x").substring(0, 8)} on main`);
        expect(reason("pr:50102")).toBe(`same title as ${id("y").substring(0, 8)} on main`);
        expect(reason("pr:50103")).toBeUndefined();
        expect(plan.items.filter(i => i.hasPendingCommits).map(i => i.key)).toEqual(["pr:50103"]);

        // The second time the cut-off message comes from the cache.
        await matchReferencesOnTarget(client, repository, buildPlan("develop", "main", source, [], { byMergeCommit: new Map([[id("c"), [pullRequest(50103, "Not on the target")]]]), byCommit: new Map() }), target, () => {}, cache);
        expect(reads).toEqual([id("x")]);
    });
});
