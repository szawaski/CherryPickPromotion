import { useEffect, useMemo, useRef, useState } from "react";
import { conflictEnd, conflictMiddle, conflictStart, countConflicts, type ConflictFile, type FileResolution } from "../core/conflicts";
import { firstLine, type ConflictRequest } from "../core/promotion";
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
    onDone(answer: ReadonlyMap<string, FileResolution> | "skip"): void;
}

interface Block {
    start: number;
    middle: number;
    end: number;
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
    useEffect(() => {
        const subscriptions = [...models.values()].map(m => m.onDidChangeContent(() => setVersion(v => v + 1)));
        return () => {
            subscriptions.forEach(s => s.dispose());
            models.forEach(m => m.dispose());
        };
    }, [models]);

    const remaining = (file: ConflictFile) => (file.kind === "content" ? countConflicts(models.get(file.path)!.getValue()) : choices.has(file.path) ? 0 : 1);
    const unresolved = files.reduce((n, f) => n + remaining(f), 0);
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
                    {file?.kind === "content" && <TextConflict key={file.path} file={file} model={models.get(file.path)!} labels={labels} />}
                    {file && file.kind !== "content" && (
                        <WholeFileConflict key={file.path} file={file} labels={labels} choice={choices.get(file.path)} onChoose={c => setChoices(new Map(choices).set(file.path, c))} />
                    )}
                </div>
            </div>

            <footer className="cpp-conflict-footer">
                <span className="cpp-meta">
                    {unresolved === 0 ? "All conflicts resolved." : `${unresolved} conflicts left.`}
                    {request.autoMerged.length > 0 && ` ${request.autoMerged.length} other files merged on their own.`}
                </span>
                <button onClick={() => onDone("skip")} title="Leave this item and everything after it out; they stay selected for next time">
                    Stop and create PR up to here
                </button>
                <button className="cpp-primary" disabled={unresolved > 0} onClick={commitResolution}>
                    Commit and continue
                </button>
            </footer>
        </div>
    );
}

function TextConflict({ file, model, labels }: { file: ConflictFile; model: monaco.editor.ITextModel; labels: ConflictRequest["labels"] }) {
    const diffHost = useRef<HTMLDivElement>(null);
    const resultHost = useRef<HTMLDivElement>(null);
    const resultEditor = useRef<monaco.editor.IStandaloneCodeEditor>();
    const [blockIndex, setBlockIndex] = useState(0);
    const [blocks, setBlocks] = useState<Block[]>(() => findBlocks(model));

    useEffect(() => {
        const theme = isDark() ? "vs-dark" : "vs";
        const language = model.getLanguageId();
        const original = monaco.editor.createModel(file.current ?? "", language);
        const modified = monaco.editor.createModel(file.incoming ?? "", language);
        const diff = monaco.editor.createDiffEditor(diffHost.current!, { readOnly: true, automaticLayout: true, theme, renderSideBySide: true, originalEditable: false });
        diff.setModel({ original, modified });

        const editor = monaco.editor.create(resultHost.current!, { model, automaticLayout: true, theme, minimap: { enabled: false } });
        resultEditor.current = editor;
        let decorations = editor.createDecorationsCollection();
        const refresh = () => {
            const found = findBlocks(model);
            setBlocks(found);
            decorations.set(found.flatMap(blockDecorations));
        };
        refresh();
        const subscription = model.onDidChangeContent(refresh);
        reveal(editor, findBlocks(model)[0]);

        return () => {
            subscription.dispose();
            decorations.clear();
            editor.dispose();
            diff.dispose();
            original.dispose();
            modified.dispose();
        };
    }, [file, model]);

    const current = blocks[Math.min(blockIndex, blocks.length - 1)];
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
        const kept = side === "current" ? currentLines : side === "incoming" ? incomingLines : [...currentLines, ...incomingLines];
        const eol = model.getEOL();
        const lastLine = current.end === model.getLineCount();
        const range = lastLine
            ? new monaco.Range(current.start, 1, current.end, model.getLineMaxColumn(current.end))
            : new monaco.Range(current.start, 1, current.end + 1, 1);
        const text = kept.length === 0 ? "" : kept.join(eol) + (lastLine ? "" : eol);
        model.pushEditOperations([], [{ range, text }], () => null);
        // The next block moves into this one's place.
        setTimeout(() => reveal(resultEditor.current!, findBlocks(model)[Math.min(blockIndex, Math.max(0, findBlocks(model).length - 1))]));
    };

    return (
        <div className="cpp-conflict-text">
            <div className="cpp-conflict-labels">
                <span>Current: {labels.current}</span>
                <span>Incoming: {labels.incoming}</span>
            </div>
            <div className="cpp-conflict-diff" ref={diffHost} />
            <div className="cpp-conflict-toolbar">
                <span className="cpp-meta">{blocks.length === 0 ? "No conflicts left in this file." : `Conflict ${Math.min(blockIndex, blocks.length - 1) + 1} of ${blocks.length} in ${file.path}`}</span>
                <button disabled={blocks.length < 2} onClick={() => go(blockIndex - 1)}>Prev</button>
                <button disabled={blocks.length < 2} onClick={() => go(blockIndex + 1)}>Next</button>
                <button disabled={!current} onClick={() => take("current")}>Take current</button>
                <button disabled={!current} onClick={() => take("incoming")}>Take incoming</button>
                <button disabled={!current} onClick={() => take("both")}>Take both</button>
            </div>
            <div className="cpp-conflict-labels">
                <span>Result (editable)</span>
            </div>
            <div className="cpp-conflict-result" ref={resultHost} />
        </div>
    );
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

/** Conflict blocks as 1-based line numbers of their <<<<<<<, ======= and >>>>>>> lines. */
function findBlocks(model: monaco.editor.ITextModel): Block[] {
    const blocks: Block[] = [];
    let start = 0;
    let middle = 0;
    model.getLinesContent().forEach((line, i) => {
        const number = i + 1;
        if (line.startsWith(conflictStart)) {
            start = number;
            middle = 0;
        } else if (start && !middle && line === conflictMiddle) {
            middle = number;
        } else if (start && middle && line.startsWith(conflictEnd)) {
            blocks.push({ start, middle, end: number });
            start = 0;
        }
    });
    return blocks;
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
