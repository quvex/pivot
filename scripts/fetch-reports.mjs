// Downloads the NBA's evening injury report for every day of the seasons the backtest uses, and
// the calendar date of each ESPN scoring period. Everything lands in data/ (never committed).
//   node scripts/fetch-reports.mjs [season ...]     (a season is named by the year it ends)
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from '../lib/store.mjs';
import { fetchProSchedule, periodDates, pool } from '../lib/sources.mjs';
import { loadReport } from '../lib/reports.mjs';

const seasons = process.argv.slice(2).map(Number).filter(Boolean);
const DIR = path.join(DATA_DIR, 'context');
fs.mkdirSync(DIR, { recursive: true });
const addDays = (d, n) => new Date(Date.parse(`${d}T12:00:00Z`) + n * 864e5).toISOString().slice(0, 10);

for (const season of seasons.length ? seasons : [2022, 2024, 2025, 2026]) {
  const file = path.join(DIR, `dates-${season}.json`);
  let dates;
  if (fs.existsSync(file)) dates = JSON.parse(fs.readFileSync(file, 'utf8'));
  else { dates = periodDates(await fetchProSchedule(season)); fs.writeFileSync(file, JSON.stringify(dates)); }
  // scoring periods are consecutive days: fill the days nobody played from their neighbours
  const first = Math.min(...Object.keys(dates).map(Number)), start = addDays(dates[first], -(first - 1));
  const days = Array.from({ length: 178 }, (_, i) => addDays(start, i)).filter((d) => d < new Date().toISOString().slice(0, 10));
  let done = 0, rows = 0;
  // one at a time with a pause: the host blocks an address that asks too fast, and a blocked
  // request looks the same as a day with no report, so stop if a known report cannot be fetched
  const probe = () => fetch('https://ak-static.cms.nba.com/referee/injury/Injury-Report_2024-01-15_05PM.pdf', { method: 'HEAD', headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36' } }).then((r) => r.ok).catch(() => false);
  await pool(days, 1, async (d) => {
    if (fs.existsSync(path.join(DATA_DIR, 'reports', `${d}.json`))) { rows += (await loadReport(d)).length; done++; return; }
    if (done % 15 === 0 && !(await probe())) { console.error('The NBA host is refusing requests. Try again later; finished days are kept.'); process.exit(2); }
    const r = await loadReport(d); rows += r.length;
    await new Promise((res) => setTimeout(res, 900));
    if (++done % 40 === 0) console.log(`${season}: ${done}/${days.length} days`);
  });
  console.log(`${season}: ${days.length} days from ${start}, ${rows} report lines`);
}
