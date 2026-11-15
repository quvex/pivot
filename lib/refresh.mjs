// Daily refresh: pull every source, rebuild projections / consensus / signals, save a snapshot.
// Run directly (`npm run refresh`) or through the server.
import { fileURLToPath } from 'node:url';
import * as src from './sources.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { scorePlayers, projectPlayers, buildConsensus, buildMarket, buildSignals, fantasyPoints } from './model.mjs';
import { fetchSeasonLogs } from './history.mjs';
import { fetchLatestReport } from './reports.mjs';
import { missedInARow } from './absence.mjs';
import { loadParams } from './estimator.mjs';
import { classify, aiBriefing, compatibleJson } from './news.mjs';
import { extractTimetables, loadTimetables, timetableIndex } from './headlines.mjs';
import { loadSettings, saveSettings, saveLatest, saveSnapshot, loadSnapshotBefore, dayKey, STAT_LABELS, DEFAULT_SCORING, DATA_DIR, aiReady, savePredictions, loadPredictions } from './store.mjs';
import { scoreLive } from './livescore.mjs';

// Sleeper's player directory is big and slow-moving: keep it for a week.
const SLEEPER_FILE = path.join(DATA_DIR, 'sleeper-players.json');
const sleeperCache = {
  get: () => { try { const st = fs.statSync(SLEEPER_FILE); return Date.now() - st.mtimeMs < 7 * 86400000 ? JSON.parse(fs.readFileSync(SLEEPER_FILE, 'utf8')) : null; } catch { return null; } },
  set: (v) => { try { fs.writeFileSync(SLEEPER_FILE, JSON.stringify(v)); } catch { /* cache only */ } },
};

const NEWS_WINDOW_MS = 72 * 3600 * 1000;

