// Backtest: replay past NBA seasons, ask the projection model for each player's rest-of-season
// FP/G using only what was known on that day, and compare with what actually happened.
//
// Rolling-origin evaluation: each test season is scored by a model tuned only on earlier seasons,
// so nothing from the future leaks in. Error ranges are 95% intervals from a bootstrap that
// resamples whole players (one player's projections across a season are not independent).
// An ablation then removes one piece of the model at a time to show what each contributes.
// The parameters saved to params.json come from the last fold (tuned on every season before the
// most recent one).
//   npm run backtest
import { fileURLToPath } from 'node:url';
import { loadSeasonLogs } from './history.mjs';
import { estimate, makePrior, DEFAULT_PARAMS, saveParams } from './estimator.mjs';
import { loadSettings } from './store.mjs';

// 2022-23 is left out: ESPN’s stored projections for that season were revised mid-season, so
// using them as a "preseason" baseline would leak the answer into the tuning.
const FOLDS = [
  { test: 2024, train: [2022] },
  { test: 2025, train: [2022, 2024] },
  { test: 2026, train: [2022, 2024, 2025] },
];
const SEASON = (y) => `${y - 1}-${String(y).slice(2)}`;
const CHECKPOINTS = [12, 22, 32, 42, 52, 62, 72, 82, 92, 102, 112, 122, 132];
const MIN_FUTURE = 10;

const fpOf = (s, scoring) => { let t = 0; for (const k in scoring) t += (s[k] || 0) * scoring[k]; return t; };
const lineOf = (avg, scoring) => (avg && avg[40] > 0 ? { fp: fpOf(avg, scoring), min: avg[40], fgm: avg[13] || 0, fga: avg[14] || 0, gp: avg[42] || 0 } : null);

// Every (player, checkpoint day) pair becomes one sample.
export function buildSamples(seasonData, prevData, scoring) {
  const prevById = new Map((prevData?.players || []).map((p) => [p.id, p]));
  const teamDays = {}; // pro team -> sorted days it played
  for (const p of seasonData.players) for (const g of p.games) (teamDays[g.t] ||= new Set()).add(g.d);
  for (const t in teamDays) teamDays[t] = [...teamDays[t]].sort((a, b) => a - b);

  const samples = [];
  for (const p of seasonData.players) {
    if (p.games.length < 5) continue;
    const proj = lineOf(p.proj, scoring);
    const prevP = prevById.get(p.id);
    const prev = prevP && prevP.games.length >= 15 ? lineOf(prevP.total, scoring) : null;
    const games = p.games.map((g) => ({ d: g.d, t: g.t, min: g.s[40], fp: fpOf(g.s, scoring), fgm: g.s[13] || 0, fga: g.s[14] || 0 }));
    for (const day of CHECKPOINTS) {
      const past = games.filter((g) => g.d <= day);
      const future = games.filter((g) => g.d > day);
      if (future.length < MIN_FUTURE) continue;
      const pastMin = past.length ? past.reduce((a, g) => a + g.min, 0) / past.length : 0;
      // fantasy-relevant on the information of the day
      if (!(pastMin >= 16 || (proj?.fp ?? 0) >= 18 || (prev?.fp ?? 0) >= 18)) continue;
      const team = (past[past.length - 1] || future[0]).t;
      const td = teamDays[team] || [];
      const teamPast = td.filter((d) => d <= day).length;
      const teamFuture = td.length - teamPast;
      const window = (days) => { const g = past.filter((x) => day - x.d < days); return g.length ? g.reduce((a, x) => a + x.fp, 0) / g.length : null; };
      const nextTwoWeeks = future.filter((g) => g.d <= day + 14);
      samples.push({
        season: seasonData.season, id: p.id, day, proj, prev,
        games: past.map((g) => ({ age: day - g.d, min: g.min, fp: g.fp, fgm: g.fgm, fga: g.fga })),
        n: past.length,
        seasonAvg: past.length ? past.reduce((a, g) => a + g.fp, 0) / past.length : null,
        l15: window(15), l30: window(30),
        target: future.reduce((a, g) => a + g.fp, 0) / future.length,
        targetNext: nextTwoWeeks.length >= 3 ? nextTwoWeeks.reduce((a, g) => a + g.fp, 0) / nextTwoWeeks.length : null,
        // availability: only meaningful for a player who is healthy on the day
        healthy: past.some((g) => day - g.d < 6),
        curShare: teamPast >= 8 ? Math.min(1, past.length / teamPast) : null,
        prevShare: prev ? Math.min(1, prev.gp / 82) : null,
        futureShare: teamFuture >= 10 ? Math.min(1, future.length / teamFuture) : null,
      });
    }
  }
  return samples;
}

