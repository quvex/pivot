// Past trades: what each side has produced since the deal, and what is still expected.
//
// ESPN's league activity log records every accepted trade as a set of moves (player, from team, to
// team). For each trade this lines up the box scores from the day of the deal onward:
//   before  each player's FP/G this season up to the trade
//   since   his games, FP/G and total fantasy points after it
//   ahead   what the model still expects from him: FP/G x expected games
// and a running total for each side, day by day, so the deal can be drawn as two lines.
// "Since" counts every game a player played, whether or not his new team had him in the lineup.

const r1 = (x) => Math.round(x * 10) / 10;
const ET = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' });

// trades: [{ id, date (ms), moves: [{ playerId, from, to }] }]
// data: the refresh dataset (players with .log, league.teams, periodDates). myTeamId may be null.
export function buildPastTrades(trades, data, myTeamId = null) {
  if (!trades?.length || !data?.league) return [];
  const byId = new Map(data.players.map((p) => [p.id, p]));
  const teamName = new Map(data.league.teams.map((t) => [t.id, t.name]));
  const dateOf = data.periodDates || {};
  const today = ET.format(new Date(data.meta?.refreshedAt || Date.now()));

  return trades.map((t) => {
    const day = ET.format(new Date(t.date));
    const sides = new Map(); // receiving team -> players
    for (const m of t.moves) {
      if (!sides.has(m.to)) sides.set(m.to, []);
      const p = byId.get(m.playerId);
      const games = (p?.log || []).map((g) => ({ date: dateOf[g.d], fp: g.fp })).filter((g) => g.date);
      const before = games.filter((g) => g.date < day), since = games.filter((g) => g.date >= day);
      const sum = (a) => a.reduce((x, g) => x + g.fp, 0);
      sides.get(m.to).push({
        id: m.playerId, name: p?.name || 'A player no longer in the pool', team: p?.team || '', pos: p?.pos || '', from: m.from,
        before: { gp: before.length, fpg: before.length ? r1(sum(before) / before.length) : null },
        since: { gp: since.length, fpg: since.length ? r1(sum(since) / since.length) : null, total: Math.round(sum(since)) },
        ahead: p ? { fpg: p.model.fpg, games: p.avail.games, total: Math.round(p.model.fpg * p.avail.games) } : null,
        note: p?.avail.note || '',
        games: since,
      });
    }
    // every date from the trade to today, with each side's running total
    const dates = [...new Set([...sides.values()].flat().flatMap((p) => p.games.map((g) => g.date)))].filter((d) => d <= today).sort();
    const out = [...sides.entries()].map(([teamId, players]) => {
      let run = 0;
      const line = dates.map((d) => { for (const p of players) for (const g of p.games) if (g.date === d) run += g.fp; return Math.round(run); });
      const gp = players.reduce((a, p) => a + p.since.gp, 0), total = players.reduce((a, p) => a + p.since.total, 0);
      return {
        teamId, team: teamName.get(teamId) || `Team ${teamId}`, mine: teamId === myTeamId,
        players: players.map((p) => { const rest = { ...p }; delete rest.games; return rest; }),
        since: { gp, total, fpg: gp ? r1(total / gp) : null },
        ahead: Math.round(players.reduce((a, p) => a + (p.ahead?.total || 0), 0)),
        line,
      };
    });
    // my side first; otherwise the side that has done better
    out.sort((a, b) => b.mine - a.mine || b.since.total - a.since.total);
    return { id: t.id, date: t.date, day, mine: out.some((s) => s.mine), dates, sides: out };
  }).sort((a, b) => b.mine - a.mine || b.date - a.date);
}
