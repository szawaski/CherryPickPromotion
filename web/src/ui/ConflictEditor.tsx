import { useEffect, useMemo, useRef, useState } from "react";
import { findConflictBlocks, strayConflictMarkers, unresolvedInText, type ConflictBlock, type ConflictFile, type FileResolution } from "../core/conflicts";
import { combineBoth, suggestFromDates, suggestFromText, type BlockSuggestion, type LineOrigin } from "../core/lineOrigins";
import { firstLine, type ConflictAnswer, type ConflictRequest } from "../core/promotion";
import * as monaco from "./monaco";

// Monaco's worker and styles are built next to this chunk (see build.mjs).
(self as unknown as { MonacoEnvironment: monaco.Environment }).MonacoEnvironment = {
    getWorker: () => new Worker(new URL("./editor.worker.js", import.meta.url))
};
const stylesheet = document.createElement("link");
stylesheet.rel = "stylesheet";
stylesheet.href = new URL("./editor.css", import.meta.url).href;
document.head.appendChild(stylesheet);

interface Props {
    request: ConflictRequest;
    onDone(answer: ConflictAnswer): void;
}

type Block = ConflictBlock;

/** One conflict line, followed through edits by a model decoration, and when it was written once that's known. */
interface LineMark {
    id: string;
    side: "current" | "incoming";
    block: number;
    /** Its place among its side's lines in the block. */
    index: number;
    /** The line's length when the conflict opened; a line that had text and now has none was deleted. */
    length: number;
    origin?: LineOrigin;
}

/** A text conflict's line dates: loading, shown, or not available. markers follow each block's <<<<<<< line. */
interface FileDates {
    state: "loading" | "ready" | "unavailable";
    markers: string[];
    lines: LineMark[];
    /** Per block: what the text says from the start, then the dates once they're in. */
    suggestions: (BlockSuggestion | undefined)[];
    /** Per block: the lines both sides started from, for combining them. */
    bases: string[][];
}

