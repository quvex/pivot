// What an absence is worth, measured on past seasons.
//
// Two things follow from a player being out, and both are looked up the same way:
//   how much of the coming games he plays (the next two weeks, and the rest of the season)
//   how far below his usual level he produces once he is back (the "return dip")
// Each is a table of averages keyed by what is known on the day, from coarse to fine:
//   1. how many of his team's games he has just missed in a row            (box scores alone)
//   2. plus his status on the league's injury report                        (news)
//   3. plus how serious the written reason is, as graded in reasons.mjs     (news, read by a model)
//   4. plus any timetable a headline has stated for him (headlines.mjs)      (news, read by a model)
// A fine cell with few examples is pulled toward the coarser cell above it, so a rare combination
// never gets a wild number. Looking up with less information simply stops at a coarser level.

export const streakBucket = (k) => (k <= 0 ? 0 : k <= 2 ? 1 : k <= 7 ? 2 : k <= 20 ? 3 : 4);
export const STREAK_LABELS = ['playing', 'out 1-2 games', 'out 3-7', 'out 8-20', 'out 21+'];
export const statusGroup = (s) => (s === 'Out' || s === 'Doubtful' ? 'out' : s === 'Questionable' ? 'q' : s === 'Probable' || s === 'Available' ? 'ok' : 'none');

const keys = ({ k, status, sev, tl }) => {
  const a = `${streakBucket(k)}`;
  if (status == null) return [a];
  const b = `${a}|${statusGroup(status)}`;
  const out = sev == null || statusGroup(status) === 'none' ? [a, b] : [a, b, `${b}|${sev}`];
  // a stated timetable refines whatever is already known, so it hangs off the finest level
  if (tl) out.push(`${out.at(-1)}|${tl}`);
  return out;
};

// rows: [{ k, status?, sev?, y }] -> a table. Cells hold [sum, count].
export function fitTable(rows, m = 10) {
  const table = { m, mean: 0, n: 0, cells: {} };
  for (const r of rows) {
    if (r.y == null || Number.isNaN(r.y)) continue;
    table.mean += r.y; table.n++;
    for (const key of keys(r)) { const c = (table.cells[key] ||= [0, 0]); c[0] += r.y; c[1]++; }
  }
  table.mean = table.n ? table.mean / table.n : 0;
  for (const c of Object.values(table.cells)) c[0] = Math.round(c[0] * 1000) / 1000;
  return table;
}

export function lookup(table, row) {
  if (!table) return null;
  let est = table.mean;
  for (const key of keys(row)) {
    const c = table.cells[key];
    if (!c) break;
    est = (c[0] + table.m * est) / (c[1] + table.m);
  }
  return est;
}

// How many of his team's most recent games a player has missed in a row.
// teamDays: sorted days the team played; playedDays: Set of days he played for it.
export function missedInARow(teamDays, playedDays, day) {
  let k = 0;
  for (let i = teamDays.length - 1; i >= 0; i--) {
    if (teamDays[i] > day) continue;
    if (playedDays.has(teamDays[i])) break;
    k++;
  }
  return k;
}
