// Fetchers for every outside data source. Each returns plain data and throws on failure;
// refresh.mjs decides what to do when a source is down.
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';
const ESPN_FANTASY = 'https://lm-api-reads.fantasy.espn.com/apis/v3/games/fba';

const PRO_TEAMS = {
  1: 'ATL', 2: 'BOS', 3: 'NOP', 4: 'CHI', 5: 'CLE', 6: 'DAL', 7: 'DEN', 8: 'DET', 9: 'GSW', 10: 'HOU',
  11: 'IND', 12: 'LAC', 13: 'LAL', 14: 'MIA', 15: 'MIL', 16: 'MIN', 17: 'BKN', 18: 'NYK', 19: 'ORL', 20: 'PHI',
  21: 'PHX', 22: 'POR', 23: 'SAC', 24: 'SAS', 25: 'OKC', 26: 'UTA', 27: 'WAS', 28: 'TOR', 29: 'MEM', 30: 'CHA',
};
export const PRO_TEAM_ID = Object.fromEntries(Object.entries(PRO_TEAMS).map(([id, abbr]) => [abbr, Number(id)]));
const POSITIONS = { 1: 'PG', 2: 'SG', 3: 'SF', 4: 'PF', 5: 'C' };

// In a browser (the public site) the User-Agent can't be set and a Cookie header is ignored: ESPN
// allows the league API from other sites, and sends the visitor's own espn.com sign-in instead.
// Pasted espn_s2 and SWID cookies go through the site's relay (worker/espn-relay.mjs), which hands
// them to ESPN; the page sets globalThis.PIVOT_ESPN_RELAY to its address.
const BROWSER = typeof window !== 'undefined';
async function get(url, { headers = {}, json = false, timeout = 30000 } = {}) {
  let res;
  if (!BROWSER) res = await fetch(url, { headers: { 'User-Agent': UA, ...headers }, signal: AbortSignal.timeout(timeout) });
  else {
    const { Cookie: cookie, ...rest } = headers;
    const relay = globalThis.PIVOT_ESPN_RELAY;
    if (cookie && relay && url.startsWith(ESPN_FANTASY)) {
      const jar = Object.fromEntries(cookie.split(/;\s*/).map((c) => [c.slice(0, c.indexOf('=')), c.slice(c.indexOf('=') + 1)]));
      res = await fetch(relay.replace(/\/$/, '') + url.slice(new URL(url).origin.length), { headers: { ...rest, 'X-Espn-S2': jar.espn_s2, 'X-Espn-Swid': jar.SWID }, signal: AbortSignal.timeout(timeout) });
    } else res = await fetch(url, { headers: rest, credentials: url.startsWith(ESPN_FANTASY) ? 'include' : 'same-origin', signal: AbortSignal.timeout(timeout) });
  }
  if (!res.ok) {
    const err = new Error(`${new URL(url).hostname} responded ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return json ? res.json() : res.text();
}

// ---------- name matching ----------
const ALIASES = {
  'nic claxton': 'nicolas claxton', 'cam johnson': 'cameron johnson', 'herb jones': 'herbert jones',
  'alex sarr': 'alexandre sarr', 'ron holland': 'ronald holland', 'moe wagner': 'moritz wagner',
  'bub carrington': 'carlton carrington', 'kj martin': 'kenyon martin', 'cam whitmore': 'cameron whitmore',
  'nah shon hyland': 'bones hyland', 'gg jackson': 'gregory jackson', 'vit krejci': 'vit krejci',
};

export function normName(name) {
  const n = String(name || '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase().replace(/[.'’`]/g, '').replace(/[^a-z ]/g, ' ')
    .replace(/\b(jr|sr|ii|iii|iv|v)\b/g, ' ').replace(/\s+/g, ' ').trim();
  return ALIASES[n] || n;
}

