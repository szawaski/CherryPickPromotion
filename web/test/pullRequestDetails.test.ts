import { afterEach, describe, expect, it, vi } from "vitest";
import type { AdoClient } from "../src/core/adoClient";
import { buildPlan, cherryPickList, createPromotionPullRequest, defaultTitle, fitLines, promotionDescription } from "../src/core/promotion";
import type { GitCommitRef, GitPullRequest, GitRepository } from "../src/core/types";

const repository: GitRepository = { id: "repo", name: "repo", webUrl: "https://dev.azure.com/org/project/_git/repo" };

function commit(name: string, comment: string, parents: string[] = []): GitCommitRef {
    return { commitId: name.repeat(40), comment, author: { name: "Dev", email: "dev@example.com", date: "2026-01-01T00:00:00Z" }, parents: parents.map(p => p.repeat(40)), workItems: [{ id: "5" }] };
}

function pr(id: number, title: string): GitPullRequest {
    return { pullRequestId: id, title, status: "completed", sourceRefName: "refs/heads/feature", targetRefName: "refs/heads/develop", creationDate: "2026-01-01", createdBy: { displayName: "Dev" } };
}

// a lands in pull request 7, then b on its own.
const source = [commit("b", "Fix the thing\n\nDetails", ["a"]), commit("a", "Add the feature")];
const plan = buildPlan("develop", "main", source, [], { byMergeCommit: new Map([["a".repeat(40), [pr(7, "Feature PR")]]]), byCommit: new Map() });
const all = new Set(plan.items.map(i => i.key));

describe("defaultTitle", () => {
    it("lists the work items of several items", () => {
        expect(defaultTitle(plan, all)).toBe("[main] #5");
    });

    it("uses the one item's title, naming its work items unless the title already does", () => {
        expect(defaultTitle(plan, new Set(["pr:7"]))).toBe("[main] #5 Feature PR");
        const named = buildPlan("develop", "main", [commit("c", "#5 Fix it")], [], { byMergeCommit: new Map(), byCommit: new Map() });
        expect(defaultTitle(named, new Set(named.items.map(i => i.key)))).toBe("[main] #5 Fix it");
        const prefixOnly = buildPlan("develop", "main", [commit("c", "#55 Fix it")], [], { byMergeCommit: new Map(), byCommit: new Map() });
        expect(defaultTitle(prefixOnly, new Set(prefixOnly.items.map(i => i.key)))).toBe("[main] #5 #55 Fix it");
    });

    it("uses the linked work item when there is one", () => {
        expect(defaultTitle(plan, all, { id: 12, title: " Release 2.3 " })).toBe("[main] #12 Release 2.3");
        expect(defaultTitle(plan, all, { id: 12, title: "  " })).toBe("[main] #5");
    });

    it("names items without work items by their pull request or commit", () => {
        const source = [{ ...commit("f", "Tidy more", ["e"]), workItems: [] }, { ...commit("e", "Tidy", ["d"]), workItems: [] }, commit("d", "Linked")];
        const mixed = buildPlan("develop", "main", source, [], { byMergeCommit: new Map([["f".repeat(40), [pr(9, "Tidy PR")]]]), byCommit: new Map() });
        expect(defaultTitle(mixed, new Set(mixed.items.map(i => i.key)))).toBe("[main] #5 eeeeeeee !9");
    });

    it("stays within Azure DevOps's 400 characters", () => {
        const long = defaultTitle(plan, new Set(["pr:7"]), { id: 1, title: "word ".repeat(200) });
        expect(long.length).toBeLessThanOrEqual(400);
        expect(long.endsWith("…")).toBe(true);
    });
});

describe("promotionDescription", () => {
    it("starts each line with the pull request number or commit id, then the title, in landing order", () => {
        expect(promotionDescription(plan.items)).toBe("- !7 Feature PR\n- bbbbbbbb Fix the thing");
    });

    it("leaves the titles out when they don't fit", () => {
        expect(promotionDescription(plan.items, 30)).toBe("- !7\n- bbbbbbbb");
    });
});

describe("fitLines", () => {
    it("leaves lines that fit alone", () => {
        expect(fitLines(["- one", "- two"], 100)).toBe("- one\n- two");
    });

    it("shortens the longest lines first, keeping each one's start", () => {
        const lines = ["- short", `- ${"a".repeat(80)}`, `- ${"b".repeat(60)}`];
        const result = fitLines(lines, 100);

        expect(result.length).toBeLessThanOrEqual(100);
        const [short, a, b] = result.split("\n");
        expect(short).toBe("- short");
        expect(a.startsWith("- aaaa") && a.endsWith("…")).toBe(true);
        expect(b.startsWith("- bbbb") && b.endsWith("…")).toBe(true);
        expect(a.length).toBe(b.length);
    });

    it("replaces the lines that don't fit with a count", () => {
        const lines = Array.from({ length: 500 }, (_, i) => `- Pull request number ${i} with a long title`);
        const result = fitLines(lines, 4000);

        expect(result.length).toBeLessThanOrEqual(4000);
        const kept = result.split("\n");
        expect(kept[0].startsWith("- Pull request")).toBe(true);
        expect(kept[kept.length - 1]).toBe(`- …and ${500 - (kept.length - 1)} more`);
    });
});

describe("createPromotionPullRequest details", () => {
    afterEach(() => {
        vi.useRealTimers();
    });

    it("sends the description and adds the linked work item", async () => {
        vi.useFakeTimers();
        const createPullRequest = vi.fn(async () => ({ pullRequestId: 99 }));
        const client = {
            createCherryPick: async () => ({ cherryPickId: 1, status: "queued" }),
            getCherryPick: async () => ({ cherryPickId: 1, status: "completed" }),
            createPullRequest,
            deleteBranch: async () => {}
        } as unknown as AdoClient;

        const result = createPromotionPullRequest(client, repository, plan, all, { title: "Release: Promote", workItemId: 7 }, () => {});
        await vi.runAllTimersAsync();
        await result;

        expect(createPullRequest).toHaveBeenCalledWith("repo", expect.objectContaining({ title: "Release: Promote", description: "- !7 Feature PR\n- bbbbbbbb Fix the thing", workItemIds: [5, 7] }));
    });
});

describe("cherryPickList", () => {
    it("lists the selected pull request numbers and direct commit ids, oldest first", () => {
        expect(cherryPickList(plan, all).split("\n")).toEqual(["7", "b".repeat(40)]);
    });
});
