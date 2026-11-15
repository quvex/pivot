// Downloads ESPN's dated NBA headlines for every day of the seasons the backtest uses, so that
// news with a stated timetable ("out four to six weeks") can be replayed. Kept in data/headlines
// (never committed): the wording belongs to ESPN.
//   node scripts/fetch-headlines.mjs [season ...]
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from '../lib/store.mjs';
import { pool } from '../lib/sources.mjs';

const DIR = path.join(DATA_DIR, 'headlines');
fs.mkdirSync(DIR, { recursive: true });
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';
const addDays = (d, n) => new Date(Date.parse(`${d}T12:00:00Z`) + n * 864e5).toISOString().slice(0, 10);

async function day(date) {
  const file = path.join(DIR, `${date}.json`);
  if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf8')).length;
  const out = new Map();
  for (let offset = 0; offset < 400; offset += 50) {
    const res = await fetch(`https://now.core.api.espn.com/v1/sports/news?sport=basketball&league=nba&dates=${date.replace(/-/g, '')}&limit=50&offset=${offset}`, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(30000) });
    if (!res.ok) throw new Error(`ESPN responded ${res.status} for ${date}`);
    const items = (await res.json()).headlines || [];
    for (const a of items) {
      const cats = a.categories || [];
      if (!['HeadlineNews', 'Story'].includes(a.type) || !cats.some((c) => c.type === 'league' && c.description === 'NBA')) continue;
      const athletes = [...new Set(cats.filter((c) => c.type === 'athlete' && c.athleteId).map((c) => c.athleteId))];
      if (!athletes.length || athletes.length > 4) continue; // round-ups that tag a dozen players say little about any one
      out.set(a.id, { id: a.id, time: a.published, headline: a.headline || '', text: a.description || '', athletes });
    }
    if (items.length < 50) break;
  }
  fs.writeFileSync(file, JSON.stringify([...out.values()]));
  return out.size;
}

const seasons = process.argv.slice(2).map(Number).filter(Boolean);
for (const season of seasons.length ? seasons : [2022, 2024, 2025, 2026]) {
  const dates = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'context', `dates-${season}.json`), 'utf8'));
  const first = Math.min(...Object.keys(dates).map(Number)), start = addDays(dates[first], -(first - 1) - 14); // two weeks of preseason news too
  const days = Array.from({ length: 192 }, (_, i) => addDays(start, i)).filter((d) => d < new Date().toISOString().slice(0, 10));
  let done = 0, kept = 0, failed = 0;
  await pool(days, 3, async (d) => { try { kept += await day(d); } catch { failed++; } if (++done % 48 === 0) console.log(`${season}: ${done}/${days.length} days, ${kept} headlines`); });
  console.log(`${season}: ${days.length} days, ${kept} headlines kept${failed ? `, ${failed} days failed (run again)` : ''}`);
}
