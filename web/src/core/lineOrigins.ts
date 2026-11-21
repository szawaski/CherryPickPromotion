import { diffIndices } from "node-diff3";
import type { AdoClient } from "./adoClient";
import type { ConflictFile, FileAt } from "./conflicts";
import type { GitCommitRef } from "./types";

/** The commit that brought a line into a file. */
export interface LineOrigin {
    commitId: string;
    /** The author date, which cherry-picks keep, so a promoted line dates from when it was written. */
    date: string;
    author: string;
    message: string;
    /** The history ran out before the line's first appearance: it's at least this old. */
    orAtLeast?: boolean;
}

/** Each conflict block's line origins, in block order; undefined where a line couldn't be dated. */
export interface FileOrigins {
    regions: { current: (LineOrigin | undefined)[]; incoming: (LineOrigin | undefined)[] }[];
}

/** A version of the file: the commit that left it so, and its text. */
export interface FileVersion {
    commit: GitCommitRef;
    text: string;
}

const maxVersions = 40;

/**
 * Dates the lines of each conflict block in a file, on both sides: the current lines from the target's history, the
 * incoming ones from the source commit's. Only text conflicts with known versions are dated.
 */
export async function conflictLineOrigins(client: AdoClient, repositoryId: string, file: ConflictFile): Promise<FileOrigins | undefined> {
    if (file.kind !== "content" || !file.regions || !file.currentAt || !file.incomingAt || file.current === undefined || file.incoming === undefined) return undefined;
    const wanted = (side: "current" | "incoming") => file.regions!.flatMap(r => range(r[side].start, r[side].length));
    const [current, incoming] = await Promise.all([
        datesFor(client, repositoryId, file.currentAt, file.current, wanted("current")),
        datesFor(client, repositoryId, file.incomingAt, file.incoming, wanted("incoming"))
    ]);
    return {
        regions: file.regions.map(r => ({
            current: range(r.current.start, r.current.length).map(i => current.get(i)),
            incoming: range(r.incoming.start, r.incoming.length).map(i => incoming.get(i))
        }))
    };
}

/** Loads the file's history at a version, newest first, and dates the wanted lines of its text there. */
async function datesFor(client: AdoClient, repositoryId: string, at: FileAt, text: string, lines: number[]): Promise<Map<number, LineOrigin>> {
    if (lines.length === 0) return new Map();
    const history = await client.getFileHistory(repositoryId, at.path, at.commitId, maxVersions + 1);
    const texts = new Map<string, Promise<string | undefined>>();
    const textAt = (commitId: string) => {
        let loaded = texts.get(commitId);
        if (!loaded) {
            loaded = client.getFile(repositoryId, at.path, commitId).then(f => (f && !f.isBinary ? (f.content ?? "") : undefined));
            texts.set(commitId, loaded);
        }
        return loaded;
    };
    return originsOf(text, lines, history.slice(0, maxVersions), textAt, history.length > maxVersions);
}

/**
 * Like git blame for some lines: follows them back through the file's versions, newest first, and dates each by the
 * version it first appears in. A line in a version but not the one before was added by that version's commit. Stops
 * once every line is dated. Lines still there at the oldest version loaded date from it, as at least that old when the
 * history went further back (truncated). A version that can't be read ends the walk the same way.
 */
export async function originsOf(
    text: string,
    lines: number[],
    history: GitCommitRef[],
    textAt: (commitId: string) => Promise<string | undefined>,
    truncated: boolean
): Promise<Map<number, LineOrigin>> {
    const origins = new Map<number, LineOrigin>();
    if (history.length === 0) return origins;
    const origin = (commit: GitCommitRef, orAtLeast = false): LineOrigin => ({
        commitId: commit.commitId,
        date: commit.author.date,
        author: commit.author.name,
        message: firstLine(commit.comment),
        ...(orAtLeast ? { orAtLeast } : {})
    });

    const newest = await textAt(history[0].commitId);
    if (newest === undefined) return origins;
    // Where each wanted line is in the version being looked at. The text should be the newest version's; if it isn't
    // (edited since), lines that differ have no date.
    let tracked = follow(new Map(lines.map(l => [l, l])), splitLines(text), splitLines(newest), () => undefined);
    let newer = splitLines(newest);
    for (let k = 0; k < history.length && tracked.size > 0; k++) {
        const last = k === history.length - 1;
        const older = last ? undefined : await textAt(history[k + 1].commitId);
        if (older === undefined) {
            // The oldest version loaded, or one that couldn't be read: what's left is at least this old.
            for (const line of tracked.keys()) origins.set(line, origin(history[k], last ? truncated : true));
            break;
        }
        const olderLines = splitLines(older);
        tracked = follow(tracked, newer, olderLines, line => origins.set(line, origin(history[k])));
        newer = olderLines;
    }
    return origins;
}

/**
 * Maps the tracked lines from one version of the text to an older one. A line the older version doesn't have was added
 * after it: added(line) is called and it stops being tracked.
 */
function follow(tracked: Map<number, number>, newer: string[], older: string[], added: (line: number) => void): Map<number, number> {
    // Where each line of the newer version was in the older one; -1 where it was added.
    const toOlder = new Array<number>(newer.length);
    let n = 0;
    let o = 0;
    for (const hunk of diffIndices(older, newer)) {
        const [oldStart, oldLength] = hunk.buffer1;
        const [newStart, newLength] = hunk.buffer2;
        while (n < newStart) toOlder[n++] = o++;
        for (let i = 0; i < newLength; i++) toOlder[n++] = -1;
        o = oldStart + oldLength;
    }
    while (n < newer.length) toOlder[n++] = o++;

    const next = new Map<number, number>();
    for (const [line, at] of tracked) {
        const before = toOlder[at] ?? -1;
        if (before < 0) added(line);
        else next.set(line, before);
    }
    return next;
}

