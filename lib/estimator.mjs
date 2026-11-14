// The core per-game estimate, shared by the live model and the backtest so that what is
// tuned on past seasons is exactly what runs today.
//
// A player's fantasy points per game = minutes x points-per-minute. The two move differently:
// minutes follow role and change quickly, per-minute production is a slow-moving skill. So each
// is estimated on its own from the game log, with recent games weighted more (exponential decay
// by days) and both shrunk toward a preseason prior that fades as games pile up.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PARAMS_FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'params.json');

// Used until a backtest has been run. `npm run backtest` overwrites these via params.json.
export const DEFAULT_PARAMS = {
  hlMin: 14,      // half-life in days of a game's weight when estimating minutes
  hlRate: 45,     // half-life in days when estimating points per minute
  kMin: 4,        // prior strength for minutes, in games
  kRate: 12,      // prior strength for per-minute production, in games
  projShare: 0.7, // prior = this share of the preseason projection + the rest from last season
  topShrink: 0,   // share of FP/G above 30 trimmed off: stars get rested and shut down late
  kFg: 0,         // shooting-luck correction: field-goal attempts of prior mixed into FG% (0 = off)
  // share of remaining team games a currently healthy player goes on to play
  durability: { base: 0.62, prev: 0.2, cur: 0.12 },
  // typical miss (FP/G, one standard deviation) by games played so far
  spread: [[0, 6.5], [5, 5.5], [10, 4.8], [20, 4.2], [40, 3.8]],
};

let cached = null;
export function loadParams() {
  if (cached) return cached;
  try { cached = { ...DEFAULT_PARAMS, ...JSON.parse(fs.readFileSync(PARAMS_FILE, 'utf8')) }; }
  catch { cached = { ...DEFAULT_PARAMS }; }
  return cached;
}
export function saveParams(params) {
  fs.writeFileSync(PARAMS_FILE, `${JSON.stringify(params, null, 2)}\n`);
  cached = null;
}

// prior from a preseason projection line and last season's line (either may be missing).
// Each is { fp, min, fgm, fga }.
export function makePrior(proj, prev, params) {
  if (proj && prev) {
    const a = params.projShare;
    const mix = (k) => a * proj[k] + (1 - a) * prev[k];
    return { fp: mix('fp'), min: mix('min'), fgm: mix('fgm'), fga: mix('fga') };
  }
  return proj || prev || null;
}

// games: [{ age (days before now, >= 0), min, fp, fgm, fga }]. makeValue = fantasy points
// gained per extra made field goal (used only when params.kFg > 0).
export function estimate(games, prior, params, makeValue = 0) {
  const n = games.length;
  if (!n && !prior) return null;
  if (!n) return { fp: prior.fp, min: prior.min, rate: prior.min > 0 ? prior.fp / prior.min : 0, n: 0, trust: 0 };

  // shooting luck: swap actual makes for the makes expected at a stabilised FG%
  let luck = 0; // FP per attempt to remove
  if (params.kFg > 0 && makeValue) {
    let fgm = 0, fga = 0;
    for (const g of games) { fgm += g.fgm; fga += g.fga; }
    const priorPct = prior && prior.fga > 0 ? prior.fgm / prior.fga : fga > 0 ? fgm / fga : 0;
    if (fga > 0) luck = (fgm / fga - (fgm + params.kFg * priorPct) / (fga + params.kFg)) * makeValue;
  }

  const lnMin = Math.LN2 / params.hlMin, lnRate = Math.LN2 / params.hlRate;
  let wm = 0, sm = 0, wr = 0, sr = 0, raw = 0;
  for (const g of games) {
    const a = Math.exp(-lnMin * g.age);
    wm += a; sm += a * g.min;
    const b = Math.exp(-lnRate * g.age);
    wr += b * g.min; sr += b * (g.fp - luck * g.fga);
    raw += g.min;
  }
  const meanMin = raw / n;
  const pMin = prior ? prior.min : meanMin;
  const kMin = prior ? params.kMin : 0;
  const min = (sm + kMin * pMin) / (wm + kMin);
  const pRate = prior && prior.min > 0 ? prior.fp / prior.min : null;
  const kRate = pRate == null ? 0 : params.kRate * Math.max(pMin, 12); // prior strength in minutes
  const rate = (sr + kRate * (pRate ?? 0)) / (wr + kRate);
  let fp = Math.max(0, min * rate);
  if (params.topShrink && fp > 30) fp -= params.topShrink * (fp - 30);
  return { fp, min, rate, n, trust: prior ? wr / (wr + kRate) : 1 };
}

// Share of his team's remaining games a healthy player is expected to play.
export function durabilityOf(prevShare, curShare, params) {
  const d = params.durability;
  const x = d.base + d.prev * (prevShare ?? 0.8) + d.cur * (curShare ?? 0.85);
  return Math.min(0.97, Math.max(0.6, x));
}

// One standard deviation of the projection's typical miss, in FP/G.
export function spreadOf(gamesPlayed, params) {
  let sd = params.spread[0][1];
  for (const [min, v] of params.spread) if (gamesPlayed >= min) sd = v;
  return sd;
}
