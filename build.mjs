// Builds the deployable files so the page works from a double-click (file://) AND from a hosted link.
// Run: node prototype/build.mjs   (needs eval/node_modules: cd eval && npm install)
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "../eval/node_modules/esbuild/lib/main.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const pdfjsDir = path.join(here, "../eval/node_modules/pdfjs-dist/build");

await build({
  entryPoints: [path.join(here, "app.mjs")],
  bundle: true, format: "iife", minify: true, outfile: path.join(here, "app.bundle.js"),
  alias: { "pdfjs-dist": path.join(pdfjsDir, "pdf.min.mjs") }, logLevel: "warning",
});
// worker source as a string (workers cannot be fetched from file://), loaded as a Blob at runtime
const worker = fs.readFileSync(path.join(pdfjsDir, "pdf.worker.min.mjs"), "utf8");
fs.writeFileSync(path.join(here, "worker-src.js"), "window.PDF_WORKER_SRC=" + JSON.stringify(worker) + ";");
// sample PDF + its planted-problem key, embedded (fetch() of local files is blocked on file://)
const sets = path.join(here, "../eval/sets");
const i1 = fs.readFileSync(path.join(sets, "synthetic-03.pdf")).toString("base64");
const i2 = fs.readFileSync(path.join(sets, "synthetic-03-issue2.pdf")).toString("base64");
const truth = JSON.parse(fs.readFileSync(path.join(sets, "synthetic-03-issue2.truth.json")));
const changes = JSON.parse(fs.readFileSync(path.join(sets, "synthetic-03-issue2.compare.json")));
fs.writeFileSync(path.join(here, "sample-data.js"),
  `window.SAMPLE_ISSUE1_B64="${i1}";window.SAMPLE_ISSUE2_B64="${i2}";window.SAMPLE_TRUTH=${JSON.stringify({ issues: truth.issues })};window.SAMPLE_CHANGES=${JSON.stringify(changes)};`);
// fonts: vendored open-licence (OFL) variable fonts, inlined so no network and no file:// font restrictions
const fd = path.join(here, "../eval/node_modules/@fontsource-variable");
const face = (fam, f) => `@font-face{font-family:"${fam}";font-style:normal;font-weight:100 900;font-display:swap;src:url(data:font/woff2;base64,${fs.readFileSync(path.join(fd, f)).toString("base64")}) format("woff2")}`;
fs.writeFileSync(path.join(here, "fonts.css"), face("Inter", "inter/files/inter-latin-wght-normal.woff2") + "\n" + face("DM Sans", "dm-sans/files/dm-sans-latin-wght-normal.woff2"));
console.log("built: fonts.css, app.bundle.js, worker-src.js, sample-data.js");
