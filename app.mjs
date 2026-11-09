import * as pdfjs from "pdfjs-dist";
import { extractPages } from "./extract.mjs";
import { analyze, alnum } from "./parser.mjs";
import { runAgent } from "./agent.mjs";

pdfjs.GlobalWorkerOptions.workerSrc = URL.createObjectURL(new Blob([window.PDF_WORKER_SRC], { type: "text/javascript" }));

const $ = (id) => document.getElementById(id);
const el = (tag, props = {}, ...kids) => { const e = Object.assign(document.createElement(tag), props); e.append(...kids); return e; };
const TYPE = {
  duplicate_number: "Duplicate sheet number", possible_gap: "Skipped sheet number", missing_revision: "Revision blank",
  index_row_unmatched: "In the index, not in the set", index_revision_conflict: "Revision disagrees with index",
  index_title_conflict: "Title disagrees with index", not_in_index: "Sheet missing from the index",
  unreadable_page: "Page can't be read", no_index_found: "No sheet index found",
};
const st = { doc: null, res: null, page: 1, tab: "issues", name: "", isSample: false, sel: null, token: 0, agent: null, pages: null, prevName: "" };

// ---------- load
async function read(buf, label) {
  const doc = await pdfjs.getDocument({ data: new Uint8Array(buf) }).promise;
  const pages = await extractPages(doc, (i, n) => ($("status").textContent = `${label}: reading sheet ${i} of ${n}…`));
  return { doc, pages, res: analyze(pages) };
}
async function load(buf, name, isSample, prevBuf, prevName) {
  $("status").textContent = "Reading the set…";
  try {
    const prev = prevBuf ? await read(prevBuf, "Previous issue") : null;
    const cur = await read(buf, name);
    const agent = runAgent({ pages: cur.pages, res: cur.res }, prev && { pages: prev.pages, res: prev.res });
    Object.assign(st, { doc: cur.doc, res: cur.res, pages: cur.pages, agent, name, isSample, tab: "issues", sel: null, prevName: prevName ?? "" });
    const rank = { error: 0, warn: 1, info: 2 };
    const first = [...st.res.issues].sort((x, y) => rank[x.severity] - rank[y.severity]).find((i) => i.pages?.length);
    st.page = first ? first.pages[0] : 1; st.sel = first ?? null;
    $("status").textContent = `${name}${prev ? " vs " + prevName : ""} · ${cur.pages.length} sheets, read in your browser`;
    $("app").hidden = false; $("cmp-btn").hidden = !!prev;
    renderAgent(); renderScore(); renderList(); show(st.page);
  } catch (e) {
    console.error(e);
    $("status").textContent = "Could not read that file. Is it a valid PDF that isn't password-protected?";
  }
}
const b64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0)).buffer;
const loadSample = () => load(b64(window.SAMPLE_ISSUE2_B64), "Issue 2 (sample)", true, b64(window.SAMPLE_ISSUE1_B64), "Issue 1 (sample)");

// ---------- agent
function renderAgent() {
  const a = st.agent, s = a.summary;
  $("agent-sum").replaceChildren(...[[s.sheets, "sheets read"], [s.agentConfirmed, "confirmed by the agent, with evidence"], [s.problems + (s.changes ?? 0), "problems and changes found"], [s.drafts, "follow-ups drafted"], [s.leftForYou, "left for you"]]
    .map(([n, l]) => el("div", { className: "as" }, el("b", { textContent: n }), el("span", { textContent: l }))));
  $("trace").replaceChildren(...a.trace.map((t) => el("li", {}, el("code", { textContent: `${t.tool}(${t.input})` }), el("span", { textContent: t.output }), el("em", { textContent: `${t.ms} ms` }))));
  $("agent-note").textContent = `Finished in ${s.ms} ms, in your browser. Rule-driven: no language model ran. It confirms a sheet only when number, title and a labelled revision agree with the index and no problem is open on that sheet. A sheet with an open problem stays with you, however cleanly it was read, and it never resolves a revision for you.`;
}

