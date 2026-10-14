import * as esbuild from "esbuild";
import { cpSync, mkdirSync, rmSync } from "node:fs";

const targets = {
    extension: { entry: "src/hosts/extension.tsx", page: "static/index.html" },
    standalone: { entry: "src/hosts/standalone.tsx", page: "static/index.html" }
};

const requested = process.argv.slice(2);
const names = requested.length > 0 ? requested : Object.keys(targets);

// esbuild puts CSS from lazily loaded chunks into the entry's CSS, which would load Monaco's 1 MB of styles at
// startup. So the app build skips Monaco's CSS, and a separate build makes editor.css for the conflict editor to link.
const skipMonacoCss = {
    name: "skip-monaco-css",
    setup(build) {
        build.onLoad({ filter: /monaco-editor[\\/].*\.css$/ }, () => ({ contents: "", loader: "css" }));
    }
};

for (const name of names) {
    const target = targets[name];
    if (!target) throw new Error(`Unknown target ${name}`);
    const outdir = `dist/${name}`;
    rmSync(outdir, { recursive: true, force: true });
    mkdirSync(outdir, { recursive: true });

    // ES modules with splitting, so the conflict editor (Monaco) loads only when it opens.
    await esbuild.build({
        entryPoints: { app: target.entry },
        outdir,
        bundle: true,
        minify: true,
        sourcemap: true,
        format: "esm",
        splitting: true,
        target: "es2020",
        jsx: "automatic",
        plugins: [skipMonacoCss],
        logLevel: "warning"
    });

    // Monaco's styles and icon font. Only the CSS is kept; the script it makes along the way is dropped.
    await esbuild.build({
        entryPoints: { editor: "src/ui/monaco.ts" },
        outdir,
        bundle: true,
        minify: true,
        format: "esm",
        target: "es2020",
        loader: { ".ttf": "file" },
        assetNames: "assets/[name]-[hash]",
        logLevel: "warning"
    });
    rmSync(`${outdir}/editor.js`);

    // Monaco's web worker, loaded by the conflict editor.
    await esbuild.build({
        entryPoints: { "editor.worker": "monaco-editor/editor/editor.worker" },
        outdir,
        bundle: true,
        minify: true,
        format: "iife",
        target: "es2020",
        logLevel: "warning"
    });

    cpSync(target.page, `${outdir}/index.html`);
}

// The extension manifest can only reference files under web/, so bring the license in.
cpSync("../LICENSE", "dist/LICENSE");