export async function refresh({ log = console.log } = {}) {
  let settings = loadSettings();
  const now = Date.now();
  const status = []; // one row per source, shown in Settings
  const track = async (key, label, fn, summarize) => {
    const t0 = Date.now();
    try {
      const value = await fn();
      status.push({ key, label, ok: true, detail: summarize(value), ms: Date.now() - t0 });
      return value;
    } catch (e) {
      log(`  ! ${label}: ${e.message}`);
      status.push({ key, label, ok: false, detail: e.message, ms: Date.now() - t0 });
      return null;
    }
  };

  log('Fetching sources...');
  const [players, league, injuries, hashtag, bbm, fpros, headlines, proSchedule, logs, fprosProj, lineups, sleeper, rotoworld, official] = await Promise.all([
    track('espn', 'ESPN player pool', () => src.fetchEspnPlayers(settings.season), (v) => `${v.length} players`),
    settings.leagueId
      ? track('league', 'ESPN league', () => src.fetchEspnLeague(settings), (v) => `${v.name}: ${v.teams.length} teams`)
      : null,
    track('injuries', 'ESPN injury report', () => src.fetchInjuries(), (v) => `${v.length} injuries`),
    track('hashtag', 'Hashtag Basketball', () => src.fetchHashtag(), (v) => `${v.list.length} ranked`),
    track('bbm', 'Basketball Monster', () => src.fetchBasketballMonster(), (v) => `${v.list.length} ranked`),
    track('fpros', 'FantasyPros', () => src.fetchFantasyPros(), (v) => `${v.list.length} ranked`),
    track('headlines', 'ESPN headlines', () => src.fetchHeadlines(), (v) => `${v.length} articles`),
    track('schedule', 'NBA schedule', () => src.fetchProSchedule(settings.season), (v) => `${Object.values(src.teamSchedule(v, now - 86400000, now + 16 * 86400000)).flat().length / 2} games in the next 16 days`),
    track('logs', 'ESPN game logs', () => fetchSeasonLogs(settings.season, 450), (v) => `${v.players.reduce((a, p) => a + p.games.length, 0)} box scores`),
    track('fprosProj', 'FantasyPros projections', () => src.fetchFantasyProsProjections(), (v) => `${v.list.length} projected`),
    track('lineups', 'RotoWire lineups', () => src.fetchLineups(), (v) => `${v.filter((x) => x.starter).length} starters listed for today`),
    track('sleeper', 'Sleeper trends', () => src.fetchSleeper(sleeperCache.get, sleeperCache.set), (v) => `${v.adds.length} trending adds, ${v.drops.length} drops`),
    track('rotoworld', 'Rotoworld news (NBC Sports)', () => src.fetchRotoworld(), (v) => `${v.length} items`),
    track('nbaReport', 'NBA official injury report', () => fetchLatestReport(now), (v) => `${v.rows.length} players listed (${v.date})`),
  ]);
  const schedule = proSchedule ? src.teamSchedule(proSchedule, now - 86400000, now + 16 * 86400000) : null;
  const periodDates = proSchedule ? src.periodDates(proSchedule) : {};
  if (!players?.length) throw new Error('Could not load the ESPN player pool, so nothing was updated. Check your connection and try again.');

  // league scoring wins unless the user customised it
  if (league && settings.scoringSource !== 'custom' && Object.keys(league.scoring).length) {
    settings = saveSettings({ scoring: league.scoring, scoringSource: 'league' });
  } else if (settings.scoringSource === 'league') {
    // no league, or a category league with no points settings: fall back to ESPN default points
    settings = saveSettings({ scoring: DEFAULT_SCORING, scoringSource: 'default' });
  }
  if (league && !settings.teamId) {
    const mineTeam = league.teams.find((t) => t.isMine);
    if (mineTeam) settings = saveSettings({ teamId: mineTeam.id });
  }

  const findId = src.buildNameIndex(players);
  const byId = new Map(players.map((p) => [p.id, p]));
  scorePlayers(players, settings.scoring);

  // game logs, scored with the league's settings
  let nowDay = 0;
  for (const lp of logs?.players || []) {
    const p = byId.get(lp.id);
    if (!p) continue;
    p.log = lp.games.map((g) => ({ d: g.d, min: g.s[40], fp: Math.round(fantasyPoints(g.s, settings.scoring) * 10) / 10, fgm: g.s[13] || 0, fga: g.s[14] || 0, gs: g.s[41] ? 1 : 0 }));
    for (const g of lp.games) if (g.d > nowDay) nowDay = g.d;
  }
  // how many of his team's games each player has just missed in a row
  const teamDays = {};
  for (const lp of logs?.players || []) for (const g of lp.games) (teamDays[g.t] ||= new Set()).add(g.d);
  for (const t in teamDays) teamDays[t] = [...teamDays[t]].sort((a, b) => a - b);
  for (const lp of logs?.players || []) {
    const p = byId.get(lp.id), team = p && src.PRO_TEAM_ID[p.team];
    if (!team || !teamDays[team] || !lp.games.length) continue;
    p.out = missedInARow(teamDays[team], new Set(lp.games.filter((g) => g.t === team).map((g) => g.d)), nowDay);
  }

  // FantasyPros projections: rebuild makes and attempts from the player's own shot profile
  const fpList = [];
  for (const row of fprosProj?.list || []) {
    const p = byId.get(findId(row.name));
    if (!p || p.ext?.fpros) continue;
    const ref = (p.s.season?.gp >= 5 && p.s.season.pts > 0 ? p.s.season : null) || p.s.proj || p.s.prev;
    const ftm = row.pts * (ref && ref.pts > 0 ? Math.min(0.4, ref.ftm / ref.pts) : 0.17);
    const fgm = Math.max(0, (row.pts - row.tpm - ftm) / 2);
    const avg = { 0: row.pts, 6: row.reb, 3: row.ast, 1: row.blk, 2: row.stl, 17: row.tpm, 11: row.to, 13: fgm, 14: row.fgp > 0 ? fgm / row.fgp : 0, 15: ftm, 16: row.ftp > 0 ? ftm / row.ftp : 0 };
    (p.ext ||= {}).fpros = { fp: Math.round(fantasyPoints(avg, settings.scoring) * 10) / 10, min: row.min, gp: row.gp };
    fpList.push({ id: p.id, fp: p.ext.fpros.fp });
  }
  fpList.sort((a, b) => b.fp - a.fp);

  for (const l of lineups || []) {
    const p = byId.get(findId(l.name));
    if (p) p.lineup = { starter: l.starter, confirmed: l.confirmed, playPct: l.playPct, status: l.status };
  }
  if (sleeper) {
    const crowd = (p) => (p.crowd ||= { adds: 0, drops: 0 });
    for (const t of sleeper.adds) { const p = byId.get(findId(t.name)); if (p) crowd(p).adds = t.count; }
    for (const t of sleeper.drops) { const p = byId.get(findId(t.name)); if (p) crowd(p).drops = t.count; }
    for (const i of sleeper.info) {
      const p = byId.get(findId(i.name));
      if (!p) continue;
      if (i.depth != null) p.depth = i.depth;
      if (i.jersey != null && i.jersey !== '') p.jersey = String(i.jersey);
      if (i.height) p.height = i.height;
      if (i.weight) p.weight = i.weight;
      if (i.born) p.age = Math.floor((now - new Date(i.born).getTime()) / (365.25 * 86400000));
    }
  }

  for (const inj of injuries || []) {
    const p = byId.get(findId(inj.name));
    if (p) p.injury = { status: inj.status, type: inj.type, detail: inj.detail, returnDate: inj.returnDate, comment: inj.comment, date: inj.date };
  }
  // Timetables stated in headlines ("out four to six weeks"), read by the language model when one
  // is configured (headlines.mjs). Facts from earlier days are kept, so a timetable given last
  // week still counts today.
  const tagged = (headlines || []).filter((h) => h.athleteIds?.some((a) => byId.has(a)))
    .map((h) => ({ id: String(h.id).replace(/^espn-/, ''), time: h.time, headline: h.headline, text: h.text, athletes: h.athleteIds.filter((a) => byId.has(a)).slice(0, 4) }));
  let stated = loadTimetables().events;
  if (tagged.length && settings.aiProvider === 'compatible' && aiReady(settings)) {
    const names = new Map(players.map((p) => [p.id, p.name]));
    const read = await track('timetables', 'Headline timetables', () => extractTimetables(tagged, names, async (system, user) => (await compatibleJson(settings, system, user)).parsed), (v) => `${v.length} stated absences and returns on file`);
    if (read) stated = read;
  }
  if (stated.length) {
    const said = timetableIndex(stated);
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(new Date(now));
    for (const p of players) { const tl = said(p.id, today); if (tl) p.timetable = tl; }
  }
  // the league's own report: status and the written reason, which the model grades (reasons.mjs)
  for (const row of official?.rows || []) {
    const p = byId.get(findId(row.name));
    if (p) p.report = { status: row.status, reason: row.reason };
  }

  // player news: only fetch feeds for players ESPN says have something recent
  const leagueIds = new Set((league?.teams || []).flatMap((t) => t.roster));
  const fresh = players
    .filter((p) => now - p.lastNewsDate < NEWS_WINDOW_MS && (p.owned >= 2 || leagueIds.has(p.id)))
    .slice(0, 160);
  log(`Fetching news for ${fresh.length} players...`);
  const feeds = await src.pool(fresh, 8, (p) => src.fetchPlayerNews(p.id));
  const failed = feeds.filter((f) => f === null).length;
  status.push({ key: 'news', label: 'Player news (RotoWire via ESPN)', ok: failed < fresh.length || !fresh.length, detail: `${fresh.length - failed}/${fresh.length} player feeds`, ms: 0 });

  const news = [];
  const seen = new Set();
  for (const feed of feeds) {
    for (const item of feed || []) {
      const t = new Date(item.time).getTime();
      if (now - t > NEWS_WINDOW_MS || seen.has(item.id)) continue;
      seen.add(item.id);
      news.push({ ...item, time: t, ...classify(item.headline, item.text) });
    }
  }
  for (const item of rotoworld || []) {
    const playerId = findId(item.name);
    const t = new Date(item.time).getTime();
    if (!playerId || !(now - t < NEWS_WINDOW_MS)) continue;
    news.push({ id: `rwld-${playerId}-${t}`, playerId, time: t, source: 'Rotoworld (NBC Sports)', headline: item.headline, text: item.text, url: item.url, ...classify(item.headline, item.text) });
  }
  news.sort((a, b) => b.time - a.time);

  // role tags feed the model: use each player's most recent role-changing item from the last 4 days
  const ROLE_TAGS = ['starting', 'bench', 'minutes_limit', 'season_ending'];
  for (const item of [...news].reverse()) {
    const p = byId.get(item.playerId);
    if (!p || !ROLE_TAGS.includes(item.tag)) continue;
    const others = (p.tags || []).filter((t) => (item.tag === 'starting' ? t !== 'bench' : item.tag === 'bench' ? t !== 'starting' : true));
    p.tags = [...new Set([...others, item.tag])];
  }
  // one item per player per topic keeps the feed readable
  const perPlayer = new Map();
  const trimmed = news.filter((n) => {
    // statuses supersede each other (a "returning" item makes an older "questionable" stale)
    const group = ['season_ending', 'extended', 'out', 'questionable', 'returning'].includes(n.tag) ? 'status'
      : ['starting', 'bench', 'minutes_limit'].includes(n.tag) ? 'role' : n.tag;
    const k = `${n.playerId}:${group}`;
    if (perPlayer.has(k)) return false;
    perPlayer.set(k, 1);
    return true;
  });

  const rosterSpots = league ? league.teams.length * 13 : 130;
  // In a games-capped league only so many more games can count, which raises replacement level.
  const capGames = league?.format.capTotal
    ? league.teams.reduce((a, t) => a + Math.max(0, league.format.capTotal - t.gamesUsed), 0) : 0;
  const ctx = projectPlayers(players, { now, rosterSpots, capGames, nowDay, scoring: settings.scoring });

  // consensus across outside sources (our own model is shown beside it, not inside it)
  const espnProj = players.filter((p) => p.s.proj).sort((a, b) => b.s.proj.fp - a.s.proj.fp).map((p, i) => ({ id: p.id, rank: i + 1 }));
  const sources = [];
  if (espnProj.length) sources.push({ key: 'espn', label: 'ESPN', full: 'ESPN projections', url: 'https://fantasy.espn.com/basketball/players/projections', basis: 'ESPN season projections scored with your league settings', list: espnProj });
  if (fpList.length) {
    const st = status.find((x) => x.key === 'fprosProj');
    if (st) st.detail += `, ${fpList.length} matched`;
    sources.push({ key: 'fprosProj', label: fprosProj.label, full: fprosProj.full, url: fprosProj.url, basis: fprosProj.basis, list: fpList.map((r, i) => ({ id: r.id, rank: i + 1 })) });
  }
  for (const [key, s] of [['hashtag', hashtag], ['bbm', bbm], ['fpros', fpros]]) {
    if (!s) continue;
    const list = s.list.map((r) => ({ id: findId(r.name), rank: r.rank })).filter((r) => r.id);
    const st = status.find((x) => x.key === key);
    if (st) st.detail += `, ${list.length} matched`;
    sources.push({ key, label: s.label, full: s.full, url: s.url, basis: s.basis, list });
  }
  buildConsensus(players, sources);
  buildMarket(players, ctx);
  buildSignals(players, settings.scoring, ctx);

  // day-over-day movement from saved snapshots
  const today = dayKey(new Date(now));
  const prevDay = loadSnapshotBefore(today, 1);
  const prevWeek = loadSnapshotBefore(today, 7);
  for (const p of players) {
    const d = prevDay?.players[p.id];
    const w = prevWeek?.players[p.id];
    p.delta = {
      fpg: d ? Math.round((p.model.fpg - d.f) * 10) / 10 : null,
      rank: d ? d.r - p.model.rank : null,
      rankWeek: w ? w.r - p.model.rank : null,
    };
    delete p.lastNewsDate;
  }
  // live track record: save today's projections, then score the ones old enough to judge
  if (nowDay > 0) {
    const p = {};
    for (const pl of players) {
      if (pl.team === 'FA' || !(pl.model.fpg > 0) || !(pl.model.rank <= 250)) continue;
      p[pl.id] = [pl.model.fpg, pl.s.season?.gp >= 1 ? pl.s.season.fp : null];
    }
    savePredictions(today, { day: nowDay, season: settings.season, p });
  }
  const live = scoreLive(loadPredictions(), players, { season: settings.season, nowDay });

  saveSnapshot(today, Object.fromEntries(players.map((p) => [p.id, { f: p.model.fpg, r: p.model.rank, c: p.consensus?.rank ?? null }])));

  const data = {
    meta: {
      refreshedAt: now, day: today, season: settings.season, scoring: settings.scoring, scoringSource: settings.scoringSource,
      statLabels: STAT_LABELS, repl: ctx.repl, leagueGp: ctx.leagueGp, nowDay, comparedTo: prevDay?.day || null,
      backtest: loadParams().report || null,
      live,
      sources: sources.map(({ key, label, full, url, basis, list }) => ({ key, label, full, url, basis, count: list.length })),
      status,
    },
    league: league || null,
    schedule: schedule || {},
    periodDates,
    players,
    news: trimmed,
    headlines: (headlines || []).filter((h) => now - new Date(h.time).getTime() < NEWS_WINDOW_MS).slice(0, 20)
      .map((h) => ({ ...h, time: new Date(h.time).getTime() })),
    ai: null,
  };

  if (aiReady(settings)) {
    log('Asking the model for the league briefing...');
    data.ai = await track('ai', 'Written briefing', () => aiBriefing(trimmed, data, settings), (v) => (v ? `${v.briefing.length} takeaways from ${v.model}` : 'no news to summarise'));
    data.meta.status = status;
  }

  saveLatest(data);
  log(`Done: ${players.length} players, ${trimmed.length} news items, ${sources.length} ranking sources.`);
  return data;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  refresh().catch((e) => { console.error(e.message); process.exit(1); });
}
