import { describe, expect, it } from "vitest";
import type { AdoClient } from "../src/core/adoClient";
import { buildPushChanges, countConflicts, mergeText, prepareMerge } from "../src/core/conflicts";
import type { GitChange, GitCommitRef, GitFile } from "../src/core/types";

const labels = { current: "main", incoming: "abc12345 (develop)" };

describe("mergeText", () => {
    it("merges changes to different lines", () => {
        const result = mergeText("a\nb\nc\n", "A\nb\nc\n", "a\nb\nC\n", labels);
        expect(result).toEqual({ text: "A\nb\nC\n", conflicts: 0 });
    });

    it("marks changes to the same lines", () => {
        const result = mergeText("a\nb\nc\n", "a\nB1\nc\n", "a\nB2\nc\n", labels);
        expect(result.conflicts).toBe(1);
        expect(result.text).toBe("a\n<<<<<<< main\nB1\n=======\nB2\n>>>>>>> abc12345 (develop)\nc\n");
        expect(countConflicts(result.text)).toBe(1);
    });

    it("keeps Windows line endings and a missing final newline", () => {
        const result = mergeText("a\r\nb", "a\r\nB1", "a\r\nB2", labels);
        expect(result.text).toBe("a\r\n<<<<<<< main\r\nB1\r\n=======\r\nB2\r\n>>>>>>> abc12345 (develop)\r\n");
    });

    it("doesn't count the same change on both sides as a conflict", () => {
        expect(mergeText("a\n", "b\n", "b\n", labels)).toEqual({ text: "b\n", conflicts: 0 });
    });
});

/** A repository with files at three commits: the commit's parent, the commit, and the target head. */
function fakeRepo(files: Record<"parent" | "commit" | "head", Record<string, string>>, changes: GitChange[], binary: string[] = []): AdoClient {
    const at = (commitId: string) => (commitId === "parent" ? files.parent : commitId === "commit" ? files.commit : files.head);
    return {
        getCommitChanges: async () => changes,
        getFile: async (_repo: string, path: string, commitId: string): Promise<GitFile | undefined> => {
            const content = at(commitId)[path];
            if (content === undefined) return undefined;
            const isBinary = binary.includes(path);
            return { objectId: `blob:${content}`, isBinary, content: isBinary ? undefined : content };
        },
        getFileBase64: async (_repo: string, path: string, commitId: string) => `base64:${at(commitId)[path]}`
    } as unknown as AdoClient;
}

const commit: GitCommitRef = { commitId: "commit", comment: "change", author: { name: "Dev", email: "dev@example.com", date: "2026-01-01T00:00:00Z" }, parents: ["parent"] };
const edit = (path: string): GitChange => ({ changeType: "edit", item: { path } });

describe("prepareMerge", () => {
    it("merges files that only one side changed and leaves the rest alone", async () => {
        const client = fakeRepo(
            {
                parent: { "/a.cs": "1\n2\n3\n", "/b.cs": "x\n" },
                commit: { "/a.cs": "1\n2\n3!\n", "/b.cs": "y\n", "/new.cs": "new\n" },
                head: { "/a.cs": "1!\n2\n3\n", "/b.cs": "x\n" }
            },
            [edit("/a.cs"), edit("/b.cs"), { changeType: "add", item: { path: "/new.cs" } }]
        );

        const prepared = await prepareMerge(client, "repo", commit, "head", labels);
        const changes = await buildPushChanges(client, "repo", prepared, new Map());

        expect(prepared.conflicts).toEqual([]);
        expect(changes).toEqual([
            { changeType: "edit", item: { path: "/a.cs" }, newContent: { content: "1!\n2\n3!\n", contentType: "rawtext" } },
            { changeType: "edit", item: { path: "/b.cs" }, newContent: { content: "base64:y\n", contentType: "base64encoded" } },
            { changeType: "add", item: { path: "/new.cs" }, newContent: { content: "base64:new\n", contentType: "base64encoded" } }
        ]);
    });

    it("reports overlapping edits, deletes on either side and binary files, and applies the chosen resolutions", async () => {
        const client = fakeRepo(
            {
                parent: { "/same.cs": "a\nb\n", "/gone.cs": "old\n", "/kept.cs": "old\n", "/logo.png": "p1" },
                commit: { "/same.cs": "a\nB2\n", "/kept.cs": "changed in source\n", "/logo.png": "p2" },
                head: { "/same.cs": "a\nB1\n", "/gone.cs": "changed on target\n", "/logo.png": "p3" }
            },
            [edit("/same.cs"), { changeType: "delete", item: { path: "/gone.cs" } }, edit("/kept.cs"), edit("/logo.png")],
            ["/logo.png"]
        );

        const prepared = await prepareMerge(client, "repo", commit, "head", labels);

        expect(prepared.conflicts.map(c => [c.path, c.kind])).toEqual([
            ["/same.cs", "content"],
            ["/gone.cs", "deletedInSource"],
            ["/kept.cs", "deletedOnTarget"],
            ["/logo.png", "binary"]
        ]);
        expect(countConflicts(prepared.conflicts[0].merged!)).toBe(1);

        const changes = await buildPushChanges(client, "repo", prepared, new Map([
            ["/same.cs", { content: "a\nB1 and B2\n" }],
            ["/gone.cs", { keep: "incoming" as const }],
            ["/kept.cs", { keep: "incoming" as const }],
            ["/logo.png", { keep: "current" as const }]
        ]));
        expect(changes).toEqual([
            { changeType: "edit", item: { path: "/same.cs" }, newContent: { content: "a\nB1 and B2\n", contentType: "rawtext" } },
            { changeType: "delete", item: { path: "/gone.cs" } },
            { changeType: "add", item: { path: "/kept.cs" }, newContent: { content: "base64:changed in source\n", contentType: "base64encoded" } }
        ]);
    });

    it("follows a rename, merging the target's edits of the old path into the new one", async () => {
        const client = fakeRepo(
            {
                parent: { "/old.cs": "1\n2\n3\n" },
                commit: { "/new.cs": "1\n2\n3!\n" },
                head: { "/old.cs": "1!\n2\n3\n" }
            },
            [{ changeType: "rename, edit", item: { path: "/new.cs" }, sourceServerItem: "/old.cs" }]
        );

        const prepared = await prepareMerge(client, "repo", commit, "head", labels);
        const changes = await buildPushChanges(client, "repo", prepared, new Map());

        expect(changes).toEqual([
            { changeType: "delete", item: { path: "/old.cs" } },
            { changeType: "add", item: { path: "/new.cs" }, newContent: { content: "1!\n2\n3!\n", contentType: "rawtext" } }
        ]);
    });

    it("requires a resolution for every conflict", async () => {
        const client = fakeRepo({ parent: { "/a": "a\n" }, commit: { "/a": "b\n" }, head: { "/a": "c\n" } }, [edit("/a")]);
        const prepared = await prepareMerge(client, "repo", commit, "head", labels);

        await expect(buildPushChanges(client, "repo", prepared, new Map())).rejects.toThrow("/a has no resolution.");
    });
});
