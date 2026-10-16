import type {
    GitChange,
    GitCherryPick,
    GitFile,
    GitUserDate,
    PushChange,
    GitCommitRef,
    GitPullRequest,
    GitRef,
    GitRepository,
    PullRequestMatches,
    ResourceRef,
    WorkItem
} from "./types";

export interface AdoConnection {
    /** Collection URL ending with "/", e.g. https://dev.azure.com/org/ */
    baseUrl: string;
    project: string;
    getHeaders(): Promise<Record<string, string>>;
}

export class AdoError extends Error {
    constructor(message: string, readonly status: number) {
        super(message);
    }
}

type Query = Record<string, string | number | boolean | undefined>;

const commitPageSize = 1000;
const pullRequestQueryChunk = 100;
const workItemBatchSize = 200;

export type MergeStrategy = "noFastForward" | "squash" | "rebase" | "rebaseMerge";

export class AdoClient {
    constructor(readonly connection: AdoConnection) {}

    async getRepositories(): Promise<GitRepository[]> {
        const result = await this.send<{ value: GitRepository[] }>("GET", this.gitUrl("repositories"));
        return result.value.sort((a, b) => a.name.localeCompare(b.name));
    }

    async getBranches(repositoryId: string): Promise<GitRef[]> {
        const branches: GitRef[] = [];
        let continuationToken: string | undefined;
        do {
            const response = await this.fetch("GET", this.gitUrl(`repositories/${repositoryId}/refs`, { filter: "heads/", $top: 1000, continuationToken }));
            const page = (await response.json()) as { value: GitRef[] };
            branches.push(...page.value);
            continuationToken = response.headers.get("x-ms-continuationtoken") ?? undefined;
        } while (continuationToken);
        return branches.sort((a, b) => a.name.localeCompare(b.name));
    }

    /** Commits reachable from includeBranch but not from excludeBranch, newest first (git log exclude..include). */
    async getCommitsBetween(repositoryId: string, includeBranch: string, excludeBranch: string, includeWorkItems: boolean): Promise<GitCommitRef[]> {
        const commits: GitCommitRef[] = [];
        // itemVersion is the base and compareVersion is the side whose extra commits come back.
        const body = {
            itemVersion: { versionType: "branch", version: shortBranchName(excludeBranch) },
            compareVersion: { versionType: "branch", version: shortBranchName(includeBranch) },
            includeWorkItems
        };
        for (;;) {
            const url = this.gitUrl(`repositories/${repositoryId}/commitsbatch`, { $skip: commits.length, $top: commitPageSize });
            const page = await this.send<{ value: GitCommitRef[] }>("POST", url, body);
            if (page.value.length === 0) break;
            commits.push(...page.value);
        }
        return commits;
    }

    getCommit(repositoryId: string, commitId: string): Promise<GitCommitRef> {
        return this.send("GET", this.gitUrl(`repositories/${repositoryId}/commits/${commitId}`));
    }

    async queryPullRequestsByCommits(repositoryId: string, commitIds: string[]): Promise<PullRequestMatches> {
        const matches: PullRequestMatches = { byMergeCommit: new Map(), byCommit: new Map() };
        for (let i = 0; i < commitIds.length; i += pullRequestQueryChunk) {
            const items = commitIds.slice(i, i + pullRequestQueryChunk);
            const result = await this.send<{ results: Record<string, GitPullRequest[]>[] }>(
                "POST",
                this.gitUrl(`repositories/${repositoryId}/pullrequestquery`),
                { queries: [{ type: "lastMergeCommit", items }, { type: "commit", items }] }
            );
            addMatches(matches.byMergeCommit, result.results[0]);
            addMatches(matches.byCommit, result.results[1]);
        }
        return matches;
    }

