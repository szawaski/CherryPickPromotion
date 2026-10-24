import { afterEach, describe, expect, it, vi } from "vitest";
import type { AdoClient } from "../src/core/adoClient";
import { buildPlan, createPromotionPullRequest, defaultTitle, fitLines, promotionDescription } from "../src/core/promotion";
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
    it("puts the work item's title in front", () => {
        expect(defaultTitle(plan, all)).toBe("Promote 1 PRs 2 commits develop to main");
        expect(defaultTitle(plan, all, " Release 2.3 ")).toBe("Release 2.3: Promote 1 PRs 2 commits develop to main");
        expect(defaultTitle(plan, all, "  ")).toBe("Promote 1 PRs 2 commits develop to main");
    });
});

describe("promotionDescription", () => {
    it("lists pull request titles and commit first lines in landing order", () => {
        expect(promotionDescription(plan.items)).toBe("- Feature PR\n- Fix the thing");
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

        expect(createPullRequest).toHaveBeenCalledWith("repo", expect.objectContaining({ title: "Release: Promote", description: "- Feature PR\n- Fix the thing", workItemIds: [5, 7] }));
    });
});