// ---------- scoreboard
function renderScore() {
  const { summary: s, issues } = st.res;
  const real = issues.filter((i) => i.type !== "no_index_found");
  const cards = [[s.pages, "sheets"], [s.ok, "read with confidence"], [s.review + s.unreadable, "need a human"], [real.length, "problems flagged"]];
  const box = $("score");
  box.replaceChildren(...cards.map(([n, l]) => el("div", { className: "sc" }, el("b", { textContent: n }), el("span", { textContent: l }))));
  if (st.isSample) {
    const want = window.SAMPLE_TRUTH.issues.map((i) => `${i.type}|${alnum(i.sheet)}`);
    const got = new Set(issues.map((i) => `${i.type}|${alnum(i.sheet)}`));
    const hit = want.filter((w) => got.has(w)).length;
    const exp = window.SAMPLE_CHANGES, cm = st.agent.cmp;
    if (exp && cm) {
      const wantC = ["revised", "unmarked_change", "bump_no_change", "added", "removed"].flatMap((k) => (exp[k] ?? []).map((n) => `${k}|${alnum(n)}`));
      const gotC = new Set(cm.changes.map((c) => `${c.kind}|${alnum(c.sheet)}`));
      box.append(el("div", { className: "sc proof" }, el("b", { textContent: `${wantC.filter((w) => gotC.has(w)).length} of ${wantC.length}` }), el("span", { textContent: "planted changes between the two issues found: a revision with real changes, a change nobody marked, a revision bump with no change, a sheet added, a sheet removed." })));
    }
    box.append(el("div", { className: "sc proof" }, el("b", { textContent: `${hit} of ${want.length}` }), el("span", { textContent: "planted problems found in this sample (duplicate number, skipped number, blank revision, index mismatch, unlisted sheet, two scans). Known answers, so this one is checkable." })));
  }
}

// ---------- list
function renderList() {
  const { issues, sheets } = st.res;
  $("n-issues").textContent = issues.length; $("n-sheets").textContent = sheets.length;
  const cm = st.agent.cmp, drafts = st.agent.drafts;
  $("n-changes").textContent = cm ? cm.changes.length : "–"; $("n-drafts").textContent = drafts.length;
  for (const t of ["issues", "changes", "sheets", "drafts"]) $("tab-" + t).setAttribute("aria-selected", st.tab === t);
  $("only-wrap").hidden = st.tab !== "sheets";
  const items = [];
  if (st.tab === "changes") {
    if (!cm) items.push(el("li", {}, el("div", { className: "empty", textContent: "Add the previous issue to see what changed, and whether the revision marks tell the truth." }), el("button", { className: "btn small", type: "button", textContent: "Choose previous issue", onclick: () => $("prev-file").click() })));
    else {
      const KIND = { revised: "Revised", unmarked_change: "Changed, not marked", bump_no_change: "Revision raised, no change found", added: "Added", removed: "Removed" };
      const SEV = { unmarked_change: "error", bump_no_change: "warn", removed: "warn", added: "info", revised: "ok" };
      const ord = { unmarked_change: 0, bump_no_change: 1, removed: 2, added: 3, revised: 4 };
      [...cm.changes].sort((a, b) => ord[a.kind] - ord[b.kind]).forEach((c) => {
        const b = el("button", { type: "button" }, el("span", { className: "k", textContent: KIND[c.kind] }), el("span", { className: "t num", textContent: `${c.sheet}${c.title ? " · " + c.title : ""}` }), el("span", { className: "d", textContent: c.detail }));
        b.onclick = () => { st.sel = { ...c, change: true }; show(c.kind === "removed" ? st.page : c.page); renderList(); };
        if (st.sel?.change && st.sel.sheet === c.sheet && st.sel.kind === c.kind) b.setAttribute("aria-current", "true");
        items.push(el("li", { className: SEV[c.kind] }, b));
      });
      if (!cm.changes.length) items.push(el("li", { textContent: "No differences found." }));
    }
  } else if (st.tab === "drafts") {
    if (!drafts.length) items.push(el("li", { textContent: "Nothing to ask anyone." }));
    drafts.forEach((d) => {
      const pre = el("pre", { className: "draft", textContent: d.body });
      const cp = el("button", { className: "btn small", type: "button", textContent: "Copy" });
      cp.onclick = async () => { try { await navigator.clipboard.writeText(d.body); cp.textContent = "Copied"; } catch { const r = document.createRange(); r.selectNodeContents(pre); getSelection().removeAllRanges(); getSelection().addRange(r); cp.textContent = "Selected: press copy"; } };
      items.push(el("li", { className: "info card-li" }, el("span", { className: "k", textContent: `To ${d.to}` }), pre, cp));
    });
  } else
  if (st.tab === "issues") {
    const order = { error: 0, warn: 1, info: 2 };
    [...issues].sort((a, b) => order[a.severity] - order[b.severity]).forEach((i) => {
      const b = el("button", { type: "button" }, el("span", { className: "k", textContent: i.severity }), el("span", { className: "t", textContent: TYPE[i.type] ?? i.type }), el("span", { className: "d", textContent: `${i.sheet && i.sheet !== "-" ? i.sheet + " · " : ""}${i.detail}` }));
      b.onclick = () => { st.sel = i; show(i.pages?.[0] ?? st.res.index?.page ?? st.page); renderList(); };
      b.dataset.sel = i === st.sel; if (i === st.sel) b.setAttribute("aria-current", "true");
      items.push(el("li", { className: i.severity }, b));
    });
    if (!issues.length) items.push(el("li", { textContent: "Nothing flagged." }));
  } else {
    const only = $("only-review").checked;
    sheets.filter((s) => !only || s.status !== "ok").forEach((s) => {
      const b = el("button", { type: "button" }, el("span", { className: "k", textContent: `page ${s.page} · ${s.status}` }), el("span", { className: "t num", textContent: s.number ?? "—" }), el("span", { className: "d", textContent: s.title ?? "no title found" }));
      b.onclick = () => { st.sel = null; show(s.page); };
      if (s.page === st.page) b.setAttribute("aria-current", "true");
      items.push(el("li", { className: s.status }, b));
    });
  }
  $("list").replaceChildren(...items);
}