export default function ConflictEditor({ request, onDone }: Props) {
    const { files, labels, commit, item } = request;
    const [fileIndex, setFileIndex] = useState(0);
    const [choices, setChoices] = useState<Map<string, "incoming" | "current">>(new Map());
    const [, setVersion] = useState(0);

    // One result model per text conflict, kept across file switches so edits aren't lost.
    const models = useMemo(() => {
        const map = new Map<string, monaco.editor.ITextModel>();
        for (const file of files) {
            if (file.kind === "content") map.set(file.path, monaco.editor.createModel(file.merged!, languageFor(file.path)));
        }
        return map;
    }, [files]);
    // Every conflict line of each text conflict, tracked from the start so its date lands on it after edits.
    const dates = useMemo(() => {
        const map = new Map<string, FileDates>();
        for (const file of files) {
            const model = models.get(file.path);
            const blocks = model && file.regions ? findConflictBlocks(file.merged!) : [];
            if (!model || blocks.length === 0 || blocks.length !== file.regions!.length) continue;
            const track = (line: number) =>
                model.deltaDecorations([], [{ range: new monaco.Range(line, 1, line, model.getLineMaxColumn(line)), options: { stickiness: monaco.editor.TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges } }])[0];
            const lines: LineMark[] = [];
            blocks.forEach((b, block) => {
                for (let line = b.start + 1; line < b.middle; line++) lines.push({ id: track(line), side: "current", block, index: line - b.start - 1, length: model.getLineLength(line) });
                for (let line = b.middle + 1; line < b.end; line++) lines.push({ id: track(line), side: "incoming", block, index: line - b.middle - 1, length: model.getLineLength(line) });
            });
            const sideLines = (text: string, at: { start: number; length: number }) => text.split("\n").map(l => l.replace(/\r$/, "")).slice(at.start, at.start + at.length);
            const suggestions = file.regions!.map(r => suggestFromText(r.base, sideLines(file.current!, r.current), sideLines(file.incoming!, r.incoming)));
            map.set(file.path, { state: request.origins ? "loading" : "unavailable", markers: blocks.map(b => track(b.start)), lines, suggestions, bases: file.regions!.map(r => r.base) });
        }
        return map;
    }, [files, models]);
    useEffect(() => {
        let live = true;
        for (const file of files) {
            const fileDates = dates.get(file.path);
            if (!fileDates || !request.origins) continue;
            const done = () => live && setVersion(v => v + 1);
            request.origins(file).then(
                origins => {
                    if (!origins) {
                        fileDates.state = "unavailable";
                    } else {
                        for (const mark of fileDates.lines) mark.origin = origins.regions[mark.block]?.[mark.side][mark.index];
                        // What the text says stands; the dates only speak where it couldn't.
                        fileDates.suggestions = origins.regions.map((r, i) => fileDates.suggestions[i] ?? suggestFromDates(r.current, r.incoming));
                        fileDates.state = "ready";
                    }
                    done();
                },
                () => {
                    fileDates.state = "unavailable";
                    done();
                }
            );
        }
        return () => {
            live = false;
        };
    }, [dates]);
    useEffect(() => {
        const subscriptions = [...models.values()].map(m => m.onDidChangeContent(() => setVersion(v => v + 1)));
        return () => {
            subscriptions.forEach(s => s.dispose());
            models.forEach(m => m.dispose());
        };
    }, [models]);

    const remaining = (file: ConflictFile) => (file.kind === "content" ? unresolvedInText(models.get(file.path)!.getValue()) : choices.has(file.path) ? 0 : 1);
    const unresolved = files.reduce((n, f) => n + remaining(f), 0);
    const left = files.map((f, i) => ({ f, i, n: remaining(f) })).filter(x => x.n > 0);
    const leftText = left.map(x => `${x.f.path.split("/").pop()} (${x.n})`).join(", ");
    // The next file with something left, after the one shown.
    const nextLeft = left.find(x => x.i > fileIndex) ?? left[0];
    // Once a file is resolved, on to the next one with anything left; with none left, stay to commit.
    const advance = (resolvedChoices = choices) => {
        const open = files.map((f, i) => ({ i, n: f.kind === "content" ? unresolvedInText(models.get(f.path)!.getValue()) : resolvedChoices.has(f.path) ? 0 : 1 })).filter(x => x.n > 0);
        const next = open.find(x => x.i > fileIndex) ?? open[0];
        if (next) setFileIndex(next.i);
    };
    const file = files[fileIndex] as ConflictFile | undefined;

    function commitResolution() {
        const answer = new Map<string, FileResolution>();
        for (const f of files) {
            answer.set(f.path, f.kind === "content" ? { content: models.get(f.path)!.getValue() } : { keep: choices.get(f.path)! });
        }
        onDone(answer);
    }

    return (
        <div className="cpp-conflict">
            <header className="cpp-conflict-header">
                <strong>Resolve conflicts</strong> in commit <span className="cpp-sha">{commit.commitId.substring(0, 8)}</span> {firstLine(commit.comment)}
                {item.pullRequest && <span className="cpp-meta"> · !{item.pullRequest.pullRequestId} {item.pullRequest.title}</span>}
            </header>

            <div className="cpp-conflict-body">
                <ul className="cpp-conflict-files">
                    {files.map((f, i) => (
                        <li key={f.path}>
                            <button className={i === fileIndex ? "cpp-selected" : ""} title={f.path} onClick={() => setFileIndex(i)}>
                                <span className="cpp-conflict-count">{remaining(f) === 0 ? "✓" : remaining(f)}</span> {f.path.split("/").pop()}
                            </button>
                        </li>
                    ))}
                </ul>

                <div className="cpp-conflict-main">
                    {!file && <p>Azure DevOps reported a conflict, but every file in this commit merged cleanly here. Commit to continue.</p>}
                    {file?.kind === "content" && (
                        <TextConflict key={file.path} file={file} model={models.get(file.path)!} labels={labels} dates={dates.get(file.path)} datesState={dates.get(file.path)?.state} onResolved={() => advance()} />
                    )}
                    {file && file.kind !== "content" && (
                        <WholeFileConflict key={file.path} file={file} labels={labels} choice={choices.get(file.path)} onChoose={c => {
                                const next = new Map(choices).set(file.path, c);
                                setChoices(next);
                                advance(next);
                            }}
                        />
                    )}
                </div>
            </div>

            <footer className="cpp-conflict-footer">
                <span className="cpp-meta">
                    {unresolved === 0 ? "All conflicts resolved." : `${unresolved} left to resolve in ${leftText}.`}
                    {request.autoMerged.length > 0 && ` ${request.autoMerged.length} other files merged on their own.`}
                </span>
                <button onClick={() => onDone("abort")} title="Create no pull request and remove the branches made so far; the selection stays as it is">
                    Abort
                </button>
                <button onClick={() => onDone("skip")} title="Leave this item and everything after it out; they stay selected for next time">
                    Stop and create PR up to here
                </button>
                {nextLeft && (nextLeft.i !== fileIndex || left.length > 1) && (
                    <button onClick={() => setFileIndex(nextLeft.i)} title={nextLeft.f.path}>
                        Go to {nextLeft.f.path.split("/").pop()}
                    </button>
                )}
                <button className="cpp-primary" disabled={unresolved > 0} onClick={commitResolution} title={unresolved > 0 ? `Resolve what's left first: ${leftText}` : undefined}>
                    Commit and continue
                </button>
            </footer>
        </div>
    );
}