    async getPullRequests(repositoryId: string, targetBranch: string, status: "active" | "completed"): Promise<GitPullRequest[]> {
        const pullRequests: GitPullRequest[] = [];
        for (;;) {
            const url = this.gitUrl(`repositories/${repositoryId}/pullrequests`, {
                "searchCriteria.status": status,
                "searchCriteria.targetRefName": fullBranchName(targetBranch),
                $skip: pullRequests.length,
                $top: 1000
            });
            const page = await this.send<{ value: GitPullRequest[] }>("GET", url);
            if (page.value.length === 0) break;
            pullRequests.push(...page.value);
        }
        return pullRequests;
    }

    async getPullRequestCommits(repositoryId: string, pullRequestId: number): Promise<GitCommitRef[]> {
        const commits: GitCommitRef[] = [];
        let continuationToken: string | undefined;
        do {
            const response = await this.fetch("GET", this.gitUrl(`repositories/${repositoryId}/pullRequests/${pullRequestId}/commits`, { $top: 1000, continuationToken }));
            const page = (await response.json()) as { value: GitCommitRef[] };
            commits.push(...page.value);
            continuationToken = response.headers.get("x-ms-continuationtoken") ?? undefined;
        } while (continuationToken);
        return commits;
    }

    async getPullRequestWorkItems(repositoryId: string, pullRequestId: number): Promise<ResourceRef[]> {
        const result = await this.send<{ value: ResourceRef[] }>("GET", this.gitUrl(`repositories/${repositoryId}/pullRequests/${pullRequestId}/workitems`));
        return result.value;
    }

    createCherryPick(repositoryId: string, commitIds: string[], ontoBranch: string, generatedBranch: string): Promise<GitCherryPick> {
        return this.send("POST", this.gitUrl(`repositories/${repositoryId}/cherryPicks`), {
            generatedRefName: fullBranchName(generatedBranch),
            ontoRefName: fullBranchName(ontoBranch),
            repository: { id: repositoryId },
            source: { commitList: commitIds.map(commitId => ({ commitId })) }
        });
    }

    getCherryPick(repositoryId: string, cherryPickId: number): Promise<GitCherryPick> {
        return this.send("GET", this.gitUrl(`repositories/${repositoryId}/cherryPicks/${cherryPickId}`));
    }

    async deleteBranch(repositoryId: string, branch: string): Promise<void> {
        const name = fullBranchName(branch);
        // The filter is a prefix match, so look for the exact name.
        const refs = await this.send<{ value: GitRef[] }>("GET", this.gitUrl(`repositories/${repositoryId}/refs`, { filter: name.substring("refs/".length) }));
        const ref = refs.value.find(r => r.name === name);
        if (!ref) return;
        await this.send("POST", this.gitUrl(`repositories/${repositoryId}/refs`), [{ name, oldObjectId: ref.objectId, newObjectId: "0".repeat(40) }]);
    }

    async getBranchHead(repositoryId: string, branch: string): Promise<string> {
        const name = fullBranchName(branch);
        const refs = await this.send<{ value: GitRef[] }>("GET", this.gitUrl(`repositories/${repositoryId}/refs`, { filter: name.substring("refs/".length) }));
        const ref = refs.value.find(r => r.name === name);
        if (!ref) throw new Error(`Branch ${shortBranchName(name)} was not found.`);
        return ref.objectId;
    }

    async createBranch(repositoryId: string, branch: string, objectId: string): Promise<void> {
        const result = await this.send<{ value: { success: boolean; customMessage?: string; updateStatus?: string }[] }>(
            "POST",
            this.gitUrl(`repositories/${repositoryId}/refs`),
            [{ name: fullBranchName(branch), oldObjectId: "0".repeat(40), newObjectId: objectId }]
        );
        const update = result.value[0];
        if (!update?.success) throw new Error(`Creating branch ${shortBranchName(branch)} failed: ${update?.customMessage ?? update?.updateStatus ?? "no details returned"}`);
    }

