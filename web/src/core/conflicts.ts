import { diff3Merge } from "node-diff3";
import type { AdoClient } from "./adoClient";
import type { GitCommitRef, GitFile, PushChange } from "./types";

/**
 * content: both sides changed the same lines. deletedOnTarget: the source changed a file the target doesn't have.
 * deletedInSource: the source deleted a file the target changed. binary: both sides changed a binary file.
 */
export type ConflictKind = "content" | "deletedOnTarget" | "deletedInSource" | "binary";

/** Where a file's new content comes from: merged text, or a copy of a file at a commit. undefined means delete it. */
type Write = { text: string } | { copy: { commitId: string; path: string } } | undefined;

export interface ConflictFile {
    path: string;
    kind: ConflictKind;
    /** The source commit's version, for text files. */
    incoming?: string;
    /** The target's version, for text files. */
    current?: string;
    /** For content conflicts: the merge, with conflict markers around each overlapping change. */
    merged?: string;
    /** What "keep incoming" and "keep current" write; "unchanged" leaves the target's file alone. */
    keepIncoming: Write;
    keepCurrent: Write | "unchanged";
    existsOnTarget: boolean;
}

/** content: write this text. keep: take one side's whole file. */
export type FileResolution = { content: string } | { keep: "incoming" | "current" };

export interface PreparedMerge {
    commit: GitCommitRef;
    /** Files that merged on their own. */
    merged: { path: string; write: Write; existsOnTarget: boolean }[];
    conflicts: ConflictFile[];
}

export interface ConflictLabels {
    current: string;
    incoming: string;
}

export const conflictStart = "<<<<<<<";
export const conflictMiddle = "=======";
export const conflictEnd = ">>>>>>>";

/** A three-way merge of text. Overlapping changes are wrapped in conflict markers. */
export function mergeText(base: string, current: string, incoming: string, labels: ConflictLabels): { text: string; conflicts: number } {
    const eol = (current + incoming).includes("\r\n") ? "\r\n" : "\n";
    const block = (lines: string[]) => {
        const text = lines.join("");
        return text.length === 0 || text.endsWith("\n") ? text : text + eol;
    };

    let text = "";
    let conflicts = 0;
    for (const region of diff3Merge(splitLines(current), splitLines(base), splitLines(incoming), { excludeFalseConflicts: true })) {
        if (region.ok) {
            text += region.ok.join("");
        } else if (region.conflict) {
            conflicts++;
            text += `${conflictStart} ${labels.current}${eol}${block(region.conflict.a)}${conflictMiddle}${eol}${block(region.conflict.b)}${conflictEnd} ${labels.incoming}${eol}`;
        }
    }
    return { text, conflicts };
}

/** Lines with their line endings, so joining them gives back the exact text. */
function splitLines(text: string): string[] {
    return text.match(/[^\n]*\n|[^\n]+$/g) ?? [];
}

/** Counts the conflict blocks still marked in a merged file. */
export function countConflicts(text: string): number {
    return text.match(new RegExp(`^${conflictStart}`, "gm"))?.length ?? 0;
}

/**
 * Merges one commit onto a branch head the way a cherry-pick would, file by file: against the commit's first parent,
 * its own version, and the head's version.
 */