const makeValueOf = (scoring) => (scoring[13] || 0) + 2.2 * (scoring[0] || 0);

export function predictors(scoring) {
  const mv = makeValueOf(scoring);
  return {
    // what the app did before this backtest: season average with recent weeks counted again,
    // shrunk toward a 70/30 preseason baseline with trust n / (n + 12)
    old: (s) => {
      const prior = s.proj && s.prev ? 0.7 * s.proj.fp + 0.3 * s.prev.fp : s.proj?.fp ?? s.prev?.fp ?? null;
      if (!s.n) return prior;
      const in15 = s.games.filter((g) => g.age < 15), in7 = s.games.filter((g) => g.age < 7);
      const sum = (a) => a.reduce((x, g) => x + g.fp, 0);
      const obs = (sum(s.games) + sum(in15) + sum(in7)) / (s.n + in15.length + in7.length);
      if (prior == null) return obs;
      const trust = s.n / (s.n + 12);
      return trust * obs + (1 - trust) * prior;
    },
    seasonAvg: (s) => s.seasonAvg ?? s.proj?.fp ?? s.prev?.fp ?? null,
    last15: (s) => s.l15 ?? s.seasonAvg ?? s.proj?.fp ?? s.prev?.fp ?? null,
    preseason: (s) => s.proj?.fp ?? s.prev?.fp ?? s.seasonAvg,
    model: (params) => (s) => estimate(s.games, makePrior(s.proj, s.prev, params), params, mv)?.fp ?? null,
  };
}

export function score(samples, predict, key = 'target') {
  let n = 0, abs = 0, sq = 0, bias = 0;
  for (const s of samples) {
    const y = s[key];
    const yhat = predict(s);
    if (y == null || yhat == null) continue;
    const e = yhat - y;
    n++; abs += Math.abs(e); sq += e * e; bias += e;
  }
  return { n, mae: abs / n, rmse: Math.sqrt(sq / n), bias: bias / n };
}

