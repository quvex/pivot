// Game-by-game history from ESPN. One request per season returns every player's box score
// for every scoring period (a scoring period is one calendar day of the NBA season).
// Used live (this season's game logs) and by the backtest (past seasons, cached on disk).
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './store.mjs';

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';
const ESPN_FANTASY = 'https://lm-api-reads.fantasy.espn.com/apis/v3/games/fba';
const HIST_DIR = path.join(DATA_DIR, 'hist');

// The raw ESPN stat ids we keep per game: everything a points league can score, plus minutes.
export const GAME_STATS = [0, 1, 2, 3, 6, 11, 13, 14, 15, 16, 17, 40, 41];

// -> { season, players: [{ id, name, pos, games: [{ d, t, s: {statId: value} }], proj, total }] }
// `d` is the scoring period (day of season), `t` the pro team id he played for that day.
export async function fetchSeasonLogs(season, limit = 520) {
  const filter = { players: { limit, sortPercOwned: { sortPriority: 1, sortAsc: false } } };
  const res = await fetch(`${ESPN_FANTASY}/seasons/${season}/segments/0/leaguedefaults/3?view=kona_player_info`, {
    headers: { 'User-Agent': UA, 'X-Fantasy-Filter': JSON.stringify(filter) }, signal: AbortSignal.timeout(180000),
  });
  if (!res.ok) throw new Error(`ESPN responded ${res.status} for the ${season} season`);
  const data = await res.json();
  const players = (data.players || []).map(({ player: p }) => {
    const games = [];
    let proj = null, total = null;
    for (const s of p.stats || []) {
      if (s.seasonId !== season) continue;
      if (s.statSourceId === 0 && s.statSplitTypeId === 5 && s.stats && s.stats[40] > 0) {
        const line = {};
        for (const k of GAME_STATS) if (s.stats[k]) line[k] = s.stats[k];
        games.push({ d: s.scoringPeriodId, t: s.proTeamId, s: line });
      } else if (s.statSourceId === 1 && s.statSplitTypeId === 0 && s.averageStats) proj = pick(s.averageStats);
      else if (s.statSourceId === 0 && s.statSplitTypeId === 0 && s.averageStats) total = pick(s.averageStats);
    }
    games.sort((a, b) => a.d - b.d);
    return { id: p.id, name: p.fullName, pos: p.defaultPositionId, games, proj, total };
  });
  return { season, players };
}

function pick(avg) {
  const out = {};
  for (const k of [...GAME_STATS, 42]) if (avg[k]) out[k] = Math.round(avg[k] * 1000) / 1000;
  return out;
}

// Past seasons never change, so they are downloaded once and kept in data/hist.
export async function loadSeasonLogs(season, { log = () => {} } = {}) {
  const file = path.join(HIST_DIR, `${season}.json`);
  if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf8'));
  log(`Downloading the ${season - 1}-${String(season).slice(2)} season from ESPN...`);
  const data = await fetchSeasonLogs(season);
  fs.mkdirSync(HIST_DIR, { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data));
  return data;
}
