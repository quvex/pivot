// Reading the written reason on an injury report.
//
// The league's reports give a short free-text reason per player: "Injury/Illness - Left Knee;
// Meniscus Tear", "Return to Competition Reconditioning", "Right Heel; Enthesopathy". There are
// thousands of distinct wordings. A language model reads each one once and grades it (what kind of
// absence, which part of the body, how serious), and the grades are saved in reasons.json. What a
// grade is worth in games missed is then measured on past seasons (backtest.mjs), so the model's
// judgement is only ever used to sort reasons into groups, never to supply the numbers.
// A wording nobody has graded yet falls back to keyword rules until the next grading run.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'reasons.json');
export const KINDS = ['injury', 'illness', 'rest', 'conditioning', 'gleague', 'personal', 'suspension', 'other'];

// "Injury/Illness - Left Knee; Meniscus Tear" -> "knee; meniscus tear": side and prefix carry no signal
export function normReason(reason) {
  return String(reason || '').toLowerCase()
    .replace(/^injury\/illness\s*-?\s*/, '')
    .replace(/\b(left|right|bilateral|l|r)\b\.?/g, ' ')
    .replace(/[^a-z0-9;/ -]/g, ' ').replace(/\s+/g, ' ').replace(/^[\s;-]+|[\s;-]+$/g, '').trim();
}

let cache = null;
export function loadLexicon() {
  if (!cache) { try { cache = JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch { cache = {}; } }
  return cache;
}
export function saveLexicon(lex) {
  const sorted = Object.fromEntries(Object.keys(lex).sort().map((k) => [k, lex[k]]));
  fs.writeFileSync(FILE, `${JSON.stringify(sorted, null, 0).replace(/\},"/g, '},\n"')}\n`);
  cache = sorted;
}

// Keyword fallback for a wording the model has not graded. sev: 1 day-to-day, 2 about a week,
// 3 weeks, 4 months, 5 probably the season.
export function ruleGrade(reason) {
  const r = normReason(reason);
  if (/g league|two-way|on assignment/.test(r)) return { kind: 'gleague', sev: 0 };
  if (/suspension/.test(r)) return { kind: 'suspension', sev: 1 };
  if (/personal|not with team|trade pending|coach/.test(r)) return { kind: 'personal', sev: 1 };
  if (/\brest\b|injury management|load management/.test(r)) return { kind: 'rest', sev: 1 };
  if (/reconditioning|conditioning|ramp/.test(r)) return { kind: 'conditioning', sev: 2 };
  if (/illness|protocol|covid|flu|virus|infection|migraine/.test(r)) return { kind: 'illness', sev: 1 };
  if (/acl|achilles; (tear|rupture|repair)|season/.test(r)) return { kind: 'injury', sev: 5 };
  if (/surgery|repair|fracture|tear|rupture|reconstruction|stress (reaction|fracture)|dislocat/.test(r)) return { kind: 'injury', sev: 4 };
  if (/strain|sprain|recovery|inflammation|tendin|bone bruise|impingement/.test(r)) return { kind: 'injury', sev: 2 };
  return { kind: r ? 'injury' : 'other', sev: 1 };
}

export function gradeOf(reason, lex = loadLexicon()) {
  return lex[normReason(reason)] || ruleGrade(reason);
}

const SYSTEM = 'You are a sports medicine analyst grading entries from NBA injury reports. Each entry is the written reason a player is listed. '
  + 'For each, return: kind (one of injury, illness, rest, conditioning, gleague, personal, suspension, other), '
  + 'body (the body region in one or two lowercase words such as knee, ankle, foot, hamstring, calf, back, hip, groin, shoulder, hand, head; "none" if not an injury), '
  + 'and sev, how long a typical NBA player with exactly this entry stays out from the day it first appears: '
  + '0 not an absence from an NBA rotation (G League assignment, two-way), 1 day-to-day (a game or two), 2 about a week, 3 two to six weeks, 4 two months or more, 5 very likely the rest of the season. '
  + '"conditioning" means returning from a long layoff (return to competition reconditioning, ramp-up). "rest" covers rest and injury or load management. Grade the wording as given; do not guess a different injury.';

// Grade every wording not already in the lexicon. ask(system, user) -> parsed JSON object.
export async function gradeReasons(reasons, ask, { batch = 70, log = () => {} } = {}) {
  const lex = { ...loadLexicon() };
  const todo = [...new Set(reasons.map(normReason))].filter((r) => r && !lex[r]);
  for (let i = 0; i < todo.length; i += batch) {
    const part = todo.slice(i, i + batch);
    const user = `Grade these ${part.length} entries. Reply with one JSON object: {"grades": [{"i": <index>, "kind": "...", "body": "...", "sev": <0-5>}]} with one item per entry.\n\n${part.map((r, j) => `${j}. ${r}`).join('\n')}`;
    let parsed;
    try { parsed = await ask(SYSTEM, user); } catch (e) { log(`  batch ${i / batch + 1} failed: ${e.message}`); continue; }
    for (const g of parsed.grades || []) {
      const key = part[g.i];
      const sev = Math.round(Number(g.sev));
      if (!key || !KINDS.includes(g.kind) || !(sev >= 0 && sev <= 5)) continue;
      lex[key] = { kind: g.kind, body: String(g.body || 'none').toLowerCase().slice(0, 24), sev };
    }
    saveLexicon(lex);
    log(`  graded ${Math.min(i + batch, todo.length)} of ${todo.length}`);
  }
  return lex;
}