    /** The files a commit changes compared with its first parent. */
    async getCommitChanges(repositoryId: string, commitId: string): Promise<GitChange[]> {
        const changes: GitChange[] = [];
        for (;;) {
            const page = await this.send<{ changes: GitChange[] }>("GET", this.gitUrl(`repositories/${repositoryId}/commits/${commitId}/changes`, { skip: changes.length, top: 1000 }));
            changes.push(...page.changes);
            if (page.changes.length < 1000) return changes;
        }
    }

    /** A file at a commit, or undefined when it doesn't exist there. Content is left out for binary files. */
    async getFile(repositoryId: string, path: string, commitId: string): Promise<GitFile | undefined> {
        try {
            const item = await this.send<{ objectId: string; content?: string; contentMetadata?: { isBinary?: boolean } }>(
                "GET",
                this.gitUrl(`repositories/${repositoryId}/items`, {
                    path,
                    "versionDescriptor.version": commitId,
                    "versionDescriptor.versionType": "commit",
                    includeContent: true,
                    includeContentMetadata: true,
                    $format: "json"
                })
            );
            const isBinary = item.contentMetadata?.isBinary === true;
            return { objectId: item.objectId, isBinary, content: isBinary ? undefined : item.content ?? "" };
        } catch (error) {
            if (error instanceof AdoError && error.status === 404) return undefined;
            throw error;
        }
    }

    /** The blob id of a file at the head of a branch, or undefined when the file isn't there. */
    async getBranchObjectId(repositoryId: string, path: string, branch: string): Promise<string | undefined> {
        try {
            const item = await this.send<{ objectId: string }>(
                "GET",
                this.gitUrl(`repositories/${repositoryId}/items`, {
                    path,
                    "versionDescriptor.version": shortBranchName(branch),
                    "versionDescriptor.versionType": "branch",
                    includeContent: false,
                    $format: "json"
                })
            );
            return item.objectId;
        } catch (error) {
            if (error instanceof AdoError && error.status === 404) return undefined;
            throw error;
        }
    }

    /** A file's bytes at a commit, base64-encoded for a push. */
    async getFileBase64(repositoryId: string, path: string, commitId: string): Promise<string> {
        const response = await this.fetch(
            "GET",
            this.gitUrl(`repositories/${repositoryId}/items`, { path, "versionDescriptor.version": commitId, "versionDescriptor.versionType": "commit", $format: "octetStream" }),
            undefined,
            "application/octet-stream"
        );
        const bytes = new Uint8Array(await response.arrayBuffer());
        let binary = "";
        for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
        return btoa(binary);
    }

    /** Pushes one commit onto an existing branch whose head is oldObjectId. */
    async pushCommit(repositoryId: string, branch: string, oldObjectId: string, commit: { comment: string; author: GitUserDate; changes: PushChange[] }): Promise<void> {
        await this.send("POST", this.gitUrl(`repositories/${repositoryId}/pushes`), {
            refUpdates: [{ name: fullBranchName(branch), oldObjectId }],
            commits: [{ comment: commit.comment, author: commit.author, changes: commit.changes }]
        });
    }

    createPullRequest(
        repositoryId: string,
        request: { sourceBranch: string; targetBranch: string; title: string; description?: string; workItemIds: number[]; mergeStrategy?: MergeStrategy }
    ): Promise<GitPullRequest> {
        return this.send("POST", this.gitUrl(`repositories/${repositoryId}/pullrequests`), {
            sourceRefName: fullBranchName(request.sourceBranch),
            targetRefName: fullBranchName(request.targetBranch),
            title: request.title,
            description: request.description,
            workItemRefs: request.workItemIds.map(id => ({ id: String(id) })),
            completionOptions: request.mergeStrategy ? { mergeStrategy: request.mergeStrategy } : undefined
        });
    }