export async function prepareMerge(client: AdoClient, repositoryId: string, commit: GitCommitRef, ontoHead: string, labels: ConflictLabels): Promise<PreparedMerge> {
    const parent = commit.parents?.[0];
    if (!parent) throw new Error(`Commit ${commit.commitId.substring(0, 8)} has no parent to merge against.`);

    const prepared: PreparedMerge = { commit, merged: [], conflicts: [] };
    const changes = (await client.getCommitChanges(repositoryId, commit.commitId)).filter(c => !c.item.isFolder && c.item.gitObjectType !== "tree");

    for (const change of changes) {
        const flags = change.changeType.split(",").map(f => f.trim().toLowerCase());
        const path = change.item.path;
        const oldPath = flags.includes("rename") && change.sourceServerItem ? change.sourceServerItem : undefined;
        const deleted = flags.includes("delete");

        const [base, incoming, current, currentAtOldPath] = await Promise.all([
            client.getFile(repositoryId, oldPath ?? path, parent),
            deleted ? Promise.resolve(undefined) : client.getFile(repositoryId, path, commit.commitId),
            client.getFile(repositoryId, path, ontoHead),
            oldPath ? client.getFile(repositoryId, oldPath, ontoHead) : Promise.resolve(undefined)
        ]);

        // A rename moves the target's copy too: drop the old path and merge into the new one.
        if (oldPath && currentAtOldPath) prepared.merged.push({ path: oldPath, write: undefined, existsOnTarget: true });
        const target = current ?? currentAtOldPath;
        const targetPath = current ? path : oldPath ?? path;
        mergeFile(prepared, path, base, incoming, target, { commitId: ontoHead, path: targetPath }, current !== undefined, commit.commitId, labels);
    }
    return prepared;
}

function mergeFile(
    prepared: PreparedMerge,
    path: string,
    base: GitFile | undefined,
    incoming: GitFile | undefined,
    current: GitFile | undefined,
    currentSource: { commitId: string; path: string },
    existsOnTarget: boolean,
    incomingCommitId: string,
    labels: ConflictLabels
) {
    const same = (a: GitFile | undefined, b: GitFile | undefined) => (a === undefined ? b === undefined : b !== undefined && a.objectId === b.objectId);
    const incomingWrite: Write = incoming && { copy: { commitId: incomingCommitId, path } };
    // When the target's file came from another path (a rename), keeping it means copying it over.
    const currentWrite: Write | "unchanged" = existsOnTarget ? "unchanged" : current && { copy: currentSource };
    const write = (w: Write | "unchanged") => {
        if (w !== "unchanged" && !(w === undefined && !existsOnTarget)) prepared.merged.push({ path, write: w, existsOnTarget });
    };

    if (same(incoming, current)) return write(currentWrite);
    if (same(current, base)) return write(incomingWrite);
    if (same(incoming, base)) return write(currentWrite);

    const conflict = (kind: ConflictKind, extra: Partial<ConflictFile> = {}) =>
        prepared.conflicts.push({ path, kind, keepIncoming: incomingWrite, keepCurrent: currentWrite, existsOnTarget, ...extra });

    if (!incoming) return conflict("deletedInSource", { current: current?.content });
    if (!current) return conflict("deletedOnTarget", { incoming: incoming.content });
    if (incoming.isBinary || current.isBinary || base?.isBinary) return conflict("binary");

    const merge = mergeText(base?.content ?? "", current.content!, incoming.content!, labels);
    if (merge.conflicts === 0) return write({ text: merge.text });
    conflict("content", { incoming: incoming.content, current: current.content, merged: merge.text });
}

/** The push changes for a prepared merge and the user's resolutions of its conflicts. */
export async function buildPushChanges(client: AdoClient, repositoryId: string, prepared: PreparedMerge, resolutions: ReadonlyMap<string, FileResolution>): Promise<PushChange[]> {
    const writes = [...prepared.merged];
    for (const file of prepared.conflicts) {
        const resolution = resolutions.get(file.path);
        if (!resolution) throw new Error(`${file.path} has no resolution.`);
        const write: Write | "unchanged" = "content" in resolution ? { text: resolution.content } : resolution.keep === "incoming" ? file.keepIncoming : file.keepCurrent;
        if (write !== "unchanged" && !(write === undefined && !file.existsOnTarget)) writes.push({ path: file.path, write, existsOnTarget: file.existsOnTarget });
    }

    const changes: PushChange[] = [];
    for (const { path, write, existsOnTarget } of writes) {
        if (write === undefined) {
            changes.push({ changeType: "delete", item: { path } });
            continue;
        }
        const newContent = "text" in write
            ? { content: write.text, contentType: "rawtext" as const }
            : { content: await client.getFileBase64(repositoryId, write.copy.path, write.copy.commitId), contentType: "base64encoded" as const };
        changes.push({ changeType: existsOnTarget ? "edit" : "add", item: { path }, newContent });
    }
    return changes;
}
