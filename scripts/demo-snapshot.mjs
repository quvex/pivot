// Builds demo/state.json: a frozen, scrubbed copy of the app's state for the public demo.
//   npm run demo:snapshot   (needs a local data/latest.json from a real refresh)
//
// What is removed or replaced, and why:
// - Team names, the league name and owner names belong to other people: replaced with made-up ones.
// - News headlines and article text, ESPN headlines, injury-report wording and any LLM briefing are
//   other publishers' writing: dropped. Pivot's own outcome lines for each item are kept.
// - Per-site ranks and FantasyPros' projections come from sites that are scraped: dropped. Only
//   ESPN's projection rank and the combined consensus remain.
// - Settings, cookies, keys and the league id never enter the file.
// The script refuses to write if any of the original names or secrets are still present.
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, loadLatest, loadSettings } from '../lib/store.mjs';
import { buildState } from '../lib/state.mjs';

const OUT = path.join(ROOT, 'demo', 'state.json');
const FAKE_TEAMS = ['Baseline Bandits', 'Paint Protectors', 'Corner Three Club', 'Glass Cleaners', 'Fast Break Fund', 'Pick and Roll Co.', 'Shot Clock Society', 'Backdoor Cutters', 'Full Court Press', 'Bank Shot Brigade', 'Hook Shot Union'];

const settings = loadSettings();
const data = structuredClone(loadLatest());
if (!data?.league) throw new Error('No synced league in data/latest.json. Run a refresh with your league first.');

// ----- strip third-party content before the state is built -----
data.ai = null;
data.headlines = [];
for (const p of data.players) {
  if (p.injury) p.injury = { status: p.injury.status, type: p.injury.type, returnDate: p.injury.returnDate };
  delete p.report; // the league report's wording stays local, like the other feeds' text
  delete p.timetable;
  delete p.ext;
  p.ranks = p.ranks?.espn ? { espn: p.ranks.espn } : {};
  p.model.reasons = p.model.reasons.map((r) => r.replace(/^Blended 80\/20 with FantasyPros' rest-of-season projection \([^)]*\)/, 'Blended 80/20 with an outside rest-of-season projection'));
}
data.meta.sources = data.meta.sources.filter((s) => s.key === 'espn');

const state = buildState(data, settings);

for (const n of state.news) {
  n.headline = ''; n.text = ''; n.url = ''; n.ai = null;
}
state.headlines = [];
state.settings = { demo: true };
state.job = { running: false, error: null, startedAt: null };

// what the browser needs to run the trade engine itself
state.demo = {
  snapshot: state.meta.day,
  league: {
    id: 'demo', name: 'Demo League', format: data.league.format,
    teams: data.league.teams.map(({ id, name, points, gamesUsed, slotUsed, roster, ir }) => ({ id, name, points, gamesUsed, slotUsed, roster, ir, isMine: id === state.myTeam?.id })),
  },
  schedule: data.schedule,
  settings: { teamId: state.myTeam?.id ?? null, manualRoster: [] },
};
if (state.league) {
  state.league.id = 'demo';
  for (const t of state.league.teams) t.owner = '';
}

// ----- rename teams and the league everywhere they appear -----
const realTeams = data.league.teams.map((t) => ({ id: t.id, name: t.name }));
const rename = new Map();
let i = 0;
for (const t of realTeams) rename.set(t.name, t.id === state.myTeam?.id ? 'Your Team' : FAKE_TEAMS[i++ % FAKE_TEAMS.length]);
rename.set(data.league.name, 'Demo League');
const owners = data.league.teams.map((t) => t.owner).filter(Boolean).flatMap((o) => o.split(', '));
let json = JSON.stringify(state);
const escapeJson = (s) => JSON.stringify(s).slice(1, -1);
for (const [real, fake] of [...rename].sort((a, b) => b[0].length - a[0].length)) json = json.split(escapeJson(real)).join(escapeJson(fake));

// ----- refuse to publish anything identifying -----
const forbidden = [...rename.keys(), ...owners, String(settings.leagueId || ''), settings.espnS2, settings.swid, settings.anthropicKey, settings.altKey]
  .filter((s) => s && String(s).length >= 4);
const leaks = forbidden.filter((s) => json.includes(escapeJson(String(s))));
if (leaks.length) throw new Error(`Refusing to write: ${leaks.length} identifying value(s) still present`);
if (/RotoWire via ESPN"[^}]*"headline":"[^"]/.test(json)) throw new Error('Refusing to write: news text still present');

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, json);
console.log(`Wrote ${path.relative(ROOT, OUT)} (${(json.length / 1e6).toFixed(2)} MB): ${state.players.length} players, ${state.league.teams.length} teams, snapshot of ${state.meta.day}.`);
