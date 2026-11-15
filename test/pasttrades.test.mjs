import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseEspnTrades } from '../lib/sources.mjs';
import { buildPastTrades } from '../lib/pasttrades.mjs';

test('parseEspnTrades keeps accepted trades and their moves', () => {
  const data = { topics: [
    { id: 'a', date: 1000, messages: [{ messageTypeId: 244, from: 3, to: 1, targetId: 10 }, { messageTypeId: 244, from: 1, to: 3, targetId: 20 }, { messageTypeId: 178, from: 1, to: 1, targetId: 99 }] },
    { id: 'b', date: 2000, messages: [{ messageTypeId: 244, from: 2, to: 2, targetId: 30 }] }, // not a trade
  ] };
  assert.deepEqual(parseEspnTrades(data), [{ id: 'a', date: 1000, moves: [{ playerId: 10, from: 3, to: 1 }, { playerId: 20, from: 1, to: 3 }] }]);
  assert.deepEqual(parseEspnTrades({}), []);
});

test('buildPastTrades splits each player at the trade date and keeps a running total per side', () => {
  const player = (id, name, log) => ({ id, name, team: 'BOS', pos: 'PG', log, model: { fpg: 30 }, avail: { games: 10, note: '' } });
  const data = {
    meta: { refreshedAt: Date.parse('2026-11-14T18:00:00Z') },
    periodDates: { 1: '2026-11-07', 2: '2026-11-08', 3: '2026-11-09', 4: '2026-11-10', 5: '2026-11-12' },
    league: { teams: [{ id: 1, name: 'Them' }, { id: 3, name: 'Me' }] },
    players: [
      player(10, 'Gave Away', [{ d: 1, fp: 20 }, { d: 3, fp: 40 }, { d: 5, fp: 10 }]),
      player(20, 'Got Back', [{ d: 2, fp: 30 }, { d: 4, fp: 50 }]),
    ],
  };
  // accepted on the morning of 9 November, US Eastern
  const trades = [{ id: 'a', date: Date.parse('2026-11-09T13:00:00Z'), moves: [{ playerId: 10, from: 3, to: 1 }, { playerId: 20, from: 1, to: 3 }, { playerId: 77, from: 1, to: 3 }] }];
  const [t] = buildPastTrades(trades, data, 3);
  assert.equal(t.day, '2026-11-09');
  assert.equal(t.mine, true);
  assert.deepEqual(t.dates, ['2026-11-09', '2026-11-10', '2026-11-12']);
  const [me, them] = t.sides;
  assert.equal(me.mine, true);
  assert.deepEqual(me.since, { gp: 1, total: 50, fpg: 50 });
  assert.deepEqual(me.line, [0, 50, 50]);
  assert.deepEqual(them.since, { gp: 2, total: 50, fpg: 25 }); // the game on the trade day counts for the new team
  assert.deepEqual(them.line, [40, 40, 50]);
  const got = me.players.find((p) => p.id === 20);
  assert.deepEqual(got.before, { gp: 1, fpg: 30 });
  assert.deepEqual(got.ahead, { fpg: 30, games: 10, total: 300 });
  // a traded player who has since left the player pool still appears, with nothing to score
  const gone = me.players.find((p) => p.id === 77);
  assert.equal(gone.ahead, null);
  assert.equal(gone.since.gp, 0);
  assert.equal(me.ahead, 300);
  assert.deepEqual(buildPastTrades([], data, 3), []);
});
