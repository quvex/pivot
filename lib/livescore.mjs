// Live track record: every daily update saves its projections (store.savePredictions). Once a
// snapshot is a week old, each player's projection is compared with what he has averaged since,
// next to the simplest alternative: his season average on the day the projection was made.
// Unlike the backtest, nothing here could have been tuned on the answer.

const MIN_AGE_DAYS = 7;   // scoring periods (days) a snapshot must age before it is scored
const MIN_GAMES = 3;      // games a player must have played since, to be scored

// snapshots: [{ date, day, season, p: { id: [modelFpg, seasonAvgThen] } }]
// players: [{ id, log: [{ d, fp }] }] for the current season. nowDay: today's scoring period.
export function scoreLive(snapshots, players, { season, nowDay }) {
  const logs = new Map(players.filter((p) => p.log?.length).map((p) => [p.id, p.log]));
  const r2 = (x) => Math.round(x * 100) / 100;
  const scored = [];
  let pending = null;
  for (const snap of [...snapshots].sort((a, b) => a.day - b.day)) {
    if (snap.season !== season) continue;
    if (nowDay - snap.day < MIN_AGE_DAYS) { pending ||= snap; continue; }
    let n = 0, model = 0, base = 0;
    for (const [id, [fpg, seasonAvg]] of Object.entries(snap.p)) {
      if (seasonAvg == null) continue;
      const after = (logs.get(+id) || []).filter((g) => g.d > snap.day);
      if (after.length < MIN_GAMES) continue;
      const actual = after.reduce((a, g) => a + g.fp, 0) / after.length;
      n++; model += Math.abs(fpg - actual); base += Math.abs(seasonAvg - actual);
    }
    if (n) scored.push({ date: snap.date, day: snap.day, n, model: r2(model / n), seasonAvg: r2(base / n) });
  }
  const total = scored.reduce((a, s) => a + s.n, 0);
  const avg = (k) => (total ? r2(scored.reduce((a, s) => a + s[k] * s.n, 0) / total) : null);
  return {
    snapshots: snapshots.filter((s) => s.season === season).length,
    scored,
    overall: total ? { n: total, model: avg('model'), seasonAvg: avg('seasonAvg') } : null,
    // the first snapshot still waiting to be old enough to score
    nextScoredOn: pending ? pending.day + MIN_AGE_DAYS - nowDay : null,
  };
}
