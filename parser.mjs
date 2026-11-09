// Sheet labeler core: deterministic, no network, no model calls.
// Input: pages from extract.mjs. Output: one record per page + document-level checks.
//
// Design rule: never guess silently. Every field carries a confidence:
//   high   = read from a labelled title-block field
//   medium = found by a pattern, no label (e.g. a number-shaped string in the title block)
//   low    = heuristic (largest text), likely wrong, needs a human
//   none   = not found
// A page is only "ok" when number and title are high and the revision field is present and filled.
// Everything else goes to the review queue.

export const DISCIPLINES = {
  G: "General", C: "Civil", L: "Landscape", A: "Architectural", I: "Interiors", S: "Structural",
  M: "Mechanical", E: "Electrical", P: "Plumbing", F: "Fire protection", FP: "Fire protection",
  T: "Telecom", D: "Demolition",
};

// Label vocabulary. Written from title-block families A-C of the synthetic sets only.
const LABEL = {
  number: /^(SHEET\s*(NO|NUMBER|#)\.?|DWG\.?\s*NO\.?)\s*:?$/i,
  title: /^(SHEET\s*TITLE|TITLE)\s*:?$/i,
  revision: /^(REV(ISION)?\.?(\s*NO\.?)?|ISSUE\s*(NO|NUMBER)\.?)\s*:?$/i, // ISSUE NO. added after first held-out run (see EVAL.md)
};
const OTHER_LABEL =
  /^(PROJECT(\s*NAME)?|DATE|DRAWN(\s*BY)?|CHECKED(\s*BY)?|SCALE|JOB(\s*NO\.?)?|ISSUE\s*DATE|CLIENT|SEAL)\s*:?$/i;
const COMBINED = {
  number: /^(?:SHEET\s*(?:NO|NUMBER)\.?|DWG\.?\s*NO\.?)\s*[:#]\s*(\S.*)$/i,
  revision: /^REV(?:ISION)?\.?\s*[:#]\s*(\S.*)$/i,
};
const REV_FALLBACK = /^REV(?:ISION)?\.?\s*:?\s*([A-Z0-9]{1,3})$/i;
const NUM_RE = /^([A-Z]{1,2})\s?[-.]?\s?(\d{1,3})(?:\.(\d{1,2}))?$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export const alnum = (s) => String(s ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");
const pad = (n, w) => String(n).padStart(w, "0");

export function parseNumber(s) {
  const m = NUM_RE.exec(String(s).trim().toUpperCase());
  if (!m) return null;
  const [, prefix, a, b] = m;
  if (b !== undefined) {
    const major = parseInt(a, 10), minor = parseInt(b, 10);
    return { display: `${prefix}${major}.${pad(minor, 2)}`, prefix, major, minor, style: "dot" };
  }
  if (a.length === 3) {
    const n = parseInt(a, 10);
    return { display: `${prefix}-${a}`, prefix, major: Math.floor(n / 100), minor: n % 100, style: "dash" };
  }
  return { display: `${prefix}-${a}`, prefix, major: parseInt(a, 10), minor: 0, style: "other" };
}

export function parseRevision(s) {
  if (s == null) return { value: null, blank: true };
  let v = String(s).trim().toUpperCase();
  if (/^[-–—_.\s]*$/.test(v) || /^(NONE|N\/A|NA)$/.test(v)) return { value: null, blank: true };
  v = v.replace(/^REV(ISION)?\.?\s*:?\s*/, "").replace(/^R(?=\d)/, "");
  if (/^\d+$/.test(v)) v = String(parseInt(v, 10));
  if (!/^[A-Z0-9]{1,3}$/.test(v)) return { value: null, blank: false, invalid: true };
  return { value: v, blank: false };
}

const isLabel = (it) =>
  LABEL.number.test(it.str) || LABEL.title.test(it.str) || LABEL.revision.test(it.str) || OTHER_LABEL.test(it.str);

// Where a title block can live: anywhere in the bottom 45% or the right-hand 22% of the sheet.
const inTitleRegion = (it, W, H) => it.x > 0.78 * W || it.y < 0.45 * H;

// Find the value belonging to a label: same line to its right, else directly below it.
function valueFor(lb, items, W, H) {
  const lh = lb.h || 7;
  const right = items
    .filter(
      (it) =>
        it !== lb &&
        Math.abs(it.y - lb.y) <= Math.max(2, lh * 0.6) &&
        it.x >= lb.x + lb.w - 1 &&
        it.x - (lb.x + lb.w) < 0.25 * W
    )
    .sort((a, b) => a.x - b.x);
  if (right.length && !isLabel(right[0])) return { item: right[0], mode: "right" };
  const below = items
    .filter(
      (it) =>
        it !== lb &&
        it.y < lb.y - 0.3 * lh &&
        lb.y - it.y <= 0.06 * H &&
        it.x >= lb.x - 12 &&
        it.x <= lb.x + Math.max(lb.w, 0.12 * W)
    )
    .map((it) => ({ it, score: lb.y - it.y + 0.8 * Math.abs(it.x - lb.x) }))
    .sort((a, b) => a.score - b.score);
  if (below.length && !isLabel(below[0].it)) return { item: below[0].it, mode: "below" };
  return null;
}

// Join wrapped lines that continue a value (same left edge, tight line spacing).
function withContinuation(first, items) {
  const lines = [first.str];
  let cur = first;
  for (let k = 0; k < 3; k++) {
    const next = items
      .filter(
        (it) =>
          it !== cur && !isLabel(it) && Math.abs(it.x - first.x) <= 15 &&
          it.y < cur.y - 0.2 * cur.h && cur.y - it.y <= 1.8 * cur.h + 2
      )
      .sort((a, b) => b.y - a.y)[0];
    if (!next) break;
    lines.push(next.str);
    cur = next;
  }
  return lines.join(" ");
}

export function parsePage(page) {
  const { width: W, height: H } = page;
  const region = page.items.filter((it) => inTitleRegion(it, W, H));
  const rec = {
    page: page.index, number: null, numInfo: null, title: null, revision: null, discipline: null,
    conf: { number: "none", title: "none", revision: "none" },
    revisionBlank: false, unreadable: false, reasons: [], status: "review", boxes: {},
  };

  if (page.items.length === 0 || region.length < 2) {
    rec.unreadable = true;
    rec.status = "unreadable";
    rec.reasons.push("No text layer in the title block (scan or image-only). Needs OCR or manual entry.");
    return rec;
  }

  // ---- sheet number
  for (const lb of region.filter((it) => LABEL.number.test(it.str) || COMBINED.number.test(it.str))) {
    const comb = COMBINED.number.exec(lb.str);
    const vf = comb ? null : valueFor(lb, region, W, H);
    const raw = comb ? comb[1] : vf?.item.str;
    const n = raw && parseNumber(raw);
    if (n) { rec.number = n.display; rec.numInfo = n; rec.conf.number = "high"; rec.boxes.number = comb ? lb : vf.item; break; }
  }
  if (!rec.number) {
    const cands = region
      .filter((it) => parseNumber(it.str))
      .sort((a, b) => b.h - a.h);
    if (cands.length) {
      const n = parseNumber(cands[0].str);
      rec.number = n.display; rec.numInfo = n; rec.conf.number = "medium"; rec.boxes.number = cands[0];
    }
  }
  if (rec.numInfo) rec.discipline = DISCIPLINES[rec.numInfo.prefix] ?? DISCIPLINES[rec.numInfo.prefix[0]] ?? null;

  // ---- title
  for (const lb of region.filter((it) => LABEL.title.test(it.str))) {
    const v = valueFor(lb, region, W, H);
    if (v) { rec.title = withContinuation(v.item, region); rec.conf.title = "high"; rec.boxes.title = v.item; break; }
  }
  if (!rec.title) {
    const cands = region
      .filter((it) => !isLabel(it) && !parseNumber(it.str) && !DATE_RE.test(it.str) && /[A-Z]{2}/i.test(it.str) && it.str.length >= 4)
      .sort((a, b) => b.h - a.h);
    if (cands.length) { rec.title = withContinuation(cands[0], region); rec.conf.title = "low"; rec.boxes.title = cands[0]; }
  }

  // ---- revision
  let revLabelSeen = false;
  for (const lb of region.filter((it) => LABEL.revision.test(it.str) || COMBINED.revision.test(it.str))) {
    revLabelSeen = true;
    const comb = COMBINED.revision.exec(lb.str);
    const vf = comb ? null : valueFor(lb, region, W, H);
    const raw = comb ? comb[1] : vf?.item.str ?? null;
    const r = parseRevision(raw);
    if (r.value) { rec.revision = r.value; rec.conf.revision = "high"; rec.revisionBlank = false; rec.boxes.revision = comb ? lb : vf.item; break; }
    rec.conf.revision = "high"; rec.revisionBlank = true; rec.boxes.revisionLabel = lb;
  }
  if (!revLabelSeen) {
    for (const it of region) {
      const m = REV_FALLBACK.exec(it.str);
      if (m) { rec.revision = parseRevision(m[1]).value; rec.conf.revision = "medium"; rec.boxes.revision = it; break; }
    }
  }

  // ---- verdict
  if (rec.conf.number !== "high") rec.reasons.push(rec.number ? "Sheet number found without a label: confirm." : "Sheet number not found.");
  if (rec.conf.title !== "high") rec.reasons.push(rec.title ? "Title guessed from the largest text: confirm." : "Title not found.");
  if (rec.conf.revision === "none") rec.reasons.push("No revision field found.");
  else if (rec.revisionBlank) rec.reasons.push("Revision field is blank.");
  else if (rec.conf.revision !== "high") rec.reasons.push("Revision found without a label: confirm.");
  rec.status = rec.reasons.length ? "review" : "ok";
  return rec;
}

// ---- sheet index detection and parsing
function findIndex(pages) {
  let best = null;
  for (const p of pages) {
    const tbl = p.items.filter((it) => it.x < 0.7 * p.width && it.y > 0.12 * p.height);
    const nums = tbl.filter((it) => parseNumber(it.str));
    if (nums.length >= 8 && (!best || nums.length > best.n)) best = { p, tbl, n: nums.length };
  }
  if (!best) return null;
  const rows = [];
  const sorted = [...best.tbl].sort((a, b) => b.y - a.y || a.x - b.x);
  const clusters = [];
  for (const it of sorted) {
    const last = clusters[clusters.length - 1];
    if (last && Math.abs(last[0].y - it.y) <= Math.max(3, it.h * 0.5)) last.push(it);
    else clusters.push([it]);
  }
  for (const cl of clusters) {
    cl.sort((a, b) => a.x - b.x);
    const num = parseNumber(cl[0].str);
    if (!num) continue;
    // Index cells share one font size. Drop same-line strays (watermarks, keynotes) with a different size.
    const sameSize = cl.filter((i) => Math.abs(i.h - cl[0].h) <= 1.5);
    cl.length = 0; cl.push(...sameSize);
    if (cl.length < 2) continue;
    let revRaw = null, mid = cl.slice(1);
    if (cl.length >= 3 && /^(\d{1,2}|[A-Z])$/i.test(cl[cl.length - 1].str)) {
      revRaw = cl[cl.length - 1].str; mid = cl.slice(1, -1);
    }
    rows.push({ number: num.display, key: alnum(num.display), title: mid.map((i) => i.str).join(" "), rev: parseRevision(revRaw).value });
  }
  return { page: best.p.index, rows };
}

const tokens = (s) => new Set(String(s).toUpperCase().match(/[A-Z0-9]+/g) ?? []);
function jaccard(a, b) {
  const A = tokens(a), B = tokens(b);
  if (!A.size && !B.size) return 1;
  let inter = 0;
  for (const t of A) if (B.has(t)) inter++;
  return inter / (A.size + B.size - inter);
}

export function analyze(pages) {
  const sheets = pages.map(parsePage);
  const index = findIndex(pages);
  const issues = [];
  const push = (type, sheet, severity, detail, pagesAffected) => issues.push({ type, sheet, severity, detail, pages: pagesAffected });

  // unreadable pages
  for (const s of sheets) if (s.unreadable) push("unreadable_page", `page:${s.page}`, "warn", s.reasons[0], [s.page]);

  // duplicate numbers
  const byKey = new Map();
  for (const s of sheets) if (s.number) {
    const k = alnum(s.number);
    byKey.set(k, [...(byKey.get(k) ?? []), s]);
  }
  for (const list of byKey.values()) if (list.length > 1)
    push("duplicate_number", list[0].number, "error", `Sheet number used on pages ${list.map((s) => s.page).join(", ")}.`, list.map((s) => s.page));

  // numbering gaps inside a series (A-101, A-103 -> A-102 missing?)
  const series = new Map();
  for (const s of sheets) if (s.numInfo) {
    const { prefix, major, style } = s.numInfo;
    const k = `${prefix}|${style}|${major}`;
    series.set(k, [...(series.get(k) ?? []), s.numInfo]);
  }
  for (const list of series.values()) {
    const minors = [...new Set(list.map((n) => n.minor))].sort((a, b) => a - b);
    for (let i = 1; i < minors.length; i++) {
      const d = minors[i] - minors[i - 1];
      if (d >= 2 && d <= 3) for (let m = minors[i - 1] + 1; m < minors[i]; m++) {
        const { prefix, major, style } = list[0];
        const disp = style === "dot" ? `${prefix}${major}.${pad(m, 2)}` : `${prefix}-${major * 100 + m}`;
        push("possible_gap", disp, "info", `${disp} is skipped between ${minors[i - 1]} and ${minors[i]} in its series. Intentional?`, []);
      }
    }
  }

  // blank / missing revision
  for (const s of sheets) if (!s.unreadable && s.revision == null && s.conf.revision === "high") { // only when a revision field was found and is empty
    const row = index?.rows.find((r) => s.number && r.key === alnum(s.number));
    push("missing_revision", s.number ?? `page:${s.page}`, "warn",
      row?.rev != null ? `No revision on the sheet; the index says Rev ${row.rev}.` : "No revision on the sheet.", [s.page]);
  }

  // index cross-checks
  if (index) {
    const first = new Map();
    for (const s of sheets) if (s.number && !first.has(alnum(s.number))) first.set(alnum(s.number), s);
    const rowKeys = new Set(index.rows.map((r) => r.key));
    const unreadable = sheets.filter((s) => s.unreadable).length;
    for (const r of index.rows) {
      const s = first.get(r.key);
      if (!s) {
        push("index_row_unmatched", r.number, "info",
          unreadable ? `Listed in the index but no readable sheet has this number. ${unreadable} unreadable page(s) may be it.` : "Listed in the index but no sheet in this set has this number.", []);
        continue;
      }
      if (s.revision != null && r.rev != null && s.revision !== r.rev)
        push("index_revision_conflict", s.number, "error", `Index says Rev ${r.rev}, title block says Rev ${s.revision}.`, [s.page]);
      if (s.title && jaccard(s.title, r.title) < 0.6)
        push("index_title_conflict", s.number, "warn", `Index title "${r.title}" differs from title block "${s.title}".`, [s.page]);
    }
    for (const [k, s] of first) if (!rowKeys.has(k)) push("not_in_index", s.number, "warn", "Sheet exists but is not listed in the sheet index.", [s.page]);
  } else {
    push("no_index_found", "-", "info", "No sheet index page detected, so index cross-checks were skipped.", []);
  }

  const count = (st) => sheets.filter((s) => s.status === st).length;
  return {
    sheets, index, issues,
    summary: { pages: sheets.length, ok: count("ok"), review: count("review"), unreadable: count("unreadable") },
  };
}
