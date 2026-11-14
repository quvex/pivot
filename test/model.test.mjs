import test from 'node:test';
import assert from 'node:assert/strict';
import { fantasyPoints, buildConsensus, capOutlook, weekPlan } from '../lib/model.mjs';
import { DEFAULT_SCORING } from '../lib/store.mjs';
import { player } from './helpers.mjs';

test('fantasy points follow ESPN default points scoring', () => {
  // 20 pts, 2 threes, 8-15 FG, 2-3 FT, 6 reb, 5 ast, 1 stl, 1 blk, 3 to
  const line = { 0: 20, 17: 2, 13: 8, 14: 15, 15: 2, 16: 3, 6: 6, 3: 5, 2: 1, 1: 1, 11: 3 };
  // 20 + 2 + 16 - 15 + 2 - 3 + 6 + 10 + 4 + 4 - 6
  assert.equal(fantasyPoints(line, DEFAULT_SCORING), 40);
});

test('consensus averages the sources and ranks by that average', () => {
  const a = player({ name: 'A' }), b = player({ name: 'B' }), c = player({ name: 'C' });
  buildConsensus([a, b, c], [
    { key: 'x', list: [{ id: a.id, rank: 1 }, { id: b.id, rank: 3 }, { id: c.id, rank: 2 }] },
    { key: 'y', list: [{ id: a.id, rank: 3 }, { id: b.id, rank: 1 }] },
  ]);
  assert.equal(a.consensus.avg, 2);
  assert.equal(b.consensus.avg, 2);
  assert.equal(c.consensus, null, 'one source of two is not a consensus');
  assert.deepEqual([a.consensus.rank, b.consensus.rank].sort(), [1, 2]);
});

test('cap outlook fills the remaining games with the best players first', () => {
  const stars = player({ fpg: 40, games: 50 });
  const filler = player({ fpg: 26, games: 50 });
  const scrub = player({ fpg: 20, games: 50 }); // below replacement: never used
  const out = capOutlook([scrub, filler, stars], 1000, 720, 820, 25);
  // 100 games of room: 50 at 40, then 50 at 26
  assert.equal(out.projected, 1000 + 50 * 40 + 50 * 26);
  assert.equal(out.capLine, 26);
  assert.equal(out.unfilled, 0);
});

test('cap outlook fills a short roster at replacement level', () => {
  const out = capOutlook([player({ fpg: 40, games: 20 })], 0, 0, 100, 25);
  assert.equal(out.projected, 20 * 40 + 80 * 25);
  assert.equal(out.unfilled, 80);
});

test('the weekly plan starts the better player when two share one slot', () => {
  const now = Date.parse('2026-11-16T15:00:00Z'); // a Monday
  const tip = Date.parse('2026-11-17T00:30:00Z'); // Monday evening, US Eastern
  const good = player({ team: 'BOS', fpg: 40 });
  const ok = player({ team: 'NYK', fpg: 30 });
  const plan = weekPlan([good, ok], { BOS: [tip], NYK: [tip] }, { 0: 1 }, now);
  const monday = plan.days.find((d) => d.games.length);
  assert.equal(monday.games.filter((g) => g.start).length, 1);
  assert.equal(monday.games.find((g) => g.start).id, good.id);
  assert.equal(plan.perPlayer[ok.id].pts[0], 0);
});

test('an injured player is not started while he is out', () => {
  const now = Date.parse('2026-11-16T15:00:00Z');
  const tip = Date.parse('2026-11-17T00:30:00Z');
  const hurt = player({ team: 'BOS', fpg: 50, injuryStatus: 'OUT', injury: { returnDate: '2026-12-01' } });
  const healthy = player({ team: 'NYK', fpg: 20 });
  const plan = weekPlan([hurt, healthy], { BOS: [tip], NYK: [tip] }, { 0: 1 }, now);
  const day = plan.days.find((d) => d.games.length);
  assert.equal(day.games.find((g) => g.id === hurt.id).chance, 0);
  assert.equal(day.games.find((g) => g.start).id, healthy.id);
});
