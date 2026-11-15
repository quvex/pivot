// Has the configured language model pull stated timetables out of the downloaded headlines.
//   node scripts/read-headlines.mjs
import { loadSettings } from '../lib/store.mjs';
import { compatibleJson } from '../lib/news.mjs';
import { loadSeasonLogs } from '../lib/history.mjs';
import { loadHeadlines, extractTimetables } from '../lib/headlines.mjs';

const settings = loadSettings();
if (settings.aiProvider !== 'compatible' || !settings.altBaseUrl) { console.error('Set an OpenAI-compatible provider in Settings first.'); process.exit(1); }
const names = new Map();
for (const y of [2022, 2024, 2025, 2026]) for (const p of (await loadSeasonLogs(y)).players) names.set(p.id, p.name);
// only players the backtest knows: a headline about anyone else cannot be scored
const items = loadHeadlines().map((it) => ({ ...it, athletes: it.athletes.filter((a) => names.has(a)) })).filter((it) => it.athletes.length);
const ask = async (system, user) => (await compatibleJson(settings, system, user)).parsed;
const events = await extractTimetables(items, names, ask, { log: console.log });
const count = (f) => events.filter(f).length;
console.log(`${items.length} headlines -> ${count((e) => e.event === 'out')} absences (${count((e) => e.weeks != null)} with a stated length), ${count((e) => e.event === 'return')} returns`);