// ---------- viewer
const LAB = { number: "Sheet no.", title: "Title", revision: "Revision" };
async function show(n) {
  n = Math.max(1, Math.min(st.res.sheets.length, n)); st.page = n;
  const rec = st.res.sheets[n - 1];
  $("v-page").textContent = `Sheet ${n} of ${st.res.sheets.length}${rec.discipline ? " · " + rec.discipline : ""}`;
  $("v-title").textContent = rec.unreadable ? "Can't read this page" : `${rec.number ?? "No number"} — ${rec.title ?? "no title found"}`;
  $("fields").replaceChildren(...["number", "title", "revision"].map((f) => {
    const blank = f === "revision" && rec.revisionBlank;
    return el("div", { className: "fld" }, el("span", {}, LAB[f], el("span", { className: `chip ${rec.conf[f]}`, textContent: rec.conf[f] === "none" ? "not found" : rec.conf[f] === "high" ? "labelled" : "guessed" })), el("b", { textContent: blank ? "(blank)" : rec[f] ?? "—" }));
  }));
  const notes = [];
  const mine = st.res.issues.filter((i) => i.pages?.includes(n));
  mine.forEach((i) => notes.push(el("li", { className: i.severity }, el("b", { textContent: TYPE[i.type] ?? i.type }), i.detail)));
  if (rec.resolvedBy) notes.push(el("li", { className: "good" }, el("b", { textContent: "Confirmed by the agent" }), rec.evidence));
  if (st.sel?.change && st.sel.kind !== "removed") {
    const c = st.sel, sh = (a) => a.slice(0, 4).join(" · ") + (a.length > 4 ? ` … +${a.length - 4}` : "");
    notes.unshift(el("li", { className: c.kind === "unmarked_change" ? "error" : c.kind === "bump_no_change" ? "warn" : "info" }, el("b", { textContent: `Change vs previous issue: ${c.kind.replace(/_/g, " ")}` }), c.detail + (c.added?.length ? ` Now says: ${sh(c.added)}.` : "") + (c.removed?.length ? ` No longer says: ${sh(c.removed)}.` : "")));
  }
  rec.reasons.filter((r) => !mine.some((i) => i.detail === r)).forEach((r) => notes.push(el("li", { className: "reason" }, el("b", { textContent: "Why a person should look" }), r)));
  if (st.sel && !st.sel.change && !st.sel.pages?.length) notes.unshift(el("li", { className: st.sel.severity }, el("b", { textContent: TYPE[st.sel.type] ?? st.sel.type }), st.sel.detail + (st.res.index ? ` (Showing the sheet index, page ${st.res.index.page}.)` : "")));
  if (!notes.length) notes.push(el("li", { className: "good" }, el("b", { textContent: "Clean" }), "Read from labelled fields and consistent with the index."));
  $("notes").replaceChildren(...notes);
  $("fix").hidden = rec.status === "ok" && !rec.edited;
  $("f-number").value = rec.number ?? ""; $("f-title").value = rec.title ?? ""; $("f-rev").value = rec.revision ?? "";
  $("prev").disabled = n === 1; $("next").disabled = n === st.res.sheets.length;
  if (st.tab === "sheets") renderList();
  await draw(n, rec);
}

