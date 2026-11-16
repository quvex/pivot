// The page state the UI renders, built from the latest dataset and the user's settings.
// Shared by the local server and the static demo build.
import { publicSettings, DEFAULT_SCORING, STAT_LABELS } from './store.mjs';
import { ownership } from './ownership.mjs';
import { outcomesFor } from './news.mjs';
import { recommendTrades, recommendWaivers, weekPlan, capOutlook, planOver, matchupOdds } from './model.mjs';
import { tradeContext, evaluateTrade } from './trade.mjs';
import { buildPastTrades } from './pasttrades.mjs';

const SLOT_LABELS = { 0: 'PG', 1: 'SG', 2: 'SF', 3: 'PF', 4: 'C', 5: 'G', 6: 'F', 7: 'SG/SF', 8: 'G/F', 9: 'PF/C', 10: 'F/C', 11: 'UTIL' };

// Standings outlook and my day-by-day plan. Needs a synced league.
export function buildWeek(data, own) {
  const lg = data.league;
  if (!lg?.format) return null;
  const f = lg.format;
  const now = Date.now();
  const byId = new Map(data.players.map((p) => [p.id, p]));
  const capped = f.capTotal > 0;
  const frac = Math.min(1, (data.meta.leagueGp || 0) / 82); // share of the NBA season played
  const repl = data.meta.repl;
  const h2h = f.kind === 'h2h' || f.kind === 'categories';
  const plans = new Map();
  let mine = null;
  const teams = lg.teams.map((t) => {
    const roster = t.roster.map((id) => byId.get(id)).filter(Boolean);
    const plan = weekPlan(roster, data.schedule || {}, f.slotCounts, now);
    plans.set(t.id, plan);
    const cap = capped ? capOutlook(roster, t.points, t.gamesUsed, f.capTotal, repl) : null;
    const row = {
      id: t.id, name: t.name, mine: own.myTeam?.id === t.id, points: Math.round(t.points), gamesUsed: t.gamesUsed,
      perGame: t.gamesUsed ? Math.round((t.points / t.gamesUsed) * 10) / 10 : null,
      pace: capped ? Math.round(t.gamesUsed - f.capTotal * frac) : null,
      week: plan.totals, projected: cap?.projected ?? null, capLine: cap?.capLine ?? null,
      record: t.record || null, pointsFor: Math.round(t.record?.pointsFor ?? t.points),
    };
    if (row.mine) mine = { t, roster, plan, cap, row };
    return row;
  });
  // head-to-head standings go by record, then points scored
  const pct = (r) => (r ? (r.wins + r.ties / 2) / Math.max(1, r.wins + r.losses + r.ties) : 0);
  teams.sort(h2h ? (a, b) => pct(b.record) - pct(a.record) || b.pointsFor - a.pointsFor : (a, b) => b.points - a.points);
  teams.forEach((t, i) => { t.rank = i + 1; });
  const out = { capped, capTotal: f.capTotal, scoringType: f.scoringType, kind: f.kind || 'season', formatLabel: f.label || '', supported: f.supported !== false, seasonPct: Math.round(frac * 100), teams, my: null, h2h: null };

  // the current matchup week: score so far plus the projected rest of the week, for every pairing
  if (f.kind === 'h2h' && f.currentMatchupPeriod != null) {
    const period = f.currentMatchupPeriod;
    const dates = [...new Set((f.matchupPeriods?.[period] || []).map((sp) => data.periodDates?.[sp]).filter(Boolean))].sort();
    const set = new Set(dates);
    const name = new Map(lg.teams.map((t) => [t.id, t.name]));
    const side = (id, points) => ({ id, name: name.get(id), points: Math.round(points), ...planOver(plans.get(id) || { days: [] }, set) });
    const games = (lg.matchups || []).filter((m) => m.period === period).map((m) => {
      const home = side(m.home, m.homePoints), away = side(m.away, m.awayPoints);
      const odds = matchupOdds(home, away);
      home.projected = odds.projected[0]; away.projected = odds.projected[1];
      return { home, away, homeWin: odds.win };
    });
    out.h2h = { period, from: dates[0] || null, to: dates.at(-1) || null, games };
    for (const g of games) {
      for (const [me, opp, win] of [[g.home, g.away, g.homeWin], [g.away, g.home, 1 - g.homeWin]]) {
        const row = teams.find((r) => r.id === me.id);
        if (row) row.matchup = { projected: me.projected, opp: opp.name, oppProjected: opp.projected, win: Math.round(win * 100) / 100 };
      }
    }
  }
  if (!mine) return out;

  const { t, roster, plan, cap, row } = mine;
  const advice = [];
  if (f.kind === 'categories') advice.push(`This league is ${f.label.toLowerCase()}. Pivot projects fantasy points, so its rankings and trade values here use ESPN's default points scoring as a stand-in for category value.`);
  const myGame = out.h2h?.games.find((g) => g.home.id === t.id || g.away.id === t.id);
  if (myGame) {
    const me = myGame.home.id === t.id ? myGame.home : myGame.away;
    const opp = me === myGame.home ? myGame.away : myGame.home;
    const win = me === myGame.home ? myGame.homeWin : 1 - myGame.homeWin;
    advice.push(`Matchup with ${opp.name}: projected ${me.projected.toLocaleString('en-US')} to ${opp.projected.toLocaleString('en-US')}, a ${Math.round(win * 100)}% chance to win.`);
    if (me.open > 0) advice.push(`You have ${me.open} empty lineup slot${me.open === 1 ? '' : 's'} over the rest of the matchup. Streaming a free agent who plays on those days adds points that only count this week.`);
  }
  if (capped) {
    const left = f.capTotal - t.gamesUsed;
    if (row.pace >= 5) advice.push(`You have used ${t.gamesUsed} of ${f.capTotal} games with ${out.seasonPct}% of the season played: ${row.pace} ahead of an even pace. You will run out before the season ends unless you skip about ${row.pace} of your weakest starts, so save games for players above your cap line.`);
    else if (row.pace <= -5) advice.push(`You have used ${t.gamesUsed} of ${f.capTotal} games: ${-row.pace} behind an even pace. Unused games are wasted points, so start everyone who is playing and consider adding players with busy schedules.`);
    else advice.push(`Games pace is on track: ${t.gamesUsed} of ${f.capTotal} used, ${left} left.`);
    if (row.pace > -5) {
      const weak = roster.filter((p) => p.model.next < cap.capLine - 0.5 && (plan.perPlayer[p.id].exp[0] + plan.perPlayer[p.id].exp[1]) > 0)
        .sort((a, b) => a.model.next - b.model.next);
      for (const p of weak) advice.push(`Sit ${p.name} (${p.model.next} FP/G): he is below your cap line of ${cap.capLine}, so each start costs about ${(cap.capLine - p.model.next).toFixed(1)} points compared with saving the game for a better player.`);
    }
  }
  const irIds = new Set(t.ir || []);
  const irSlots = f.slotCounts[13] || 0;
  for (const p of roster) {
    if (irIds.has(p.id) && p.injuryStatus === 'ACTIVE') advice.push(`${p.name} is healthy but still in your IR slot: activate him.`);
    else if (!irIds.has(p.id) && p.avail.missed >= 3) {
      advice.push(irIds.size < irSlots ? `${p.name} is out (${p.avail.note}): move him to IR to open a roster spot.`
        : `${p.name} is out (${p.avail.note}) and your IR slot is taken, so he is using a roster spot.`);
    } else if (p.injuryStatus === 'DAY_TO_DAY') advice.push(`${p.name} is day-to-day: check his status before his next game locks.`);
  }
  out.my = {
    name: t.name, capLine: cap?.capLine ?? null, projected: cap?.projected ?? null, advice,
    days: plan.days,
    players: roster.map((p) => ({ id: p.id, inIR: irIds.has(p.id), ...plan.perPlayer[p.id] }))
      .sort((a, b) => (b.pts[0] + b.pts[1]) - (a.pts[0] + a.pts[1])),
    slots: capped ? Object.entries(f.slotLimits).map(([slot, limit]) => ({
      label: SLOT_LABELS[slot] || slot, limit, used: t.slotUsed[slot] || 0, even: Math.round(limit * frac),
    })) : [],
  };
  return out;
}

