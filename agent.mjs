// The agent: does the whole intake check as a sequence of tool calls, resolves what it can WITH evidence,
// drafts the follow-ups, and leaves a person only the decisions. Rule-driven today; no language model runs here.
// Each step is recorded so the run is auditable.
import { alnum } from "./parser.mjs";
import { compareSets } from "./compare.mjs";

const tokens = (s) => new Set(String(s ?? "").toUpperCase().match(/[A-Z0-9]+/g) ?? []);
// Same words, ignoring case and punctuation. Deliberately not fuzzy: "ENLARGED FRAMING PLAN" is not "FRAMING PLAN".
const sameTitle = (a, b) => { const A = tokens(a), B = tokens(b); return A.size > 0 && A.size === B.size && [...A].every((t) => B.has(t)); };
const ROLE = { G: "the design team lead", C: "the civil engineer", L: "the landscape architect", A: "the architect", I: "the interior designer", S: "the structural engineer", M: "the mechanical engineer", E: "the electrical engineer", P: "the plumbing engineer", F: "the fire protection engineer" };
const role = (num) => ROLE[(num ?? "G")[0]] ?? "the design team";

export function runAgent({ pages, res }, prevCtx) {
  const trace = [];
  const t0 = performance.now();
  const step = (tool, input, fn) => { const s = performance.now(); const out = fn(); trace.push({ tool, input, output: out.summary, ms: Math.max(1, Math.round(performance.now() - s)) }); return out; };

  step("read_title_blocks", `${pages.length} pages`, () => ({ summary: `${res.summary.ok} sheets read from labelled fields, ${res.summary.review} uncertain, ${res.summary.unreadable} unreadable` }));

  // A problem flagged on a page is a decision for a person, however cleanly the page itself was read.
  const openOn = (page) => res.issues.filter((i) => i.pages?.includes(page));

  // 1. Resolve uncertain sheets against the index, with evidence. Never resolves the revision,
  //    and never confirms a sheet that has a problem open or a revision the index contradicts.
  const resolved = [];
  step("reconcile_with_index", `${res.summary.review} uncertain sheets`, () => {
    if (!res.index) return { summary: "no sheet index found, nothing to reconcile against" };
    const rows = new Map(res.index.rows.map((r) => [r.key, r]));
    for (const s of res.sheets) {
      if (s.status !== "review" || !s.number || openOn(s.page).length) continue;
      const row = rows.get(alnum(s.number));
      const revOk = s.conf.revision === "high" && !s.revisionBlank;
      if (!row || !revOk) continue;
      if (s.conf.number === "high" && s.conf.title === "high") continue;
      if (row.rev != null && s.revision !== row.rev) continue;
      if (sameTitle(s.title, row.title)) {
        s.status = "ok"; s.resolvedBy = "agent"; s.reasons = [];
        s.evidence = row.rev != null
          ? `Number ${s.number}, title and revision ${s.revision} all match index row "${row.number} · ${row.title}".`
          : `Number ${s.number} and title match index row "${row.number} · ${row.title}". The index lists no revision, so revision ${s.revision} comes from the labelled field only.`;
        resolved.push(s);
      }
    }
    return { summary: `${resolved.length} sheets confirmed because number, title and revision match the index row and no problem is open` };
  });

  step("cross_check_set", "numbers, series, revisions, index", () => {
    let held = 0;
    for (const s of res.sheets) {
      const open = openOn(s.page);
      if (!open.length || s.unreadable) continue;
      if (s.status === "ok") { s.status = "review"; held++; }
      s.reasons = [...s.reasons, ...open.filter((i) => !s.reasons.includes(i.detail)).map((i) => i.detail)];
    }
    return { summary: `${res.issues.filter((i) => i.type !== "no_index_found").length} problems found${held ? `, ${held} otherwise clean sheets held for a person because of them` : ""}` };
  });
  res.summary = { pages: res.sheets.length, ok: res.sheets.filter((s) => s.status === "ok").length, review: res.sheets.filter((s) => s.status === "review").length, unreadable: res.sheets.filter((s) => s.status === "unreadable").length };

  let cmp = null;
  if (prevCtx) cmp = step("compare_issues", "previous issue vs this one", () => { const c = compareSets(prevCtx, { pages, res }); return { ...c, summary: `${c.changes.length} changes: ${Object.entries(c.counts).map(([k, v]) => `${v} ${k.replace(/_/g, " ")}`).join(", ") || "none"}` }; });

  // 2. Draft the follow-ups a person would otherwise write by hand, grouped by who has to answer.
  const asks = new Map();
  const ask = (num, line) => { const r = role(num); asks.set(r, [...(asks.get(r) ?? []), line]); };
  for (const i of res.issues) {
    const n = i.sheet;
    if (i.type === "duplicate_number") ask(n, `Sheet number ${n} is used on pages ${i.pages.join(" and ")}. Which one is correct, and what is the other one numbered?`);
    if (i.type === "not_in_index") ask(n, `Sheet ${n} is in the set but missing from the sheet index. Please reissue the index.`);
    if (i.type === "index_revision_conflict") ask(n, `${n}: ${i.detail} Which is current?`);
    if (i.type === "index_title_conflict") ask(n, `${n}: ${i.detail}`);
    if (i.type === "missing_revision") ask(n, `${n} has no revision marked. What revision is it?`);
    if (i.type === "possible_gap") ask(n, `${n} is skipped in its series. Is a sheet missing from this issue, or is that intentional?`);
    if (i.type === "index_row_unmatched") ask(n, `${n} is listed in the index but we could not find it in the set.`);
  }
  if (cmp) for (const c of cmp.changes) {
    if (c.kind === "unmarked_change") ask(c.sheet, `${c.sheet} ${c.title ?? ""}: content changed but the revision was not raised. What changed, and should it carry a revision?`);
    if (c.kind === "bump_no_change") ask(c.sheet, `${c.sheet} was raised ${c.was ?? "blank"} → ${c.now ?? "blank"} but we found no text change. What changed?`);
    if (c.kind === "removed") ask(c.sheet, `${c.sheet} ${c.title ?? ""} is no longer in the set. Confirm it was deleted on purpose.`);
  }
  const drafts = [...asks].map(([who, lines]) => ({ to: who, body: `Hi,\n\nWhile checking the latest issue we found ${lines.length} item${lines.length > 1 ? "s" : ""} for ${who}:\n\n${lines.map((l, i) => `${i + 1}. ${l}`).join("\n")}\n\nCould you confirm or reissue as needed?\n\nThanks` }));
  step("draft_followups", `${asks.size} recipients`, () => ({ summary: `${drafts.length} messages drafted for you to review and send` }));

  const left = res.sheets.filter((s) => s.status !== "ok");
  const summary = { sheets: pages.length, readConfident: res.summary.ok - resolved.length, agentConfirmed: resolved.length, leftForYou: left.length, problems: res.issues.filter((i) => i.type !== "no_index_found").length, drafts: drafts.length, changes: cmp?.changes.length ?? null, ms: Math.round(performance.now() - t0) };
  return { trace, resolved, drafts, cmp, left, summary };
}
