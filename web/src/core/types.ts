export interface GitRepository {
    id: string;
    name: string;
    defaultBranch?: string;
    webUrl: string;
}

export interface GitRef {
    name: string;
    objectId: string;
}

export interface GitUserDate {
    name: string;
    email: string;
    date: string;
}

export interface ResourceRef {
    id: string;
    url?: string;
}

export interface GitCommitRef {
    commitId: string;
    comment: string;
    commentTruncated?: boolean;
    author: GitUserDate;
    committer?: GitUserDate;
    parents?: string[];
    workItems?: ResourceRef[];
}

/** A file a commit changed. changeType can combine flags, e.g. "edit, rename". */
export interface GitChange {
    changeType: string;
    /** objectId is the blob the commit left at the path (for a delete, the one it removed). */
    item: { path: string; isFolder?: boolean; gitObjectType?: string; objectId?: string };
    /** The old path of a renamed file. */
    sourceServerItem?: string;
}

export interface GitFile {
    objectId: string;
    isBinary: boolean;
    /** Undefined for binary files. */
    content?: string;
}

export type PushChange =
    | { changeType: "add" | "edit"; item: { path: string }; newContent: { content: string; contentType: "rawtext" | "base64encoded" } }
    | { changeType: "delete"; item: { path: string } };

export type PullRequestStatus = "notSet" | "active" | "abandoned" | "completed" | "all";

export interface GitPullRequest {
    pullRequestId: number;
    title: string;
    status: PullRequestStatus;
    isDraft?: boolean;
    sourceRefName: string;
    targetRefName: string;
    creationDate: string;
    closedDate?: string;
    createdBy: { displayName: string; id?: string };
    lastMergeCommit?: { commitId: string };
    repository?: { id: string; webUrl?: string };
}

export type AsyncOperationStatus = "queued" | "inProgress" | "completed" | "failed" | "abandoned";

export interface GitCherryPick {
    cherryPickId: number;
    status: AsyncOperationStatus;
    detailedStatus?: {
        conflict?: boolean;
        /** The commit being applied; on a conflict, the one that conflicted. */
        currentCommitId?: string;
        failureMessage?: string;
        progress?: number;
        /** Why it failed, e.g. createBranchPermissionRequired. */
        status?: string;
        timedout?: boolean;
    };
}

/** Pull requests found for each commit, keyed by commit id. */
export interface PullRequestMatches {
    byMergeCommit: Map<string, GitPullRequest[]>;
    byCommit: Map<string, GitPullRequest[]>;
}

/** An earlier promotion pull request into the target, completed or still open, with the commits it cherry-picked. */
export interface Promotion {
    pullRequest: GitPullRequest;
    commits: GitCommitRef[];
}

export interface PlanCommit {
    commit: GitCommitRef;
    /** Position in the source branch, oldest first. */
    order: number;
    isMerge: boolean;
    /** Why the commit counts as already on the target, if it does. */
    promotedReason?: string;
    /** Set when promotedReason is an open pull request into the target, so the change isn't on the target yet. */
    inOpenPullRequest?: number;
}

export interface PlanItem {
    key: string;
    pullRequest?: GitPullRequest;
    commits: PlanCommit[];
    workItemIds: number[];
    /** At least one commit still needs to be cherry-picked. */
    hasPendingCommits: boolean;
    /** An open promotion pull request that includes the item, such as one just created. */
    promotedIn?: number;
    /** An active pull request into the source branch; it has no commits on the source yet. */
    openPullRequest?: boolean;
}

export interface PromotionResult {
    pullRequest: GitPullRequest;
    /** The selected items the pull request includes. */
    includedKeys: string[];
    /** Set when a conflict stopped the promotion before every selected item. */
    conflict?: { commit: GitCommitRef; itemKey?: string };
    /** Conflicts resolved in the editor along the way. */
    resolvedConflicts: number;
}

export interface WorkItem {
    id: number;
    title: string;
    type: string;
    state: string;
    parentId?: number;
}

export interface PromotionPlan {
    sourceBranch: string;
    targetBranch: string;
    items: PlanItem[];
    /** An open sync pull request into the target, from createSyncPullRequest. */
    openSyncPullRequest?: GitPullRequest;
}
