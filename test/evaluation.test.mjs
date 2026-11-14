import test from 'node:test';
import assert from 'node:assert/strict';
import { bootstrapMae } from '../lib/backtest.mjs';
import { scoreLive } from '../lib/livescore.mjs';

// 40 players x 5 projections each; "good" is off by 1, "bad" by 3.
const samples = [];
for (let id = 0; id < 40; id++) for (let k = 0; k < 5; k++) samples.push({ season: 2026, id, target: 20 + k, k });
const fns = { good: (s) => s.target + (s.k % 2 ? 1 : -1), bad: (s) => s.target + 3 };

test('bootstrap reports the exact MAE and an interval around it', () => {
  const out = bootstrapMae(samples, fns, { base: 'good', B: 200 });
  assert.equal(out.players, 40);
  assert.equal(out.projections, 200);
  assert.equal(out.mae.good.mae, 1);
  assert.equal(out.mae.bad.mae, 3);
  for (const k of ['good', 'bad']) assert.ok(out.mae[k].lo <= out.mae[k].mae && out.mae[k].mae <= out.mae[k].hi);
  assert.equal(out.diff.bad.diff, 2);
  assert.equal(out.diff.good, undefined, 'no difference reported for the base itself');
});

test('the bootstrap is reproducible', () => {
  assert.deepEqual(bootstrapMae(samples, fns, { B: 100 }), bootstrapMae(samples, fns, { B: 100 }));
});

test('live scoring waits a week, then compares with what happened since', () => {
  const players = [
    { id: 1, log: [{ d: 10, fp: 10 }, { d: 21, fp: 30 }, { d: 22, fp: 30 }, { d: 24, fp: 30 }] },
    { id: 2, log: [{ d: 21, fp: 20 }] }, // only one game since: not scored
  ];
  const snaps = [
    { date: 'a', day: 20, season: 2027, p: { 1: [28, 10], 2: [20, 20] } },
    { date: 'b', day: 25, season: 2027, p: { 1: [30, 25] } },
    { date: 'old', day: 20, season: 2026, p: { 1: [0, 0] } }, // another season: ignored
  ];
  const out = scoreLive(snaps, players, { season: 2027, nowDay: 28 });
  assert.equal(out.snapshots, 2);
  assert.equal(out.scored.length, 1, 'the day-25 snapshot is not a week old yet');
  assert.deepEqual(out.overall, { n: 1, model: 2, seasonAvg: 20 });
  assert.equal(out.nextScoredOn, 4);
});

test('live scoring with nothing saved yet', () => {
  const out = scoreLive([], [], { season: 2027, nowDay: 5 });
  assert.equal(out.overall, null);
  assert.equal(out.nextScoredOn, null);
});
