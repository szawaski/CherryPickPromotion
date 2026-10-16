import { describe, expect, it } from "vitest";
import type { AdoClient } from "../src/core/adoClient";
import { buildPlan, matchContentOnTarget } from "../src/core/promotion";
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