function TextConflict({
    file,
    model,
    labels,
    dates,
    datesState,
    onResolved
}: {
    file: ConflictFile;
    model: monaco.editor.ITextModel;
    labels: ConflictRequest["labels"];
    dates?: FileDates;
    datesState?: FileDates["state"];
    /** Called when a Take button resolves the file's last conflict; typing never moves on by itself. */
    onResolved(): void;
}) {
    const resultHost = useRef<HTMLDivElement>(null);
    const resultEditor = useRef<monaco.editor.IStandaloneCodeEditor>();
    const paint = useRef<() => void>();
    const [blockIndex, setBlockIndex] = useState(0);
    const [blocks, setBlocks] = useState<Block[]>(() => findBlocks(model));
    const [stray, setStray] = useState<number[]>(() => strayConflictMarkers(model.getValue()));

    useEffect(() => {
        const editor = monaco.editor.create(resultHost.current!, { model, automaticLayout: true, theme: isDark() ? "vs-dark" : "vs", minimap: { enabled: false } });
        resultEditor.current = editor;
        const decorations = editor.createDecorationsCollection();
        paint.current = () => {
            const found = findBlocks(model);
            setBlocks(found);
            setStray(strayConflictMarkers(model.getValue()));
            decorations.set([...found.flatMap(blockDecorations), ...dateDecorations(model, found, dates)]);
        };
        paint.current();
        const subscription = model.onDidChangeContent(() => paint.current?.());
        reveal(editor, findBlocks(model)[0]);

        return () => {
            subscription.dispose();
            decorations.clear();
            editor.dispose();
            paint.current = undefined;
        };
    }, [file, model]);
    // The dates arrive after the editor opens.
    useEffect(() => paint.current?.(), [datesState]);

    const current = blocks[Math.min(blockIndex, blocks.length - 1)];
    const suggestion = current ? suggestionFor(model, dates, current) : undefined;
    const go = (index: number) => {
        const next = (index + blocks.length) % blocks.length;
        setBlockIndex(next);
        reveal(resultEditor.current!, blocks[next]);
    };
    const take = (side: "current" | "incoming" | "both") => {
        if (!current) return;
        const lines = model.getLinesContent();
        const currentLines = lines.slice(current.start, current.middle - 1);
        const incomingLines = lines.slice(current.middle, current.end - 1);
        // Both: the base lines the two sides share only once, when it's known what they started from.
        const base = baseFor(model, dates, current);
        const kept = side === "current" ? currentLines : side === "incoming" ? incomingLines : base ? combineBoth(base, currentLines, incomingLines) : [...currentLines, ...incomingLines];
        const eol = model.getEOL();
        const lastLine = current.end === model.getLineCount();
        const range = lastLine
            ? new monaco.Range(current.start, 1, current.end, model.getLineMaxColumn(current.end))
            : new monaco.Range(current.start, 1, current.end + 1, 1);
        const text = kept.length === 0 ? "" : kept.join(eol) + (lastLine ? "" : eol);
        model.pushEditOperations([], [{ range, text }], () => null);
        if (unresolvedInText(model.getValue()) === 0) {
            onResolved();
            return;
        }
        // The next block moves into this one's place.
        setTimeout(() => reveal(resultEditor.current!, findBlocks(model)[Math.min(blockIndex, Math.max(0, findBlocks(model).length - 1))]));
    };
    const takeButton = (side: "current" | "incoming" | "both", label: string) => {
        const suggested = suggestion?.side === side;
        return (
            <button
                disabled={!current}
                className={suggested ? "cpp-suggested" : undefined}
                title={suggested ? `Suggested: ${suggestionText(suggestion!)}` : undefined}
                onClick={() => take(side)}
            >
                {label}
                {suggested && " (Suggested)"}
            </button>
        );
    };
    const original = file.merged!;
    const changed = model.getValue() !== original;
    // An edit rather than setValue, so Ctrl+Z still brings back what was there before the reset.
    const reset = () => {
        model.pushEditOperations([], [{ range: model.getFullModelRange(), text: original }], () => null);
        setBlockIndex(0);
        reveal(resultEditor.current!, findBlocks(model)[0]);
    };

    return (
        <div className="cpp-conflict-text">
            <div className="cpp-conflict-toolbar">
                <span className="cpp-meta cpp-conflict-status">
                    {blocks.length > 0
                        ? `Conflict ${Math.min(blockIndex, blocks.length - 1) + 1} of ${blocks.length} in ${file.path}`
                        : stray.length > 0
                          ? `A leftover conflict marker line is still in the file, on line ${stray.join(", ")}; delete it.`
                          : "No conflicts left in this file."}
                </span>
                {blocks.length === 0 && stray.length > 0 && (
                    <button onClick={() => revealLine(resultEditor.current!, stray[0])}>Go to line {stray[0]}</button>
                )}
                <button disabled={blocks.length < 2} onClick={() => go(blockIndex - 1)}>Prev</button>
                <button disabled={blocks.length < 2} onClick={() => go(blockIndex + 1)}>Next</button>
                {takeButton("current", "Take current")}
                {takeButton("incoming", "Take incoming")}
                {takeButton("both", "Take both")}
                <button disabled={!changed} onClick={reset} title="Put back every conflict in this file and undo all edits to it">
                    Reset file
                </button>
            </div>
            <div className="cpp-conflict-labels">
                <span>
                    Current = {labels.current} · Incoming = {labels.incoming}
                </span>
                <span>
                    {current && suggestion && `Suggested: ${suggestionText(suggestion)}`}
                    {current && !suggestion && datesState === "loading" && "Dating lines…"}
                    {current && !suggestion && datesState === "ready" && "No suggestion for this conflict: each side replaced lines, and the dates can't tell them apart."}
                    {current && !suggestion && datesState === "unavailable" && "No suggestion: each side replaced lines, and line dates aren't available for this file."}
                </span>
            </div>
            <div className="cpp-conflict-result" ref={resultHost} />
        </div>
    );
}