function splitLines(text: string): string[] {
    const lines = text.split("\n").map(l => l.replace(/\r$/, ""));
    if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
    return lines;
}

function range(start: number, length: number): number[] {
    return Array.from({ length }, (_, i) => start + i);
}

function firstLine(text: string): string {
    const index = text.indexOf("\n");
    return (index < 0 ? text : text.substring(0, index)).trim();
}

/** Which side of a conflict block was changed more recently, by its newest line; the newest line of each side. */
export interface Suggestion {
    side: "current" | "incoming";
    current: LineOrigin;
    incoming: LineOrigin;
}

/**
 * Suggests the side whose newest line is newer. None when a side has no dated lines (it only deleted, or couldn't be
 * dated) or both are as new, since then the dates can't tell.
 */
export function suggestSide(current: (LineOrigin | undefined)[], incoming: (LineOrigin | undefined)[]): Suggestion | undefined {
    const newest = (origins: (LineOrigin | undefined)[]) =>
        origins.filter((o): o is LineOrigin => o !== undefined).sort((a, b) => Date.parse(b.date) - Date.parse(a.date))[0];
    const c = newest(current);
    const i = newest(incoming);
    if (!c || !i) return undefined;
    const difference = Date.parse(i.date) - Date.parse(c.date);
    if (!Number.isFinite(difference) || difference === 0) return undefined;
    return { side: difference > 0 ? "incoming" : "current", current: c, incoming: i };
}

/** What to keep of a conflict block, and why: the text says (contains, onlyAdded) or the dates do. */
export interface BlockSuggestion {
    side: "current" | "incoming" | "both";
    why: "contains" | "onlyAdded" | "dates";
    /** For a suggestion by dates: each side's newest line. */
    current?: LineOrigin;
    incoming?: LineOrigin;
}

/**
 * What the text alone says about a conflict block, before any dates:
 * - a side that already has every line of the other, in order, loses nothing when kept (contains);
 * - when both sides kept every line they started from and only added their own, and what they added is different
 *   things, neither replaced the other, so both belong (onlyAdded), as when two entries were added at the same spot.
 *   Additions that read alike are two versions of the same entry instead, and keeping both would repeat it.
 * Otherwise a side really replaced the other's lines, and only the dates can suggest which.
 */
export function suggestFromText(base: string[], current: string[], incoming: string[]): BlockSuggestion | undefined {
    if (incoming.length > 0 && isSubsequence(incoming, current)) return { side: "current", why: "contains" };
    if (current.length > 0 && isSubsequence(current, incoming)) return { side: "incoming", why: "contains" };
    if (current.length > 0 && incoming.length > 0 && isSubsequence(base, current) && isSubsequence(base, incoming)) {
        const addedCurrent = withoutBase(base, current);
        const addedIncoming = withoutBase(base, incoming);
        const alike = addedCurrent.some(c => addedIncoming.some(i => readAlike(c, i)));
        if (!alike) return { side: "both", why: "onlyAdded" };
    }
    return undefined;
}

/** The lines a side added: all but the base lines it kept, in order. */
function withoutBase(base: string[], lines: string[]): string[] {
    const added: string[] = [];
    let b = 0;
    for (const line of lines) {
        if (b < base.length && line === base[b]) b++;
        else added.push(line);
    }
    return added;
}

/**
 * Whether two lines say much the same thing: the same text, or at least three words of three letters or more in
 * common making up at least 40% of their words, like two wordings of one entry. "using B;" and "using Bee;" share only
 * "using", so they're different things.
 */
function readAlike(a: string, b: string): boolean {
    if (a.trim() !== "" && a.trim() === b.trim()) return true;
    const words = (line: string) => new Set((line.toLowerCase().match(/[a-z0-9_]+/g) ?? []).filter(w => w.length >= 3));
    const wa = words(a);
    const wb = words(b);
    const shared = [...wa].filter(w => wb.has(w)).length;
    const all = new Set([...wa, ...wb]).size;
    return shared >= 3 && shared / all >= 0.4;
}

/** A suggestion by dates for a block the text can't decide. */
export function suggestFromDates(current: (LineOrigin | undefined)[], incoming: (LineOrigin | undefined)[]): BlockSuggestion | undefined {
    const suggestion = suggestSide(current, incoming);
    return suggestion && { side: suggestion.side, why: "dates", current: suggestion.current, incoming: suggestion.incoming };
}

/**
 * Both sides of a block as one: the current side, then what the incoming side added, without the base lines both
 * kept, so those aren't repeated. When the incoming side doesn't keep every base line, it's added whole.
 */
export function combineBoth(base: string[], current: string[], incoming: string[]): string[] {
    if (!isSubsequence(base, incoming)) return [...current, ...incoming];
    const added: string[] = [];
    let b = 0;
    for (const line of incoming) {
        if (b < base.length && line === base[b]) b++;
        else added.push(line);
    }
    return [...current, ...added];
}

/** Whether every item of part appears in whole, in the same order. */
function isSubsequence(part: string[], whole: string[]): boolean {
    let i = 0;
    for (const item of whole) if (i < part.length && item === part[i]) i++;
    return i === part.length;
}
