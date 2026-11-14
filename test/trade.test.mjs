import test from 'node:test';
import assert from 'node:assert/strict';
import { tradeContext, evaluateTrade, mockOffers } from '../lib/trade.mjs';
import { ownership } from '../lib/news.mjs';
import { player, league, SETTINGS } from './helpers.mjs';

function setup() {
  const mine = [
    player({ name: 'My Star', pos: 'PG', fpg: 45 }),
    player({ name: 'My Wing', pos: 'SF', fpg: 33 }),
    player({ name: 'My Big', pos: 'C', fpg: 31 }),
    player({ name: 'My Bench', pos: 'SG', fpg: 27 }),
  ];
  const theirs = [
    player({ name: 'Their Star', pos: 'PF', fpg: 50 }),
    // the model likes him more than the market does: the kind of player to target
    player({ name: 'Their Sleeper', pos: 'SF', fpg: 38, market: 32 }),
    player({ name: 'Their Big', pos: 'C', fpg: 30 }),
  ];
  const free = [player({ name: 'Free Agent', pos: 'SG', fpg: 28 })];
  const data = league({ mine, theirs, free });
  const ctx = tradeContext(data, ownership(data, SETTINGS));
  const id = (n) => data.players.find((p) => p.name === n).id;
  return { ctx, id };
}

test('trading up helps you and trading down hurts you', () => {
  const { ctx, id } = setup();
  const up = evaluateTrade(ctx, [id('My Wing')], [id('Their Sleeper')]);
  const down = evaluateTrade(ctx, [id('My Star')], [id('Their Big')]);
  assert.ok(up.delta > 0, `expected a gain, got ${up.delta}`);
  assert.ok(down.delta < 0, `expected a loss, got ${down.delta}`);
  assert.equal(up.partner.name, 'Rivals');
});

test('a trade needs a player on each side', () => {
  const { ctx, id } = setup();
  assert.equal(evaluateTrade(ctx, [id('My Wing')], []), null);
  assert.equal(evaluateTrade(ctx, [], [id('Their Big')]), null);
});

test('two-for-one opens a spot and fills it with the best free agent', () => {
  const { ctx, id } = setup();
  const t = evaluateTrade(ctx, [id('My Wing'), id('My Bench')], [id('Their Star')]);
  assert.equal(t.fill, id('Free Agent'));
  assert.equal(t.drops.length, 0);
});

test('one-for-two forces a drop to keep the roster the same size', () => {
  const { ctx, id } = setup();
  const t = evaluateTrade(ctx, [id('My Star')], [id('Their Sleeper'), id('Their Big')]);
  assert.equal(t.drops.length, 1);
  assert.equal(t.drops[0], id('My Bench'), 'the weakest player is the one dropped');
});

test('a lopsided offer in your favour is unlikely to be accepted', () => {
  const { ctx, id } = setup();
  const t = evaluateTrade(ctx, [id('My Bench')], [id('Their Star')]);
  assert.equal(t.accept.label, 'Unlikely');
});

test('every trade explains itself', () => {
  const { ctx, id } = setup();
  const t = evaluateTrade(ctx, [id('My Wing')], [id('Their Sleeper')]);
  assert.match(t.summary, /My Wing/);
  assert.ok(t.factors.some((f) => f.key === 'production'));
  assert.ok(t.factors.some((f) => f.key === 'them'), 'the other side is always considered');
  for (const f of t.factors) assert.ok(['for', 'against', 'even'].includes(f.lean));
});

test('offers for a target only ever give your players for him', () => {
  const { ctx, id } = setup();
  const res = mockOffers(ctx, { playerId: id('Their Sleeper') });
  assert.equal(res.mode, 'target');
  assert.ok(res.offers.length > 0, 'a player the market underrates should draw offers');
  const mineIds = new Set(ctx.myRoster.map((p) => p.id));
  for (const o of res.offers) {
    assert.ok(o.get.includes(id('Their Sleeper')));
    assert.ok(o.give.every((g) => mineIds.has(g)));
    assert.equal(o.partner.name, 'Rivals');
  }
});

test('a free agent has no trade partner', () => {
  const { ctx, id } = setup();
  const res = mockOffers(ctx, { playerId: id('Free Agent') });
  assert.equal(res.mode, 'free');
  assert.equal(res.offers.length, 0);
  assert.match(res.note, /free agent/);
});
