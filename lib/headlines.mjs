// Timetables from news headlines.
//
// An injury report says a player is out and why. A headline sometimes says for how long: "out four
// to six weeks", "to miss the rest of the season", "cleared to return Friday". A language model
// reads each headline and its summary and, for each player it tags, pulls out what kind of news it
// is and any stated time out. Only those extracted facts are kept (data/context/timetables.json):
// the wording stays ESPN's. The backtest then asks whether knowing the stated timetable on the day
// would have improved the forecast of games played (backtest.mjs).
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './store.mjs';

const FILE = path.join(DATA_DIR, 'context', 'timetables.json');
const HEADLINES = path.join(DATA_DIR, 'headlines');
export const EVENTS = ['out', 'return', 'none'];

const SYSTEM = 'You extract injury and availability facts from NBA news headlines. Each item has a headline, a one-sentence summary and the players it tags. '
  + 'For each tagged player the item gives real availability news about, return: athlete (the id given), event, and weeks. '
  + 'event is "out" (he is or will be sidelined: injury, surgery, suspension, personal leave), "return" (he is back, cleared, or set to play his next game), or "none" (anything else: trades, contracts, performances, quotes, rumours, fantasy advice). '
  + 'weeks is how long he is expected to be out, counted from the day of the article, using only what the text states or plainly implies: '
  + '0 for day-to-day or one game, 0.5 for a few games, the midpoint of a stated range ("four to six weeks" is 5, "at least two weeks" is 2.5, "re-evaluated in three weeks" is 4), '
  + '40 when he is out for the season or indefinitely after major surgery, and null when the text gives no idea of the length. For "return" and "none", weeks is null. '
  + 'Do not use outside knowledge about the player, and skip players the item says nothing specific about.';

export function loadTimetables() {
  try { return JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch { return { done: [], events: [] }; }
}

// items: [{ id, time, headline, text, athletes: [id] }]. names: Map id -> name.
// ask(system, user) -> parsed JSON. Returns events [{ athlete, date, event, weeks }].
export async function extractTimetables(items, names, ask, { batch = 30, log = () => {}, save = true } = {}) {
  const store = loadTimetables();
  const seen = new Set(store.done);
  const todo = items.filter((it) => !seen.has(it.id));
  for (let i = 0; i < todo.length; i += batch) {
    const part = todo.slice(i, i + batch);
    const user = `Reply with one JSON object: {"facts": [{"i": <item index>, "athlete": <id>, "event": "out"|"return"|"none", "weeks": <number or null>}]}. Leave out players with event "none".\n\n`
      + part.map((it, j) => `${j}. ${it.headline} -- ${it.text}\n   players: ${it.athletes.map((a) => `${names.get(a) || 'unknown'} (${a})`).join(', ')}`).join('\n');
    let parsed;
    try { parsed = await ask(SYSTEM, user); } catch (e) { log(`  batch failed: ${e.message}`); continue; }
    for (const f of parsed.facts || []) {
      const it = part[f.i];
      const athlete = Number(f.athlete);
      if (!it || !it.athletes.includes(athlete) || !['out', 'return'].includes(f.event)) continue;
      const weeks = f.event === 'out' && f.weeks != null && Number.isFinite(Number(f.weeks)) ? Math.max(0, Math.min(40, Number(f.weeks))) : null;
      store.events.push({ athlete, date: it.time.slice(0, 10), event: f.event, weeks });
    }
    for (const it of part) store.done.push(it.id);
    if (save) { fs.mkdirSync(path.dirname(FILE), { recursive: true }); fs.writeFileSync(FILE, JSON.stringify(store)); }
    log(`  read ${Math.min(i + batch, todo.length)} of ${todo.length} headlines`);
  }
  return store.events;
}

export function loadHeadlines() {
  const out = [];
  let files = [];
  try { files = fs.readdirSync(HEADLINES); } catch { /* none downloaded */ }
  for (const f of files) for (const it of JSON.parse(fs.readFileSync(path.join(HEADLINES, f), 'utf8'))) out.push(it);
  return out;
}

// What the news had said about a player's timetable as of a date: the latest "out" with a stated
// length in the last 75 days (200 for a season-long absence), unless a "return" came after it.
//   'back'    news of his return in the last ten days
//   'soon'    stated time out has run down to under two weeks (or has passed)
//   'weeks'   two to six weeks still to run
//   'months'  more than six weeks, or the season
// null when the news gave no timetable.
export function timetableIndex(events) {
  const by = new Map();
  for (const e of events) { if (!by.has(e.athlete)) by.set(e.athlete, []); by.get(e.athlete).push(e); }
  for (const list of by.values()) list.sort((a, b) => (a.date < b.date ? -1 : 1));
  const days = (a, b) => (Date.parse(b) - Date.parse(a)) / 864e5;
  return (athlete, date) => {
    const list = by.get(athlete);
    if (!list) return null;
    let last = null;
    for (const e of list) { if (e.date > date) break; if (e.event === 'return' || e.weeks != null) last = e; }
    if (!last) return null;
    const age = days(last.date, date);
    if (last.event === 'return') return age <= 10 ? 'back' : null;
    // old news stops counting: a season-long absence ends with that season, anything else after 75 days
    if (age > (last.weeks >= 40 ? 200 : 75)) return null;
    const left = last.weeks - age / 7;
    return left > 6 ? 'months' : left >= 2 ? 'weeks' : 'soon';
  };
}
