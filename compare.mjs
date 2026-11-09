// Set-to-set check: what changed between two issues of the same drawing set, and did the revision marks tell the truth?
// Deterministic. Compares the text each sheet carries (outside the fields the parser read), not pixels.
import { alnum } from "./parser.mjs";

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function signature(page, rec) {
  const skip = new Set(Object.values(rec.boxes ?? {}));
  const bag = new Map();
  for (const it of page.items) {
    if (skip.has(it) || DATE_RE.test(it.str)) continue;
    bag.set(it.str, (bag.get(it.str) ?? 0) + 1);
  }
  return bag;
}

function diffBags(a, b) {
  const added = [], removed = [];
  for (const [k, n] of b) { const d = n - (a.get(k) ?? 0); for (let i = 0; i < d; i++) added.push(k); }
  for (const [k, n] of a) { const d = n - (b.get(k) ?? 0); for (let i = 0; i < d; i++) removed.push(k); }
  return { added, removed };
}

const firstByKey = (res) => {
  const m = new Map();
  res.sheets.forEach((s) => { if (s.number && !m.has(alnum(s.number))) m.set(alnum(s.number), s); });
  return m;
};

/** prev/curr = { pages, res } where res = analyze(pages). Returns { changes, notComparable, counts }. */
export function compareSets(prev, curr) {
  const A = firstByKey(prev.res), B = firstByKey(curr.res);
  const indexPages = new Set([prev.res.index?.page, curr.res.index?.page].filter(Boolean));
  const changes = [], notComparable = [];
  for (const [k, b] of B) {
    const a = A.get(k);
    if (!a) { changes.push({ kind: "added", sheet: b.number, title: b.title, page: b.page, detail: "New in this issue." }); continue; }
    if (a.unreadable || b.unreadable) { notComparable.push({ sheet: b.number, page: b.page, detail: "A scanned page can't be compared." }); continue; }
    if (indexPages.has(b.page) && indexPages.has(a.page)) continue; // the index page itself is expected to change
    const d = diffBags(signature(prev.pages[a.page - 1], a), signature(curr.pages[b.page - 1], b));
    const textChanged = d.added.length + d.removed.length > 0;
    const revChanged = (a.revision ?? null) !== (b.revision ?? null);
    const rev = `Rev ${a.revision ?? "blank"} → ${b.revision ?? "blank"}`;
    const base = { sheet: b.number, title: b.title, page: b.page, was: a.revision, now: b.revision, added: d.added, removed: d.removed };
    if (textChanged && revChanged) changes.push({ ...base, kind: "revised", detail: `${rev}. Content changed, and the revision mark says so.` });
    else if (textChanged) changes.push({ ...base, kind: "unmarked_change", detail: `Content changed but the revision stayed at ${b.revision ?? "blank"}. Someone should confirm this is not an unmarked change.` });
    else if (revChanged) changes.push({ ...base, kind: "bump_no_change", detail: `${rev}, but no text change was found on the sheet. Graphic-only changes can't be seen by this check.` });
  }
  for (const [k, a] of A) if (!B.has(k)) changes.push({ kind: "removed", sheet: a.number, title: a.title, page: a.page, detail: "In the previous issue, not in this one." });
  const counts = {};
  for (const c of changes) counts[c.kind] = (counts[c.kind] ?? 0) + 1;
  return { changes, notComparable, counts };
}