// One render per canvas at a time: cancel what is drawing, and treat a cancelled render as a quiet stop.
async function paint(task) {
  st.task = task;
  try { await task.promise; return true; }
  catch (e) { if (e?.name === "RenderingCancelledException") return false; throw e; }
}

async function draw(n, rec) {
  const token = ++st.token;
  const page = await st.doc.getPage(n);
  if (token !== st.token) return;
  if (st.task) { st.task.cancel(); await st.task.promise.catch(() => {}); st.task = null; if (token !== st.token) return; }
  const v1 = page.getViewport({ scale: 1 }); const W = v1.width, H = v1.height;
  const bx = Object.values(rec.boxes);
  let x0, x1, y0, y1; // PDF coords, y up
  if (bx.length) { x0 = Math.min(...bx.map((b) => b.x)); x1 = Math.max(...bx.map((b) => b.x + b.w)); y0 = Math.min(...bx.map((b) => b.y)); y1 = Math.max(...bx.map((b) => b.y + b.h)); }
  else { x0 = W * 0.55; x1 = W; y0 = 0; y1 = H * 0.3; }
  const padX = 120, padY = 70; x0 -= padX; x1 += padX; y0 -= padY; y1 += padY;
  const minW = 760, minH = 380;
  if (x1 - x0 < minW) { const c = (x0 + x1) / 2; x0 = c - minW / 2; x1 = c + minW / 2; }
  if (y1 - y0 < minH) { const c = (y0 + y1) / 2; y0 = c - minH / 2; y1 = c + minH / 2; }
  if (x0 < 0) { x1 -= x0; x0 = 0; } if (x1 > W) { x0 -= x1 - W; x1 = W; } x0 = Math.max(0, x0);
  if (y0 < 0) { y1 -= y0; y0 = 0; } if (y1 > H) { y0 -= y1 - H; y1 = H; } y0 = Math.max(0, y0);
  const cw = x1 - x0, ch = y1 - y0;
  const scale = Math.min(2.4, 1100 / cw);
  const vp = page.getViewport({ scale });
  const c = $("crop"); c.width = Math.round(cw * scale); c.height = Math.round(ch * scale);
  const left = x0 * scale, top = (H - y1) * scale;
  const ctx = c.getContext("2d"); ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, c.width, c.height);
  if (!(await paint(page.render({ canvasContext: ctx, viewport: vp, transform: [1, 0, 0, 1, -left, -top] }))) || token !== st.token) return;
  const ov = $("overlay"); ov.replaceChildren();
  for (const [k, b] of Object.entries(rec.boxes)) {
    if (!LAB[k]) continue;
    const d = el("div", { className: "box" + (rec.conf[k] === "high" ? "" : " low") }, el("i", { textContent: LAB[k] }));
    Object.assign(d.style, { left: `${(((b.x - x0) * scale - 3) / c.width) * 100}%`, top: `${(((H - b.y - b.h * 1.05) * scale - top - 2) / c.height) * 100}%`, width: `${((b.w * scale + 6) / c.width) * 100}%`, height: `${((b.h * 1.3 * scale + 4) / c.height) * 100}%` });
    ov.append(d);
  }
  // thumbnail of the whole sheet with the crop marked
  const t = $("thumb"); const ts = 176 / W; const tv = page.getViewport({ scale: ts });
  t.width = Math.round(tv.width); t.height = Math.round(tv.height);
  const tc = t.getContext("2d"); tc.fillStyle = "#fff"; tc.fillRect(0, 0, t.width, t.height);
  if (!(await paint(page.render({ canvasContext: tc, viewport: tv }))) || token !== st.token) return;
  Object.assign($("thumb-box").style, { left: `${(x0 / W) * 100}%`, top: `${((H - y1) / H) * 100}%`, width: `${(cw / W) * 100}%`, height: `${(ch / H) * 100}%` });
}