/** Which of the file's original blocks a block still in it is, found by the <<<<<<< line it started with. */
function blockIndex(model: monaco.editor.ITextModel, dates: FileDates | undefined, block: Block): number {
    return dates ? dates.markers.findIndex(id => model.getDecorationRange(id)?.startLineNumber === block.start) : -1;
}

function suggestionFor(model: monaco.editor.ITextModel, dates: FileDates | undefined, block: Block): BlockSuggestion | undefined {
    const index = blockIndex(model, dates, block);
    return index < 0 ? undefined : dates!.suggestions[index];
}

function baseFor(model: monaco.editor.ITextModel, dates: FileDates | undefined, block: Block): string[] | undefined {
    const index = blockIndex(model, dates, block);
    return index < 0 ? undefined : dates!.bases[index];
}

function suggestionText(s: BlockSuggestion): string {
    if (s.why === "onlyAdded") return "both, each side only added lines here and neither replaced the other's";
    if (s.why === "onlySide") {
        const other = s.side === "current" ? "incoming" : "current";
        return s.removed ? `${s.side}, ${other} has none of these lines and ${s.side} changed them` : `${s.side}, it only adds lines and ${other} has none here`;
    }
    if (s.why === "contains") return `${s.side}, it already has every ${s.side === "current" ? "incoming" : "current"} line`;
    const newer = (s.side === "current" ? s.current : s.incoming)!;
    const older = (s.side === "current" ? s.incoming : s.current)!;
    // On the same day the dates alone read as a tie, so the times show.
    const sameDay = dateLabel(newer) === dateLabel(older);
    return `${s.side}, its newest line is ${dateLabel(newer, sameDay)} vs ${s.side === "current" ? "incoming" : "current"}'s ${dateLabel(older, sameDay)}`;
}

function dateLabel(origin: LineOrigin, withTime = false): string {
    const at = new Date(origin.date);
    const date = at.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
    const label = withTime ? `${date} ${at.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}` : date;
    return origin.orAtLeast ? `${label} or earlier` : label;
}

