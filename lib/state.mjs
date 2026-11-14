// The page state the UI renders, built from the latest dataset and the user's settings.
// Shared by the local server and the static demo build.
import { publicSettings, DEFAULT_SCORING, STAT_LABELS } from './store.mjs';
import { ownership } from './ownership.mjs';
import { outcomesFor } from './news.mjs';
import { recommendTrades, recommendWaivers, weekPlan, capOutlook } from './model.mjs';
import { tradeContext, evaluateTrade } from './trade.mjs';

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
  let mine = null;
  const teams = lg.teams.map((t) => {
    const roster = t.roster.map((id) => byId.get(id)).filter(Boolean);
    const plan = weekPlan(roster, data.schedule || {}, f.slotCounts, now);
    const cap = capped ? capOutlook(roster, t.points, t.gamesUsed, f.capTotal, repl) : null;
    const row = {
      id: t.id, name: t.name, mine: own.myTeam?.id === t.id, points: Math.round(t.points), gamesUsed: t.gamesUsed,
      perGame: t.gamesUsed ? Math.round((t.points / t.gamesUsed) * 10) / 10 : null,
      pace: capped ? Math.round(t.gamesUsed - f.capTotal * frac) : null,
      week: plan.totals, projected: cap?.projected ?? null, capLine: cap?.capLine ?? null,
    };
    if (row.mine) mine = { t, roster, plan, cap, row };
    return row;
  }).sort((a, b) => b.points - a.points);
  teams.forEach((t, i) => { t.rank = i + 1; });
  const out = { capped, capTotal: f.capTotal, scoringType: f.scoringType, seasonPct: Math.round(frac * 100), teams, my: null };
  if (!mine) return out;

  const { t, roster, plan, cap, row } = mine;
  const advice = [];
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
  const trades = hasRoster ? recommendTrades(data.players, own.mine, owners).map((t) => evaluateTrade(ctx, t.give, t.get)).filter((t) => t && t.delta > 0) : [];

  const isFree = (p) => { const o = own.get(p.id); return o.type === 'fa' || (o.type === 'unknown' && p.owned < 60); };
  const waivers = recommendWaivers(data.players, own.mine, isFree, data.meta.repl);

  return {
    ...base, ready: true, meta: data.meta, players, news, headlines: data.headlines, briefing, trades, waivers, week: buildWeek(data, own), hasRoster,
    league: data.league ? { id: data.league.id, name: data.league.name, teams: data.league.teams.map(({ id, name, owner, roster }) => ({ id, name, owner, size: roster.length, roster })) } : null,
    myTeam: own.myTeam ? { id: own.myTeam.id, name: own.myTeam.name } : null,
  };
}