// ---------- bootstrap ----------
// Seeded so the reported intervals are reproducible.
function rng(seed) {
  return () => { seed |= 0; seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

// fns: { key: predict }. Returns each method's MAE with a 95% interval, and the same for the
// paired difference of each method against `base`. Resamples players, not projections.
export function bootstrapMae(samples, fns, { base = null, B = 1000, seed = 7 } = {}) {
  const keys = Object.keys(fns);
  const groups = new Map(); // player -> { n, sum: { key: total abs error } }
  for (const s of samples) {
    const preds = keys.map((k) => fns[k](s));
    if (s.target == null || preds.some((v) => v == null)) continue;
    const g = groups.get(`${s.season}:${s.id}`) || { n: 0, sum: Object.fromEntries(keys.map((k) => [k, 0])) };
    keys.forEach((k, i) => { g.sum[k] += Math.abs(preds[i] - s.target); });
    g.n++;
    groups.set(`${s.season}:${s.id}`, g);
  }
  const list = [...groups.values()];
  const point = (pick) => { let n = 0; const t = Object.fromEntries(keys.map((k) => [k, 0])); for (const g of pick) { n += g.n; for (const k of keys) t[k] += g.sum[k]; } return Object.fromEntries(keys.map((k) => [k, t[k] / n])); };
  const full = point(list);
  const rand = rng(seed);
  const draws = [];
  for (let b = 0; b < B; b++) draws.push(point(Array.from(list, () => list[(rand() * list.length) | 0])));
  const ci = (vals) => { vals.sort((a, b) => a - b); return [vals[Math.floor(0.025 * vals.length)], vals[Math.ceil(0.975 * vals.length) - 1]]; };
  const r2 = (x) => Math.round(x * 100) / 100;
  const out = { players: list.length, projections: list.reduce((a, g) => a + g.n, 0), mae: {}, diff: {} };
  for (const k of keys) {
    const [lo, hi] = ci(draws.map((d) => d[k]));
    out.mae[k] = { mae: r2(full[k]), lo: r2(lo), hi: r2(hi) };
    if (base && k !== base) {
      const [dlo, dhi] = ci(draws.map((d) => d[k] - d[base]));
      out.diff[k] = { diff: r2(full[k] - full[base]), lo: r2(dlo), hi: r2(dhi) };
    }
  }
  return out;
}

// One fantasy-points series, no minutes/efficiency split: the ablation baseline for that idea.
function flatPredictor(hl, k, projShare, topShrink) {
  const ln = Math.LN2 / hl;
  return (s) => {
    const prior = makePrior(s.proj, s.prev, { projShare });
    let w = 0, sum = 0;
    for (const g of s.games) { const a = Math.exp(-ln * g.age); w += a; sum += a * g.fp; }
    if (!w && !prior) return null;
    let fp = prior ? (sum + k * prior.fp) / (w + k) : sum / w;
    if (topShrink && fp > 30) fp -= topShrink * (fp - 30);
    return fp;
  };
}
function tuneFlat(samples, tuned) {
  let best = null;
  for (const hl of [7, 14, 28, 60, 120, 1e6]) for (const k of [1, 2, 4, 8, 12, 20]) {
    const l = score(samples, flatPredictor(hl, k, tuned.projShare, tuned.topShrink)).rmse;
    if (!best || l < best.l) best = { hl, k, l };
  }
  return flatPredictor(best.hl, best.k, tuned.projShare, tuned.topShrink);
}

// Tune everything for one set of training seasons.
function fit(train, scoring, log) {
  const tuned = tune(train, scoring, log);
  const raw = predictors(scoring).model({ ...tuned, topShrink: 0 });
  let num = 0, den = 0;
  for (const s of train) { const v = raw(s); if (v > 30) { num += (v - 30) * (v - s.target); den += (v - 30) ** 2; } }
  tuned.topShrink = den ? Math.max(0, Math.round((num / den) * 1000) / 1000) : 0;
  tuned.durability = fitDurability(train);
  return tuned;
}

// Coordinate descent over a grid for each parameter, repeated until nothing improves.
function tune(samples, scoring, log) {
  const P = predictors(scoring);
  const grid = {
    hlMin: [5, 7, 10, 14, 20, 28, 40, 60],
    hlRate: [15, 25, 40, 60, 90, 130, 200, 400],
    kMin: [0.5, 1, 2, 3, 4, 6, 8, 12],
    kRate: [2, 4, 6, 9, 12, 16, 22, 30, 40],
    projShare: [0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1],
    kFg: [0, 50, 100, 200, 400, 800],
  };
  let best = { ...DEFAULT_PARAMS };
  const loss = (p) => score(samples, P.model(p)).rmse;
  let bestLoss = loss(best);
  for (let round = 0; round < 6; round++) {
    let improved = false;
    for (const [key, values] of Object.entries(grid)) {
      for (const v of values) {
        if (v === best[key]) continue;
        const cand = { ...best, [key]: v };
        const l = loss(cand);
        if (l < bestLoss - 1e-5) { best = cand; bestLoss = l; improved = true; }
      }
    }
    log(`  round ${round + 1}: RMSE ${bestLoss.toFixed(3)}  ${Object.keys(grid).map((k) => `${k}=${best[k]}`).join(' ')}`);
    if (!improved) break;
  }
  return best;
}

// Least squares for y = a + b*x1 + c*x2.
function fitDurability(samples) {
  const rows = samples.filter((s) => s.healthy && s.futureShare != null && s.curShare != null && s.prevShare != null);
  const X = rows.map((s) => [1, s.prevShare, s.curShare]);
  const y = rows.map((s) => s.futureShare);
  const A = [[0, 0, 0], [0, 0, 0], [0, 0, 0]], b = [0, 0, 0];
  X.forEach((x, i) => { for (let r = 0; r < 3; r++) { b[r] += x[r] * y[i]; for (let c = 0; c < 3; c++) A[r][c] += x[r] * x[c]; } });
  for (let i = 0; i < 3; i++) { // Gaussian elimination
    for (let r = i + 1; r < 3; r++) { const f = A[r][i] / A[i][i]; for (let c = i; c < 3; c++) A[r][c] -= f * A[i][c]; b[r] -= f * b[i]; }
  }
  const w = [0, 0, 0];
  for (let i = 2; i >= 0; i--) { let s = b[i]; for (let c = i + 1; c < 3; c++) s -= A[i][c] * w[c]; w[i] = s / A[i][i]; }
  const r3 = (x) => Math.round(x * 1000) / 1000;
  return { base: r3(w[0]), prev: r3(w[1]), cur: r3(w[2]), n: rows.length, mean: r3(y.reduce((a, v) => a + v, 0) / y.length) };
}

export async function backtest({ log = console.log } = {}) {
  const scoring = loadSettings().scoring;
  const years = new Set(FOLDS.flatMap((f) => [...f.train, f.test]).flatMap((y) => [y - 1, y]));
  const seasons = {};
  for (const y of [...years].sort()) seasons[y] = await loadSeasonLogs(y, { log });
  const samplesOf = {};
  for (const f of FOLDS) for (const y of [...f.train, f.test]) samplesOf[y] ||= buildSamples(seasons[y], seasons[y - 1], scoring);

  const P = predictors(scoring);
  const r2 = (x) => Math.round(x * 100) / 100;
  const folds = [], pooled = [], pooledFns = [];
  let tuned, train, test;
  for (const fold of FOLDS) {
    train = fold.train.flatMap((y) => samplesOf[y]);
    test = samplesOf[fold.test];
    log(`\nFold: tune on ${fold.train.map(SEASON).join(', ')} (${train.length}), test on ${SEASON(fold.test)} (${test.length})`);
    tuned = fit(train, scoring, log);
    const fns = {
      model: P.model(tuned), old: P.old, seasonAvg: P.seasonAvg, last15: P.last15, preseason: P.preseason,
      // ablations: take one piece away, keep the rest as tuned
      noSplit: tuneFlat(train, tuned),
      noRecency: P.model({ ...tuned, hlMin: 1e6, hlRate: 1e6 }),
      noPrior: P.model({ ...tuned, kMin: 0, kRate: 0 }),
      noLuck: P.model({ ...tuned, kFg: 0 }),
      noTopTrim: P.model({ ...tuned, topShrink: 0 }),
    };
    const bs = bootstrapMae(test, fns, { base: 'model' });
    const next = Object.fromEntries(Object.entries(fns).map(([k, fn]) => [k, r2(score(test, fn, 'targetNext').mae)]));
    folds.push({ test: SEASON(fold.test), train: fold.train.map(SEASON), samples: test.length, players: bs.players, mae: bs.mae, diff: bs.diff, next14: next, trainMae: r2(score(train, fns.model).mae) });
    for (const s of test) pooled.push(s);
    pooledFns.push([new Set(test), fns]);
    log(`  model ${bs.mae.model.mae} [${bs.mae.model.lo}-${bs.mae.model.hi}]  season avg ${bs.mae.seasonAvg.mae}  old ${bs.mae.old.mae}`);
  }
  // pooled over every test season, each scored by its own fold's model
  const route = (key) => (s) => pooledFns.find(([set]) => set.has(s))[1][key](s);
  const keys = Object.keys(pooledFns[0][1]);
  const all = bootstrapMae(pooled, Object.fromEntries(keys.map((k) => [k, route(k)])), { base: 'model' });

  const LABELS = {
    model: 'Pivot model', old: 'Previous model', seasonAvg: 'Season average', last15: 'Last 15 days', preseason: 'Preseason projection',
    noSplit: 'Without the minutes × efficiency split', noRecency: 'Without recency weighting', noPrior: 'Without the preseason prior',
    noLuck: 'Without the shooting-luck correction', noTopTrim: 'Without the top-end trim',
  };
  const BASELINES = ['model', 'old', 'seasonAvg', 'preseason', 'last15'];
  const ABLATIONS = ['noSplit', 'noRecency', 'noPrior', 'noLuck', 'noTopTrim'];
  // the last fold's test season keeps the old single-season fields the UI already reads
  const lastFns = pooledFns.at(-1)[1];
  const results = BASELINES.map((key) => {
    const fn = lastFns[key];
    const sc = score(test, fn);
    return { key, label: LABELS[key], mae: r2(sc.mae), rmse: r2(sc.rmse), bias: r2(sc.bias), n: sc.n, next14: r2(score(test, fn, 'targetNext').mae), trainMae: r2(score(train, fn).mae) };
  });

  // how far off the tuned model typically is, by games played so far (held-out season)
  const buckets = [0, 5, 10, 20, 40];
  const predict = P.model(tuned);
  tuned.spread = buckets.map((lo, i) => {
    const hi = buckets[i + 1] ?? Infinity;
    const rows = test.filter((s) => s.n >= lo && s.n < hi);
    return [lo, r2(score(rows.length >= 30 ? rows : test, predict).rmse)];
  });
  // calibration: predicted vs actual in bands of predicted FP/G
  const bands = [[0, 15], [15, 20], [20, 25], [25, 30], [30, 35], [35, 40], [40, 45], [45, 99]];
  const calibration = bands.map(([lo, hi]) => {
    const rows = test.filter((s) => { const v = predict(s); return v >= lo && v < hi; });
    const mean = (f) => (rows.length ? r2(rows.reduce((a, s) => a + f(s), 0) / rows.length) : null);
    return { lo, hi, n: rows.length, predicted: mean(predict), actual: mean((s) => s.target) };
  }).filter((b) => b.n >= 15);

  tuned.report = {
    ranAt: new Date().toISOString().slice(0, 10),
    trainSeasons: FOLDS.at(-1).train.map(SEASON), testSeason: SEASON(FOLDS.at(-1).test),
    trainSamples: train.length, testSamples: test.length, checkpoints: CHECKPOINTS, results, calibration,
    labels: LABELS, baselines: BASELINES, ablations: ABLATIONS,
    folds, pooled: { players: all.players, projections: all.projections, mae: all.mae, diff: all.diff },
  };
  saveParams(tuned);

  log('\nAll test seasons pooled (MAE, 95% interval; change against the full model):');
  for (const k of [...BASELINES, ...ABLATIONS]) log(`  ${LABELS[k].padEnd(40)} ${all.mae[k].mae.toFixed(2)} [${all.mae[k].lo.toFixed(2)}-${all.mae[k].hi.toFixed(2)}]${all.diff[k] ? `  ${all.diff[k].diff >= 0 ? '+' : ''}${all.diff[k].diff.toFixed(2)} [${all.diff[k].lo.toFixed(2)}, ${all.diff[k].hi.toFixed(2)}]` : ''}`);
  log(`\nHeld-out season ${tuned.report.testSeason}: average miss in rest-of-season FP/G (lower is better)`);
  for (const r of results) log(`  ${r.label.padEnd(22)} MAE ${r.mae.toFixed(2)}  RMSE ${r.rmse.toFixed(2)}  bias ${r.bias >= 0 ? '+' : ''}${r.bias.toFixed(2)}  next-14-days MAE ${r.next14.toFixed(2)}  (tuning seasons MAE ${r.trainMae.toFixed(2)})`);
  log(`Durability fit: ${JSON.stringify(tuned.durability)}`);
  log(`Typical miss by games played: ${JSON.stringify(tuned.spread)}`);
  log('Calibration: ' + calibration.map((c) => `${c.predicted}->${c.actual}`).join('  '));
  return tuned;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  backtest().catch((e) => { console.error(e); process.exit(1); });
}