/** Each conflict line still in a block gets its date after it; each block's first line, the suggestion. */
function dateDecorations(model: monaco.editor.ITextModel, blocks: Block[], dates: FileDates | undefined): monaco.editor.IModelDeltaDecoration[] {
    if (!dates) return [];
    const decorations: monaco.editor.IModelDeltaDecoration[] = [];
    const endOf = (line: number) => new monaco.Range(line, model.getLineMaxColumn(line), line, model.getLineMaxColumn(line));
    const inBlock = (line: number) => blocks.some(b => b.start < line && line < b.end && line !== b.middle);
    const newest = dates.suggestions.map(s => (s?.side === "current" ? s.current : s?.side === "incoming" ? s.incoming : undefined));
    for (const mark of dates.state === "ready" ? dates.lines : []) {
        const range = model.getDecorationRange(mark.id);
        if (!mark.origin || !range || (range.isEmpty() && mark.length > 0) || !inBlock(range.startLineNumber)) continue;
        const isNewest = newest[mark.block] !== undefined && dates.suggestions[mark.block]?.side === mark.side && newest[mark.block]!.commitId === mark.origin.commitId;
        const line = range.startLineNumber;
        // Text after the line: an empty range at its end, which Monaco only draws with showIfCollapsed.
        decorations.push({
            range: endOf(line),
            options: { showIfCollapsed: true, after: { content: `   ${dateLabel(mark.origin)}`, inlineClassName: isNewest ? "cpp-line-date cpp-line-date-newer" : "cpp-line-date" } }
        });
        // The details show when hovering anywhere on the line.
        decorations.push({
            range: new monaco.Range(line, 1, line, model.getLineMaxColumn(line)),
            options: { hoverMessage: { value: `**${dateLabel(mark.origin, true)}** · ${mark.origin.author} · \`${mark.origin.commitId.substring(0, 8)}\`\n\n${mark.origin.message}` } }
        });
    }
    dates.markers.forEach((id, i) => {
        const line = model.getDecorationRange(id)?.startLineNumber;
        const suggestion = dates.suggestions[i];
        if (!line || !suggestion || !blocks.some(b => b.start === line)) return;
        decorations.push({ range: endOf(line), options: { showIfCollapsed: true, after: { content: `   Suggested: ${suggestionText(suggestion)}`, inlineClassName: "cpp-line-suggestion" } } });
    });
    return decorations;
}

function WholeFileConflict({ file, labels, choice, onChoose }: { file: ConflictFile; labels: ConflictRequest["labels"]; choice?: "incoming" | "current"; onChoose(choice: "incoming" | "current"): void }) {
    const explanation = {
        deletedOnTarget: `${labels.incoming} changes this file, but ${labels.current} doesn't have it.`,
        deletedInSource: `${labels.incoming} deletes this file, but ${labels.current} changed it.`,
        binary: `Both sides changed this binary file, so it can't be merged line by line.`,
        content: ""
    }[file.kind];
    const incomingLabel = file.kind === "deletedInSource" ? "Delete the file" : `Keep the incoming file (${labels.incoming})`;
    const currentLabel = file.kind === "deletedOnTarget" ? `Leave it out (as on ${labels.current})` : `Keep the current file (${labels.current})`;

    return (
        <div className="cpp-conflict-whole">
            <p>
                <strong>{file.path}</strong>
            </p>
            <p>{explanation}</p>
            <label className="cpp-check">
                <input type="radio" checked={choice === "incoming"} onChange={() => onChoose("incoming")} /> {incomingLabel}
            </label>
            <label className="cpp-check">
                <input type="radio" checked={choice === "current"} onChange={() => onChoose("current")} /> {currentLabel}
            </label>
        </div>
    );
}

function findBlocks(model: monaco.editor.ITextModel): Block[] {
    return findConflictBlocks(model.getValue());
}

function blockDecorations(block: Block): monaco.editor.IModelDeltaDecoration[] {
    const lines = (from: number, to: number, className: string) =>
        from > to ? [] : [{ range: new monaco.Range(from, 1, to, 1), options: { isWholeLine: true, className } }];
    return [
        ...lines(block.start, block.start, "cpp-conflict-marker"),
        ...lines(block.start + 1, block.middle - 1, "cpp-conflict-current"),
        ...lines(block.middle, block.middle, "cpp-conflict-marker"),
        ...lines(block.middle + 1, block.end - 1, "cpp-conflict-incoming"),
        ...lines(block.end, block.end, "cpp-conflict-marker")
    ];
}

function revealLine(editor: monaco.editor.IStandaloneCodeEditor, line: number) {
    editor.revealLineInCenter(line);
    editor.setPosition({ lineNumber: line, column: 1 });
    editor.focus();
}

function reveal(editor: monaco.editor.IStandaloneCodeEditor, block: Block | undefined) {
    if (!block) return;
    editor.revealLinesInCenter(block.start, block.end);
    editor.setPosition({ lineNumber: block.start, column: 1 });
}

function languageFor(path: string): string {
    const name = path.toLowerCase();
    return monaco.languages.getLanguages().find(l => l.extensions?.some(e => name.endsWith(e.toLowerCase())))?.id ?? "plaintext";
}

function isDark(): boolean {
    const [r, g, b] = (getComputedStyle(document.body).backgroundColor.match(/\d+/g) ?? ["255", "255", "255"]).map(Number);
    return 0.299 * r + 0.587 * g + 0.114 * b < 128;
}