// Everything the UI needs, with league context applied.
export function buildState(data, settings, job = { running: false, error: null, startedAt: null }) {
  const base = { settings: publicSettings(settings), job, statLabels: STAT_LABELS, defaultScoring: DEFAULT_SCORING };
  if (!data) return { ...base, ready: false };
  const own = ownership(data, settings);
  const byId = new Map(data.players.map((p) => [p.id, p]));
  const players = data.players.map((p) => ({ ...p, own: own.get(p.id) }));

  const news = data.news.map((n) => {
    const { relevance, lines } = outcomesFor(n, byId, own, data.meta.repl);
    const p = byId.get(n.playerId);
    return { ...n, name: p?.name, team: p?.team, pos: p?.pos, own: own.get(n.playerId), relevance, lines, ai: data.ai?.outcomes?.[n.id] || null };
  }).sort((a, b) => b.relevance - a.relevance || b.sev - a.sev || b.time - a.time);

  const briefing = data.ai?.briefing?.length
    ? { by: 'claude', model: data.ai.model, lines: data.ai.briefing }
    : { by: 'rules', lines: news.filter((n) => n.relevance >= 2 && n.sev >= 1 && n.lines.length).slice(0, 6).map((n) => n.lines[0]) };

  const hasRoster = own.mine.size > 0;
  const owners = own.synced ? new Map([...own.map].filter(([, o]) => o.type === 'team').map(([id, o]) => [id, o.team])) : null;
  // every recommended trade goes through the same engine as the analyser, so the reasoning matches
  const ctx = tradeContext(data, own);
  const locked = new Set(settings.untouchables || []);
  const trades = hasRoster ? recommendTrades(data.players, own.mine, owners).filter((t) => ![...t.give, ...t.get].some((id) => locked.has(id))).map((t) => evaluateTrade(ctx, t.give, t.get)).filter((t) => t && t.delta > 0) : [];

  const isFree = (p) => { const o = own.get(p.id); return o.type === 'fa' || (o.type === 'unknown' && p.owned < 60); };
  const waivers = recommendWaivers(data.players, own.mine, isFree, data.meta.repl);

  return {
    ...base, ready: true, meta: data.meta, players, news, headlines: data.headlines, briefing, trades, waivers, week: buildWeek(data, own), hasRoster,
    pastTrades: buildPastTrades(data.leagueTrades, data, own.myTeam?.id ?? null),
    league: data.league ? { id: data.league.id, name: data.league.name, teams: data.league.teams.map(({ id, name, owner, roster }) => ({ id, name, owner, size: roster.length, roster })) } : null,
    myTeam: own.myTeam ? { id: own.myTeam.id, name: own.myTeam.name } : null,
  };
}

