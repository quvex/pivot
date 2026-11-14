import test from 'node:test';
import assert from 'node:assert/strict';
import { estimate, makePrior, durabilityOf, spreadOf, DEFAULT_PARAMS } from '../lib/estimator.mjs';

// Fixed parameters so the tests do not move when the backtest is re-run.
const P = { ...DEFAULT_PARAMS, topShrink: 0, kFg: 0 };
const games = (n, fp, min = 30, ageStep = 2) => Array.from({ length: n }, (_, i) => ({ age: i * ageStep, min, fp, fgm: 6, fga: 13 }));

test('with no games the estimate is the preseason prior', () => {
  const prior = { fp: 22, min: 28, fgm: 5, fga: 11 };
  const e = estimate([], prior, P);
  assert.equal(e.fp, 22);
  assert.equal(e.n, 0);
  assert.equal(e.trust, 0);
});

test('with no prior the estimate is the observed average', () => {
  const e = estimate(games(10, 24), null, P);
  assert.ok(Math.abs(e.fp - 24) < 1e-9);
  assert.equal(e.trust, 1);
});

test('the estimate sits between the prior and what he has done', () => {
  const prior = { fp: 20, min: 30, fgm: 5, fga: 11 };
  const e = estimate(games(8, 30), prior, P);
  assert.ok(e.fp > 20 && e.fp < 30, `got ${e.fp}`);
});

test('more games move the estimate further toward what he has done', () => {
  const prior = { fp: 20, min: 30, fgm: 5, fga: 11 };
  const few = estimate(games(4, 30), prior, P).fp;
  const many = estimate(games(40, 30), prior, P).fp;
  assert.ok(many > few, `${many} should exceed ${few}`);
});

test('a jump in minutes shows up faster than a jump in efficiency', () => {
  const prior = { fp: 24, min: 24, fgm: 5, fga: 11 }; // 1.0 FP per minute
  // last five games at 34 minutes, same per-minute rate as before
  const log = [...games(5, 34, 34, 1), ...games(10, 24, 24, 3).map((g) => ({ ...g, age: g.age + 6 }))];
  const e = estimate(log, prior, P);
  assert.ok(e.min > 27, `expected minutes to climb, got ${e.min}`);
  assert.ok(Math.abs(e.rate - 1) < 0.05, `per-minute rate should stay near 1.0, got ${e.rate}`);
});

test('makePrior blends the projection with last season', () => {
  const proj = { fp: 30, min: 32, fgm: 8, fga: 16 };
  const prev = { fp: 20, min: 28, fgm: 6, fga: 12 };
  assert.equal(makePrior(proj, prev, { projShare: 0.75 }).fp, 27.5);
  assert.equal(makePrior(proj, null, P), proj);
  assert.equal(makePrior(null, null, P), null);
});

test('durability stays within sensible bounds', () => {
  assert.equal(durabilityOf(1, 1, { durability: { base: 1, prev: 1, cur: 1 } }), 0.97);
  assert.equal(durabilityOf(0, 0, { durability: { base: 0, prev: 0, cur: 0 } }), 0.6);
});

test('the typical miss shrinks as games pile up', () => {
  assert.ok(spreadOf(0, P) > spreadOf(30, P));
});
