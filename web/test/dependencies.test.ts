import { describe, expect, it } from "vitest";
import type { AdoClient } from "../src/core/adoClient";
import { buildPlan, matchContentOnTarget, missingDependencies, withDependencies } from "../src/core/promotion";
import type { GitChange, GitCommitRef, GitRepository, PromotionPlan } from "../src/core/types";

const repository: GitRepository = { id: "repo", name: "repo", webUrl: "https://dev.azure.com/org/project/_git/repo" };
const id = (name: string) => name.padEnd(40, "0");
const key = (name: string) => `commit:${id(name)}`;

function commit(name: string, parents: string[]): GitCommitRef {
    return { commitId: id(name), comment: `commit ${name}`, author: { name: "Dev", email: "dev@example.com", date: `2026-01-01T00:00:00Z-${name}` }, parents: parents.map(id) };
}

const edit = (path: string, objectId: string): GitChange => ({ changeType: "edit", item: { path, objectId } });

async function analyze(source: GitCommitRef[], changes: Record<string, GitChange[]>, target: Record<string, string>, failing: string[] = []): Promise<PromotionPlan> {
    const plan = buildPlan("develop", "main", source, [], { byMergeCommit: new Map(), byCommit: new Map() });
    const client = {
        getCommitChanges: async (_repo: string, commitId: string) => changes[commitId[0]] ?? [],
        getBranchObjectId: async (_repo: string, path: string, branch: string) => {
            if (failing.includes(path)) throw new Error("500");
            return branch === "main" ? target[path] : "head";
        }
    } as unknown as AdoClient;
    await matchContentOnTarget(client, repository, plan, () => {});
    return plan;
}

const dependsOn = (plan: PromotionPlan, name: string) => plan.items.find(i => i.key === key(name))!.dependsOn;

describe("dependencies", () => {
    // a <- b <- c
    const source = [commit("c", ["b"]), commit("b", ["a"]), commit("a", [])];

    it("finds earlier commits to promote that changed the same file", async () => {
        const plan = await analyze(source, { a: [edit("/x.cs", "x1")], b: [edit("/x.cs", "x2")], c: [edit("/y.cs", "y1")] }, { "/x.cs": "x0", "/y.cs": "y0" });

        expect(dependsOn(plan, "a")).toBeUndefined();
        expect(dependsOn(plan, "b")).toEqual([{ key: key("a"), paths: ["/x.cs"] }]);
        expect(dependsOn(plan, "c")).toBeUndefined();
        expect(missingDependencies(plan, new Set([key("b")]))).toEqual(new Map([[key("b"), [{ key: key("a"), paths: ["/x.cs"] }]]]));
        expect(missingDependencies(plan, new Set([key("a"), key("b")])).size).toBe(0);
    });

    it("ignores a file whose earlier version the target already has", async () => {
        // The target took a's x.cs but not its w.cs, so a is still to promote, yet b applies on its own.
        const plan = await analyze(source, { a: [edit("/x.cs", "x1"), edit("/w.cs", "w1")], b: [edit("/x.cs", "x2")] }, { "/x.cs": "x1", "/w.cs": "w0" });

        expect(plan.items.find(i => i.key === key("a"))!.hasPendingCommits).toBe(true);
        expect(dependsOn(plan, "b")).toBeUndefined();
    });

    it("ignores commits on a branch the commit wasn't built on", async () => {
        // a and b both start from base, outside the plan, and m merges them.
        const branched = [commit("m", ["b", "a"]), commit("b", ["base"]), commit("a", ["base"])];
        const plan = await analyze(branched, { a: [edit("/x.cs", "x1")], b: [edit("/x.cs", "x2")] }, { "/x.cs": "x0" });

        expect(plan.items.every(i => i.dependsOn === undefined)).toBe(true);
    });

    it("counts a file it couldn't compare as a dependency", async () => {
        const plan = await analyze(source, { a: [edit("/x.cs", "x1")], b: [edit("/x.cs", "x2")] }, {}, ["/x.cs"]);

        expect(dependsOn(plan, "b")).toEqual([{ key: key("a"), paths: ["/x.cs"] }]);
    });

    it("adds dependencies of dependencies", async () => {
        const plan = await analyze(source, { a: [edit("/x.cs", "x1")], b: [edit("/x.cs", "x2"), edit("/y.cs", "y1")], c: [edit("/y.cs", "y2")] }, { "/x.cs": "x0", "/y.cs": "y0" });

        expect(dependsOn(plan, "c")).toEqual([{ key: key("b"), paths: ["/y.cs"] }]);
        expect(withDependencies(plan, new Set([key("c")]))).toEqual(new Set([key("a"), key("b"), key("c")]));
    });
});