    /** Work items by id with their parent; ones that are deleted or can't be read are left out. */
    async getWorkItems(ids: number[]): Promise<WorkItem[]> {
        const workItems: WorkItem[] = [];
        for (let i = 0; i < ids.length; i += workItemBatchSize) {
            const result = await this.send<{ value: ({ id: number; fields: Record<string, unknown> } | null)[] }>("POST", this.apiUrl("wit/workitemsbatch"), {
                ids: ids.slice(i, i + workItemBatchSize),
                fields: ["System.Title", "System.WorkItemType", "System.State", "System.Parent"],
                errorPolicy: "omit"
            });
            for (const item of result.value) {
                if (!item) continue;
                const parent = item.fields["System.Parent"];
                workItems.push({
                    id: item.id,
                    title: String(item.fields["System.Title"] ?? ""),
                    type: String(item.fields["System.WorkItemType"] ?? ""),
                    state: String(item.fields["System.State"] ?? ""),
                    parentId: typeof parent === "number" ? parent : undefined
                });
            }
        }
        return workItems;
    }

    /** Turns on auto-complete as userId, so the pull request completes once its policies pass. */
    setAutoComplete(repositoryId: string, pullRequestId: number, userId: string, completionOptions: { deleteSourceBranch?: boolean; mergeStrategy?: MergeStrategy }): Promise<GitPullRequest> {
        return this.send("PATCH", this.gitUrl(`repositories/${repositoryId}/pullrequests/${pullRequestId}`), { autoCompleteSetBy: { id: userId }, completionOptions });
    }

    private gitUrl(path: string, query: Query = {}): string {
        return this.apiUrl(`git/${path}`, query);
    }

    private apiUrl(path: string, query: Query = {}): string {
        const params = new URLSearchParams();
        for (const [key, value] of Object.entries(query)) {
            if (value !== undefined) params.set(key, String(value));
        }
        params.set("api-version", "7.1");
        return `${this.connection.baseUrl}${encodeURIComponent(this.connection.project)}/_apis/${path}?${params}`;
    }

    private async send<T>(method: string, url: string, body?: unknown): Promise<T> {
        const response = await this.fetch(method, url, body);
        return (await response.json()) as T;
    }

    private async fetch(method: string, url: string, body?: unknown, accept = "application/json"): Promise<Response> {
        const headers: Record<string, string> = { Accept: accept, ...(await this.connection.getHeaders()) };
        if (body !== undefined) headers["Content-Type"] = "application/json";

        const response = await fetch(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
        if (!response.ok) {
            const request = `${method} ${url.split("/_apis/")[1]?.split("?")[0] ?? url}`;
            let detail = "";
            const text = await response.text();
            try {
                detail = ((JSON.parse(text) as { message?: string }).message ?? "").trim();
            } catch {
                if (!text.trimStart().startsWith("<")) detail = text.trim().substring(0, 300);
            }
            const serviceError = response.headers.get("x-tfs-serviceerror");
            if (!detail && serviceError) detail = decodeURIComponent(serviceError.replace(/\+/g, " "));
            const hint = response.status === 401 || response.status === 403 ? " Check the token's scopes and your permissions on the repository." : "";
            throw new AdoError(`${request} returned ${response.status} ${response.statusText}.${detail ? ` ${detail}` : ""}${hint}`, response.status);
        }
        // A bad or expired PAT gets a 203 with the HTML sign-in page instead of a 401.
        const contentType = response.headers.get("content-type") ?? "";
        if (accept.includes("json") ? !contentType.includes("json") : contentType.includes("html")) {
            throw new AdoError("Azure DevOps returned a non-JSON response. Check the credentials and organization URL.", response.status);
        }
        return response;
    }
}

function addMatches(target: Map<string, GitPullRequest[]>, result: Record<string, GitPullRequest[]> | undefined) {
    if (!result) return;
    for (const [commitId, pullRequests] of Object.entries(result)) {
        const existing = target.get(commitId);
        if (existing) existing.push(...pullRequests);
        else target.set(commitId, [...pullRequests]);
    }
}

export function shortBranchName(name: string): string {
    return name.startsWith("refs/heads/") ? name.substring("refs/heads/".length) : name;
}

export function fullBranchName(name: string): string {
    return name.startsWith("refs/") ? name : `refs/heads/${name}`;
}