// ---------- events
$("choose").onclick = () => $("file").click();
$("file").onchange = async (e) => { const f = e.target.files[0]; if (f) { st.curBuf = await f.arrayBuffer(); load(st.curBuf.slice(0), f.name, false); } };
$("sample").onclick = loadSample;
for (const t of ["issues", "changes", "sheets", "drafts"]) $("tab-" + t).onclick = () => { st.tab = t; renderList(); };
$("cmp-btn").onclick = () => $("prev-file").click();
$("prev-file").onchange = async (e) => { const f = e.target.files[0]; if (f && st.res) { const cur = st.curBuf; if (cur) load(cur, st.name, false, await f.arrayBuffer(), f.name); } };
$("only-review").onchange = renderList;
$("prev").onclick = () => { st.sel = null; show(st.page - 1); };
$("next").onclick = () => { st.sel = null; show(st.page + 1); };
document.addEventListener("keydown", (e) => { if (!st.res || /INPUT|TEXTAREA/.test(document.activeElement?.tagName)) return; if (e.key === "ArrowRight") $("next").click(); if (e.key === "ArrowLeft") $("prev").click(); });
$("confirm").onclick = () => {
  const r = st.res.sheets[st.page - 1];
  r.number = $("f-number").value.trim() || null; r.title = $("f-title").value.trim() || null; r.revision = $("f-rev").value.trim() || null;
  Object.assign(r.conf, { number: "high", title: "high", revision: "high" });
  r.status = "ok"; r.unreadable = false; r.reasons = []; r.edited = true; r.revisionBlank = false;
  st.res.summary = { pages: st.res.sheets.length, ok: st.res.sheets.filter((s) => s.status === "ok").length, review: st.res.sheets.filter((s) => s.status === "review").length, unreadable: st.res.sheets.filter((s) => s.status === "unreadable").length };
  renderScore(); renderList(); show(st.page);
};
$("csv").onclick = () => {
  const q = (v) => `"${String(v ?? "").replace(/"/g, '""').replace(/^([=+\-@])/, "'$1")}"`;
  const rows = [["page", "sheet_number", "title", "revision", "discipline", "status", "notes"].join(",")];
  for (const r of st.res.sheets) rows.push([r.page, r.number, r.title, r.revision, r.discipline, r.status, r.reasons.join("; ")].map(q).join(","));
  const a = el("a", { href: URL.createObjectURL(new Blob([rows.join("\n")], { type: "text/csv" })), download: "sheet-log.csv" });
  a.click(); URL.revokeObjectURL(a.href);
};
let depth = 0;
addEventListener("dragenter", (e) => { e.preventDefault(); depth++; document.body.classList.add("dragging"); });
addEventListener("dragleave", () => { if (--depth <= 0) { depth = 0; document.body.classList.remove("dragging"); } });
addEventListener("dragover", (e) => e.preventDefault());
addEventListener("drop", async (e) => { e.preventDefault(); depth = 0; document.body.classList.remove("dragging"); const f = e.dataTransfer.files[0]; if (f && /pdf$/i.test(f.name)) { st.curBuf = await f.arrayBuffer(); load(st.curBuf.slice(0), f.name, false); } });

loadSample();
