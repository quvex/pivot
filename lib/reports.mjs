// The NBA's official injury reports, past and present.
//
// The league publishes a PDF several times a day listing every player who is out, doubtful,
// questionable or probable for that day's and the next day's games, with a short written reason
// ("Injury/Illness - Left Knee; Meniscus Tear"). Old reports stay online, so the backtest can ask
// what was publicly known on any past day. Parsed reports are cached in data/reports.
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './store.mjs';
import { normName } from './sources.mjs';

const REPORT_DIR = path.join(DATA_DIR, 'reports');
const BASE = 'https://ak-static.cms.nba.com/referee/injury/Injury-Report_';
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';
// the file name changed format during 2025-26; evening reports are the most complete
const TIMES = ['05PM', '05_00PM', '05_30PM', '06PM', '06_00PM', '04PM', '04_00PM', '08PM', '08_00PM', '01PM', '01_00PM'];
export const STATUSES = ['Out', 'Doubtful', 'Questionable', 'Probable', 'Available'];

// Text items with their page positions -> rows. The table is read by column: the player's name
// starts at x 426, his status at 587, the reason at 667. A long reason wraps onto the lines just
// above and below the player's own line, so each reason fragment goes to the nearest player.
export function rowsFromItems(pages) {
  const out = [];
  let team = ''; // printed once, on a team's first player, and carried down (and across pages)
  for (const items of pages) {
    if (items.some((i) => i.str.trim() === 'Player Name' && i.x < 100)) { team = rotatedRows(items, out, team); continue; }
    const lines = new Map();
    for (const it of items) {
      if (!it.str.trim()) continue;
      const y = Math.round(it.y);
      if (!lines.has(y)) lines.set(y, []);
      lines.get(y).push(it);
    }
    const players = [], reasons = [];
    for (const [y, its] of lines) {
      its.sort((a, b) => a.x - b.x);
      const text = (lo, hi) => its.filter((i) => i.x >= lo && i.x < hi).map((i) => i.str.trim()).join(' ').replace(/\s+/g, ' ').trim();
      const status = text(580, 660);
      const name = text(420, 580);
      if (STATUSES.includes(status) && name.includes(',')) players.push({ y, name, status, team: text(260, 420), reason: [] });
      else if (name === 'Player Name' || /^Page \d/.test(text(380, 480))) continue;
      const reason = text(660, 2000);
      if (reason && reason !== 'Reason') reasons.push({ y, reason });
    }
    players.sort((a, b) => b.y - a.y);
    for (const r of reasons) {
      let best = null;
      for (const p of players) if (Math.abs(p.y - r.y) <= 26 && (!best || Math.abs(p.y - r.y) < Math.abs(best.y - r.y))) best = p;
      if (best) best.reason.push(r);
    }
    for (const p of players) {
      if (p.team) team = p.team;
      const [last, first] = p.name.split(',').map((s) => s.trim());
      out.push({
        name: `${first} ${last}`.replace(/\s+/g, ' ').replace(/(\w)- (\w)/g, '$1-$2'),
        team, status: p.status,
        reason: p.reason.sort((a, b) => b.y - a.y).map((r) => r.reason).join(' ').replace(/\s+/g, ' ').replace(/(\w)- (\w)/g, '$1-$2').trim(),
      });
    }
  }
  return out;
}

// Reports before 2022-23 are laid out sideways: each player is a column of the page (one x), with
// his team, name, status and reason at fixed heights (y), each as one whole string.
function rotatedRows(items, out, team) {
  const at = (lo, hi) => items.filter((i) => i.y >= lo && i.y < hi && i.x > 70 && i.str.trim()).sort((a, b) => a.x - b.x);
  const names = at(360, 380), statuses = at(490, 506), reasons = at(596, 612), teams = at(236, 250);
  const near = (list, x) => list.find((i) => Math.abs(i.x - x) < 3)?.str.trim() || '';
  for (const n of names) {
    if (!n.str.includes(',')) continue;
    const status = near(statuses, n.x);
    if (!STATUSES.includes(status)) continue;
    team = near(teams, n.x) || team;
    const [last, first] = n.str.split(',').map((x) => x.trim());
    out.push({ name: `${first} ${last}`, team, status, reason: near(reasons, n.x) });
  }
  return team;
}

export async function parseReport(bytes) {
  const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const doc = await getDocument({ data: new Uint8Array(bytes), verbosity: 0 }).promise;
  const pages = [];
  for (let n = 1; n <= doc.numPages; n++) {
    const tc = await (await doc.getPage(n)).getTextContent();
    pages.push(tc.items.map((it) => ({ x: it.transform[4], y: it.transform[5], str: it.str })));
  }
  return rowsFromItems(pages);
}

// The evening report for one calendar day ('YYYY-MM-DD'), or [] when none was published
// (the All-Star break, the offseason). Cached once fetched: a past report never changes.
export async function loadReport(date, { fetch: f = fetch, cache = true } = {}) {
  const file = path.join(REPORT_DIR, `${date}.json`);
  if (cache && fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf8'));
  let rows = [];
  // the newer file name carries minutes; try the likelier form for the date first
  const times = date >= '2025-12-20' ? [...TIMES.filter((t) => t.includes('_')), ...TIMES.filter((t) => !t.includes('_'))] : TIMES;
  for (const t of times) {
    const res = await f(`${BASE}${date}_${t}.pdf`, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(30000) });
    if (!res.ok) continue;
    rows = await parseReport(await res.arrayBuffer());
    if (rows.length) break;
  }
  if (!cache) return rows;
  fs.mkdirSync(REPORT_DIR, { recursive: true });
  fs.writeFileSync(file, JSON.stringify(rows));
  return rows;
}

// Today's report for the live model (yesterday's until today's is out). Not cached: the league
// reissues it through the day.
const ET_DATE = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' });
export async function fetchLatestReport(now = Date.now(), opts = {}) {
  for (const back of [0, 1]) {
    const date = ET_DATE.format(new Date(now - back * 864e5));
    const rows = await loadReport(date, { ...opts, cache: false });
    if (rows.length) return { date, rows };
  }
  throw new Error('No report published in the last two days');
}

// For the backtest: what the reports said about each player on a given day of a past season,
// from reports already downloaded (scripts/fetch-reports.mjs). No network. Returns null when that
// season has not been downloaded, and the lookup returns null for a day with no report on file.
// players: [{ id, name }]. -> (day) => Map(playerId -> { status, reason })
export function seasonReports(season, players) {
  let dates;
  try { dates = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'context', `dates-${season}.json`), 'utf8')); } catch { return null; }
  const first = Math.min(...Object.keys(dates).map(Number));
  const dateOf = (day) => new Date(Date.parse(`${dates[first]}T12:00:00Z`) + (day - first) * 864e5).toISOString().slice(0, 10);
  const byName = new Map(players.map((p) => [normName(p.name), p.id]));
  const cache = new Map();
  const lookup = (day) => {
    if (cache.has(day)) return cache.get(day);
    // a report covers that day's and the next day's games, so three evenings reach every team
    const listed = new Map();
    let found = false;
    for (const back of [2, 1, 0]) {
      let rows;
      try { rows = JSON.parse(fs.readFileSync(path.join(REPORT_DIR, `${dateOf(day - back)}.json`), 'utf8')); } catch { continue; }
      if (rows.length) found = true;
      for (const r of rows) { const id = byName.get(normName(r.name)); if (id) listed.set(id, { status: r.status, reason: r.reason }); }
    }
    cache.set(day, found ? listed : null);
    return cache.get(day);
  };
  lookup.dateOf = dateOf;
  return lookup;
}