// Builds a lookup from any spelling of a name to the ESPN player id.
export function buildNameIndex(players) {
  const exact = new Map();
  const loose = new Map(); // "f lastname" -> id, only when unambiguous
  for (const p of players) {
    const n = normName(p.name);
    if (!exact.has(n)) exact.set(n, p.id); // players arrive sorted by ownership: first wins
    const parts = n.split(' ');
    const key = `${parts[0][0]} ${parts.slice(1).join(' ')}`;
    loose.set(key, loose.has(key) ? null : p.id);
  }
  return (name) => {
    const n = normName(name);
    if (exact.has(n)) return exact.get(n);
    const parts = n.split(' ');
    if (parts.length < 2) return null;
    return loose.get(`${parts[0][0]} ${parts.slice(1).join(' ')}`) ?? null;
  };
}

const decode = (s) => s.replace(/&#(\d+);/g, (_, c) => String.fromCharCode(+c)).replace(/&nbsp;/g, ' ')
  .replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#x27;|&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>');
export const stripHtml = (s) => decode(String(s || '').replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();

// ---------- ESPN player pool ----------
const SPLIT_KEYS = (season) => ({
  [`00${season}`]: 'season', [`01${season}`]: 'l7', [`02${season}`]: 'l15', [`03${season}`]: 'l30',
  [`10${season}`]: 'proj', [`00${season - 1}`]: 'prev',
});

export async function fetchEspnPlayers(season, limit = 450) {
  const keys = SPLIT_KEYS(season);
  const filter = {
    players: {
      limit,
      sortPercOwned: { sortPriority: 1, sortAsc: false },
      filterStatsForTopScoringPeriodIds: { value: 2, additionalValue: Object.keys(keys) },
    },
  };
  const data = await get(`${ESPN_FANTASY}/seasons/${season}/segments/0/leaguedefaults/3?view=kona_player_info`, {
    json: true, headers: { 'X-Fantasy-Filter': JSON.stringify(filter) }, timeout: 60000,
  });
  return (data.players || []).map(({ player: p }) => {
    const splits = {};
    for (const s of p.stats || []) {
      const key = keys[s.id];
      // averageStats holds per-game numbers; keep the raw ESPN stat ids so any scoring works.
      if (key && s.averageStats) splits[key] = s.averageStats;
    }
    const own = p.ownership || {};
    return {
      id: p.id,
      name: p.fullName,
      team: PRO_TEAMS[p.proTeamId] || 'FA',
      pos: POSITIONS[p.defaultPositionId] || '',
      slots: (p.eligibleSlots || []).filter((x) => x < 12),
      injuryStatus: p.injuryStatus || 'ACTIVE',
      owned: own.percentOwned ?? 0,
      started: own.percentStarted ?? 0,
      ownedChange: own.percentChange ?? 0,
      adp: own.averageDraftPosition ?? null,
      lastNewsDate: p.lastNewsDate || 0,
      raw: splits,
    };
  });
}

// ---------- ESPN league (settings, teams, rosters, matchups) ----------
export async function fetchEspnLeague({ season, leagueId, espnS2, swid }) {
  const headers = espnS2 && swid ? { Cookie: `espn_s2=${espnS2}; SWID=${swid}` } : {};
  let data;
  try {
    data = await get(`${ESPN_FANTASY}/seasons/${season}/segments/0/leagues/${encodeURIComponent(leagueId)}?view=mSettings&view=mRoster&view=mTeam&view=mMatchupScore&view=mStatus`, { json: true, headers });
  } catch (e) {
    if (e.status === 401 || e.status === 403) {
      const err = new Error(BROWSER && !(headers.Cookie && globalThis.PIVOT_ESPN_RELAY)
        ? 'This league is private. Add your espn_s2 and SWID cookies, or sign in to espn.com in this browser and try again (Chrome and Edge allow that; Safari and Firefox block it).'
        : headers.Cookie
        ? 'ESPN rejected the cookies. Re-copy espn_s2 and SWID from a logged-in espn.com session.'
        : 'This league is private. Add your espn_s2 and SWID cookies.');
      err.code = 'private';
      throw err;
    }
    if (e.status === 404) { const err = new Error(`League ${leagueId} was not found for the ${season} season.`); err.code = 'not_found'; throw err; }
    throw e;
  }
  return parseEspnLeague(data, { leagueId, swid });
}

// Accepted trades, from the league's activity log. Each trade is one topic whose messages are the
// individual moves: player `targetId` going from one fantasy team to another (message type 244).
export async function fetchEspnTrades({ season, leagueId, espnS2, swid }) {
  const headers = espnS2 && swid ? { Cookie: `espn_s2=${espnS2}; SWID=${swid}` } : {};
  const filter = { topics: { filterType: { value: ['ACTIVITY_TRANSACTIONS'] }, limit: 100, limitPerMessageSet: { value: 50 }, offset: 0, sortMessageDate: { sortPriority: 1, sortAsc: false }, filterIncludeMessageTypeIds: { value: [244] } } };
  const data = await get(`${ESPN_FANTASY}/seasons/${season}/segments/0/leagues/${encodeURIComponent(leagueId)}/communication/?view=kona_league_communication`, { json: true, headers: { ...headers, 'X-Fantasy-Filter': JSON.stringify(filter) } });
  return parseEspnTrades(data);
}
export function parseEspnTrades(data) {
  return (data?.topics || []).map((t) => ({
    id: String(t.id), date: t.date,
    moves: (t.messages || []).filter((m) => m.messageTypeId === 244 && m.targetId != null && m.from !== m.to)
      .map((m) => ({ playerId: m.targetId, from: m.from, to: m.to })),
  })).filter((t) => t.moves.length >= 2);
}

// How Pivot handles each ESPN scoring type.
const FORMATS = {
  TOTAL_SEASON_POINTS: { kind: 'season', label: 'Season-long total points', supported: true },
  H2H_POINTS: { kind: 'h2h', label: 'Head-to-head points', supported: true },
  H2H_CATEGORY: { kind: 'categories', label: 'Head-to-head categories', supported: false },
  H2H_MOST_CATEGORIES: { kind: 'categories', label: 'Head-to-head most categories', supported: false },
  ROTO: { kind: 'categories', label: 'Rotisserie', supported: false },
};
export const formatOf = (scoringType) => FORMATS[scoringType] || { kind: 'unknown', label: scoringType || 'Unknown format', supported: false };

// Pure parser for ESPN's league JSON, so every format can be tested without a live league.
export function parseEspnLeague(data, { leagueId, swid = '' } = {}) {
  const scoring = {};
  for (const item of data.settings?.scoringSettings?.scoringItems || []) {
    if (item.points) scoring[item.statId] = item.points;
  }
  const members = new Map((data.members || []).map((m) => [m.id, m.displayName || `${m.firstName || ''} ${m.lastName || ''}`.trim()]));
  // lineup slots and (for season-long points leagues) games-played caps per slot
  const rs = data.settings?.rosterSettings || {};
  const slotCounts = {};
  for (const [slot, n] of Object.entries(rs.lineupSlotCounts || {})) if (n > 0) slotCounts[slot] = n;
  const slotLimits = {};
  for (const [slot, lim] of Object.entries(rs.lineupSlotStatLimits || {})) if (lim?.statId === 42 && lim.limitValue > 0) slotLimits[slot] = lim.limitValue;
  const slotUsed = new Map(); // teamId -> { slot: games }
  const matchups = [];
  const live = (side) => side?.totalPointsLive ?? side?.totalPoints ?? 0;
  for (const m of data.schedule || []) {
    for (const side of m.teams || [m.home, m.away].filter(Boolean)) {
      const used = {};
      for (const [slot, v] of Object.entries(side.cumulativeScore?.statBySlot || {})) used[slot] = v.value || 0;
      if (Object.keys(used).length) slotUsed.set(side.teamId, used);
    }
    // head-to-head pairings (season-long leagues list every team in one "matchup" instead)
    if (m.home && m.away) {
      matchups.push({ period: m.matchupPeriodId, home: m.home.teamId, away: m.away.teamId, homePoints: live(m.home), awayPoints: live(m.away), winner: m.winner || 'UNDECIDED' });
    }
  }
  const scoringType = data.settings?.scoringSettings?.scoringType || '';
  const ss = data.settings?.scheduleSettings || {};
  const format = {
    scoringType, ...formatOf(scoringType),
    slotCounts, slotLimits,
    capTotal: Object.values(slotLimits).reduce((a, b) => a + b, 0),
    matchupPeriods: ss.matchupPeriods || {},
    currentMatchupPeriod: data.status?.currentMatchupPeriod ?? null,
    playoffTeams: ss.playoffTeamCount || 0,
  };
  const teams = (data.teams || []).map((t) => {
    const rec = t.record?.overall || {};
    return {
      points: t.points || 0,
      record: { wins: rec.wins || 0, losses: rec.losses || 0, ties: rec.ties || 0, pointsFor: rec.pointsFor || 0, pointsAgainst: rec.pointsAgainst || 0 },
      slotUsed: slotUsed.get(t.id) || {},
      gamesUsed: Object.values(slotUsed.get(t.id) || {}).reduce((a, b) => a + b, 0),
      ir: (t.roster?.entries || []).filter((e) => e.lineupSlotId === 13).map((e) => e.playerId),
      id: t.id,
      name: t.name || `${t.location || ''} ${t.nickname || ''}`.trim() || `Team ${t.id}`,
      abbrev: t.abbrev || '',
      owner: (t.owners || []).map((o) => members.get(o)).filter(Boolean).join(', '),
      isMine: Boolean(swid && (t.owners || []).some((o) => String(o).toLowerCase() === String(swid).toLowerCase())),
      roster: (t.roster?.entries || []).map((e) => e.playerId),
    };
  });
  return {
    id: String(leagueId ?? data.id), name: data.settings?.name || `League ${leagueId ?? data.id}`, season: data.seasonId ?? null,
    scoringPeriodId: data.scoringPeriodId ?? null, scoring, teams, format, matchups,
  };
}

// ---------- NBA schedule ----------
// The raw pro schedule: every NBA game with its ESPN scoring period (one period = one day).
export async function fetchProSchedule(season) {
  const data = await get(`${ESPN_FANTASY}/seasons/${season}?view=proTeamSchedules_wl`, { json: true });
  return data.settings?.proTeams || [];
}

// { TEAM: [gameStartMs, ...] } for games from `from` to `to`.
export function teamSchedule(proTeams, from, to) {
  const out = {};
  for (const t of proTeams) {
    const abbr = PRO_TEAMS[t.id];
    if (!abbr) continue;
    out[abbr] = Object.values(t.proGamesByScoringPeriod || {}).flat().map((g) => g.date)
      .filter((d) => d >= from && d <= to).sort((a, b) => a - b);
  }
  return out;
}

// { scoringPeriodId: 'YYYY-MM-DD' } in US Eastern time, which is how ESPN counts fantasy days.
const ET = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' });
export function periodDates(proTeams) {
  const out = {};
  for (const t of proTeams) {
    for (const [sp, games] of Object.entries(t.proGamesByScoringPeriod || {})) {
      for (const g of games) { const d = ET.format(new Date(g.date)); if (!out[sp] || d < out[sp]) out[sp] = d; }
    }
  }
  return out;
}

export async function fetchSchedule(season, from, to) {
  return teamSchedule(await fetchProSchedule(season), from, to);
}

// ---------- ESPN injuries (return dates) ----------
export async function fetchInjuries() {
  const data = await get('https://site.api.espn.com/apis/site/v2/sports/basketball/nba/injuries', { json: true });
  const out = [];
  for (const team of data.injuries || []) {
    for (const inj of team.injuries || []) {
      out.push({
        name: inj.athlete?.displayName,
        status: inj.status,
        date: inj.date,
        type: inj.details?.type || '',
        detail: inj.details?.detail || '',
        returnDate: inj.details?.returnDate || null,
        comment: inj.shortComment || '',
        longComment: inj.longComment || '',
      });
    }
  }
  return out;
}

// ---------- ranking sources ----------
// Each returns { label, url, basis, list: [{ name, rank }] }.
export async function fetchHashtag() {
  return parseHashtag(await get('https://hashtagbasketball.com/fantasy-basketball-points-league-rankings'));
}

// Pure parser, kept separate from the network call so it can be tested on saved markup.
export function parseHashtag(html) {
  const url = 'https://hashtagbasketball.com/fantasy-basketball-points-league-rankings';
  const list = [];
  for (const row of html.split(/<tr[\s>]/).slice(1)) {
    const rank = row.match(/title="RANK">\s*(\d+)\s*</);
    const name = row.match(/title="NAME"[^>]*d-none d-sm-inline[^>]*>([^<]+)</) || row.match(/d-none d-sm-inline">([^<]+)</);
    if (rank && name) list.push({ name: decode(name[1]).trim(), rank: +rank[1] });
  }
  if (list.length < 50) throw new Error('Hashtag Basketball layout changed (too few rows parsed)');
  return { label: 'Hashtag', full: 'Hashtag Basketball', url, basis: 'Points-league per-game rankings, season to date', list };
}

export async function fetchBasketballMonster() {
  return parseBasketballMonster(await get('https://basketballmonster.com/playerrankings.aspx'));
}

// Pure parser, kept separate from the network call so it can be tested on saved markup.
export function parseBasketballMonster(html) {
  const url = 'https://basketballmonster.com/playerrankings.aspx';
  const rows = [...html.matchAll(/<tr[^>]*>(.*?)<\/tr>/gs)]
    .map((m) => [...m[1].matchAll(/<t[dh][^>]*>(.*?)<\/t[dh]>/gs)].map((c) => stripHtml(c[1])));
  const header = rows.find((r) => r.includes('Rank') && r.includes('Name'));
  if (!header) throw new Error('Basketball Monster layout changed (no header row)');
  const ri = header.indexOf('Rank');
  const ni = header.indexOf('Name');
  const list = [];
  for (const r of rows) {
    const rank = parseInt(r[ri], 10);
    if (rank > 0 && r[ni] && r[ni] !== 'Name') list.push({ name: r[ni], rank });
  }
  if (list.length < 50) throw new Error('Basketball Monster layout changed (too few rows parsed)');
  return { label: 'BBM', full: 'Basketball Monster', url, basis: 'Overall player value, season to date', list };
}

export async function fetchFantasyPros() {
  return parseFantasyPros(await get('https://www.fantasypros.com/nba/rankings/ros-overall.php'));
}

// Pure parser, kept separate from the network call so it can be tested on saved markup.
export function parseFantasyPros(html) {
  const url = 'https://www.fantasypros.com/nba/rankings/ros-overall.php';
  const m = html.match(/var ecrData = (\{.*\});/);
  if (!m) throw new Error('FantasyPros layout changed (no ranking data found)');
  const ecr = JSON.parse(m[1]);
  const list = (ecr.players || []).map((p) => ({ name: p.player_name, rank: +p.rank_ecr })).filter((p) => p.rank > 0);
  if (list.length < 50) throw new Error('FantasyPros returned too few players');
  return {
    label: 'FPros', full: 'FantasyPros ECR', url,
    basis: `Rest-of-season expert consensus (${ecr.total_experts} experts, updated ${ecr.last_updated})`, list,
  };
}

// FantasyPros rest-of-season stat projections (per game). They publish shooting percentages but
// not makes and attempts, so refresh.mjs fills those in from each player's own shot profile.
export async function fetchFantasyProsProjections() {
  return parseFantasyProsProjections(await get('https://www.fantasypros.com/nba/projections/avg-ros-overall.php'));
}

// Pure parser, kept separate from the network call so it can be tested on saved markup.
export function parseFantasyProsProjections(html) {
  const url = 'https://www.fantasypros.com/nba/projections/avg-ros-overall.php';
  const rows = [...html.matchAll(/<tr[^>]*>(.*?)<\/tr>/gs)]
    .map((m) => [...m[1].matchAll(/<t[dh][^>]*>(.*?)<\/t[dh]>/gs)].map((c) => stripHtml(c[1])));
  const header = rows.find((r) => r.includes('PTS') && r.includes('MIN'));
  if (!header) throw new Error('FantasyPros projections layout changed (no header row)');
  const col = (k) => header.indexOf(k);
  const num = (v) => parseFloat(String(v).replace(/,/g, '')) || 0;
  const list = [];
  for (const r of rows) {
    if (r === header || r.length < header.length) continue;
    const name = r[0].split(' (')[0].trim();
    const line = {
      name, pts: num(r[col('PTS')]), reb: num(r[col('REB')]), ast: num(r[col('AST')]), blk: num(r[col('BLK')]), stl: num(r[col('STL')]),
      fgp: num(r[col('FG%')]), ftp: num(r[col('FT%')]), tpm: num(r[col('3PM')]), gp: num(r[col('GP')]), min: num(r[col('MIN')]), to: num(r[col('TO')]),
    };
    if (name && line.min > 0) list.push(line);
  }
  if (list.length < 50) throw new Error('FantasyPros projections returned too few players');
  return { label: 'FP proj', full: 'FantasyPros projections', url, basis: 'Rest-of-season stat projections scored with your league settings', list };
}

// ---------- today's lineups (RotoWire) ----------
// -> [{ name, starter, confirmed, playPct, status }] for every player listed on today's slate.
export async function fetchLineups() {
  return parseLineups(await get('https://www.rotowire.com/basketball/nba-lineups.php'));
}

// Pure parser, kept separate from the network call so it can be tested on saved markup.
export function parseLineups(html) {
  if (!html.includes('lineup__')) throw new Error('RotoWire lineups layout changed');
  const out = [];
  for (const m of html.matchAll(/<ul class="lineup__list[^"]*">(.*?)<\/ul>/gs)) {
    const block = m[1];
    const confirmed = /lineup__status is-confirmed/.test(block);
    const [starters, rest = ''] = block.split(/lineup__title/);
    const parse = (chunk, starter) => {
      for (const li of chunk.matchAll(/<li class="lineup__player([^"]*)"[^>]*>(.*?)<\/li>/gs)) {
        const name = li[2].match(/<a title="([^"]+)"/)?.[1];
        if (!name) continue;
        const pct = li[1].match(/is-pct-play-(\d+)/);
        const inj = li[2].match(/lineup__inj">([^<]*)</);
        out.push({ name: decode(name), starter, confirmed, playPct: pct ? +pct[1] : null, status: inj ? inj[1].trim() : '' });
      }
    };
    parse(starters, true);
    parse(rest, false);
  }
  return out;
}

// ---------- Sleeper (crowd behaviour on another platform, depth charts) ----------
// The player directory is large and changes slowly, so the caller caches it.
export async function fetchSleeper(cacheGet, cacheSet) {
  let players = cacheGet?.();
  // caches written before jersey numbers were kept are refetched
  if (players && !Object.values(players).some((p) => 'h' in p)) players = null;
  if (!players) {
    const all = await get('https://api.sleeper.app/v1/players/nba', { json: true, timeout: 60000 });
    players = {};
    for (const [id, p] of Object.entries(all)) {
      if (!p.active || !p.full_name) continue;
      players[id] = { n: p.full_name, d: p.depth_chart_order ?? null, b: p.birth_date || null, j: p.number ?? null, h: Number(p.height) || null, w: Number(p.weight) || null };
    }
    cacheSet?.(players);
  }
  const adds = await get('https://api.sleeper.app/v1/players/nba/trending/add?lookback_hours=48&limit=60', { json: true });
  const drops = await get('https://api.sleeper.app/v1/players/nba/trending/drop?lookback_hours=48&limit=60', { json: true });
  const named = (rows) => rows.map((t) => ({ name: players[t.player_id]?.n, count: t.count })).filter((t) => t.name);
  return {
    adds: named(adds), drops: named(drops),
    info: Object.values(players).map((p) => ({ name: p.n, depth: p.d, born: p.b, jersey: p.j, height: p.h, weight: p.w })),
  };
}

// ---------- Rotoworld (NBC Sports) player news: a second, independent news desk ----------
export async function fetchRotoworld() {
  return parseRotoworld(await get('https://www.nbcsports.com/fantasy/basketball/player-news'));
}

// Pure parser, kept separate from the network call so it can be tested on saved markup.
export function parseRotoworld(html) {
  if (!html.includes('PlayerNewsPost')) throw new Error('Rotoworld layout changed');
  const out = [];
  for (const post of html.split('<div class="PlayerNewsPost"').slice(1)) {
    const first = post.match(/PlayerNewsPost-firstName">([^<]*)</)?.[1] || '';
    const last = post.match(/PlayerNewsPost-lastName">([^<]*)</)?.[1] || '';
    const headline = post.match(/PlayerNewsPost-headline">(.*?)<\/h3>/s)?.[1];
    const analysis = post.match(/PlayerNewsPost-analysis">(.*?)<div class="PlayerNewsPost-author/s)?.[1] || '';
    const time = post.match(/data-date="([^"]+)"/)?.[1];
    const link = post.match(/PlayerNewsPost-moreNewsLink" href="([^"]+)"/)?.[1] || 'https://www.nbcsports.com/fantasy/basketball/player-news';
    if (!headline || !time || !(first || last)) continue;
    out.push({ name: decode(`${first} ${last}`.trim()), headline: stripHtml(headline), text: stripHtml(analysis), time, url: link });
  }
  return out;
}

// ---------- news ----------
// RotoWire blurbs via ESPN's per-player fantasy feed.
export async function fetchPlayerNews(playerId) {
  const data = await get(`https://site.api.espn.com/apis/fantasy/v2/games/fba/news/players?playerId=${playerId}&limit=6`, { json: true, timeout: 15000 });
  return (data.feed || [])
    .filter((f) => f.type === 'Rotowire' && f.headline)
    .map((f) => ({
      id: `rw-${f.id}`, playerId, time: f.published, source: 'RotoWire via ESPN',
      headline: stripHtml(f.headline), text: stripHtml(f.story || f.description || ''),
      url: `https://www.espn.com/nba/player/_/id/${playerId}`,
    }));
}

export async function fetchHeadlines() {
  const data = await get('https://site.api.espn.com/apis/site/v2/sports/basketball/nba/news?limit=50', { json: true });
  return (data.articles || [])
    .filter((a) => a.type === 'HeadlineNews' || a.type === 'Story')
    .map((a) => ({
      id: `espn-${a.id}`, time: a.published, source: 'ESPN',
      headline: a.headline, text: a.description || '',
      url: a.links?.web?.href || '',
      athleteIds: (a.categories || []).filter((c) => c.type === 'athlete' && c.athleteId).map((c) => c.athleteId),
    }));
}

// Run async jobs with a concurrency cap; failures become null.
export async function pool(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++;
      try { out[idx] = await fn(items[idx]); } catch { out[idx] = null; }
    }
  }));
  return out;
}
