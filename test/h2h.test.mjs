import test from 'node:test';
import assert from 'node:assert/strict';
import { parseEspnLeague, formatOf } from '../lib/sources.mjs';
import { normalCdf, matchupOdds } from '../lib/model.mjs';
import { buildWeek } from '../lib/state.mjs';
import { ownership } from '../lib/ownership.mjs';
import { player } from './helpers.mjs';

// The shape ESPN returns for a head-to-head points league (trimmed to what the parser reads).
const espnH2h = {
  id: 99, seasonId: 2027, scoringPeriodId: 24,
  status: { currentMatchupPeriod: 3 },
  members: [{ id: '{AAA}', displayName: 'owner-a' }, { id: '{BBB}', displayName: 'owner-b' }],
  settings: {
    name: 'Test H2H',
    scoringSettings: { scoringType: 'H2H_POINTS', scoringItems: [{ statId: 0, points: 1 }, { statId: 6, points: 1.2 }] },
    rosterSettings: { lineupSlotCounts: { 0: 1, 11: 1, 12: 3 }, lineupSlotStatLimits: {} },
    scheduleSettings: { matchupPeriods: { 3: [22, 23, 24, 25, 26, 27, 28] }, playoffTeamCount: 4 },
  },
  teams: [
    { id: 1, name: 'Alpha', owners: ['{AAA}'], record: { overall: { wins: 2, losses: 0, ties: 0, pointsFor: 2100, pointsAgainst: 1900 } }, roster: { entries: [{ playerId: 11, lineupSlotId: 0 }] } },
    { id: 2, name: 'Beta', owners: ['{BBB}'], record: { overall: { wins: 1, losses: 1, ties: 0, pointsFor: 2000, pointsAgainst: 2050 } }, roster: { entries: [{ playerId: 12, lineupSlotId: 13 }] } },
  ],
  schedule: [
    { matchupPeriodId: 2, home: { teamId: 1, totalPoints: 1050 }, away: { teamId: 2, totalPoints: 990 }, winner: 'HOME' },
    { matchupPeriodId: 3, home: { teamId: 2, totalPoints: 300, totalPointsLive: 320 }, away: { teamId: 1, totalPoints: 280 }, winner: 'UNDECIDED' },
  ],
};

test('formats are recognised, with categories flagged as not fully supported', () => {
  assert.equal(formatOf('H2H_POINTS').kind, 'h2h');
  assert.equal(formatOf('TOTAL_SEASON_POINTS').kind, 'season');
  assert.equal(formatOf('H2H_CATEGORY').supported, false);
  assert.equal(formatOf('SOMETHING_NEW').kind, 'unknown');
});

test('a head-to-head league parses into records, matchups and the current week', () => {
  const lg = parseEspnLeague(espnH2h, { leagueId: 99, swid: '{aaa}' });
  assert.equal(lg.format.kind, 'h2h');
  assert.equal(lg.format.currentMatchupPeriod, 3);
  assert.deepEqual(lg.format.matchupPeriods[3], [22, 23, 24, 25, 26, 27, 28]);
  assert.equal(lg.format.capTotal, 0);
  assert.deepEqual(lg.scoring, { 0: 1, 6: 1.2 });
  assert.equal(lg.teams[0].record.wins, 2);
  assert.equal(lg.teams[0].owner, 'owner-a');
  assert.equal(lg.teams[0].isMine, true, 'SWID matching ignores case');
  assert.deepEqual(lg.teams[1].ir, [12]);
  assert.equal(lg.matchups.length, 2);
  assert.deepEqual(lg.matchups[1], { period: 3, home: 2, away: 1, homePoints: 320, awayPoints: 280, winner: 'UNDECIDED' }, 'live points win over the last saved total');
});

test('normal CDF matches known values', () => {
  assert.ok(Math.abs(normalCdf(0) - 0.5) < 1e-6);
  assert.ok(Math.abs(normalCdf(1.96) - 0.975) < 1e-3);
  assert.ok(Math.abs(normalCdf(-1) - 0.1587) < 1e-3);
});

test('matchup odds: even teams are a coin flip, a lead makes you the favourite', () => {
  const even = matchupOdds({ points: 100, remaining: 500, sd: 60 }, { points: 100, remaining: 500, sd: 60 });
  assert.equal(even.win, 0.5);
  const ahead = matchupOdds({ points: 300, remaining: 500, sd: 60 }, { points: 200, remaining: 500, sd: 60 });
  assert.ok(ahead.win > 0.85);
  assert.deepEqual(ahead.projected, [800, 700]);
  assert.equal(matchupOdds({ points: 10, remaining: 0, sd: 0 }, { points: 5, remaining: 0, sd: 0 }).win, 1);
});

test('the weekly outlook projects the current matchup and sorts standings by record', () => {
  const ET = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' });
  const at = (days) => Date.now() + days * 86400000;
  const star = player({ id: 11, team: 'BOS', pos: 'PG', fpg: 50 });
  const scrub = player({ id: 12, team: 'NYK', pos: 'PG', fpg: 20 });
  const league = parseEspnLeague(espnH2h, { leagueId: 99 });
  const data = {
    players: [star, scrub],
    league,
    schedule: { BOS: [at(1), at(2)], NYK: [at(1), at(2)] },
    // the matchup's last three days are tomorrow and later
    periodDates: { 26: ET.format(new Date(at(1))), 27: ET.format(new Date(at(2))), 28: ET.format(new Date(at(3))) },
    meta: { repl: 25, leagueGp: 20 },
  };
  const own = ownership(data, { teamId: 1 });
  const w = buildWeek(data, own);
  assert.equal(w.kind, 'h2h');
  assert.equal(w.teams[0].name, 'Alpha', '2-0 ranks above 1-1');
  assert.equal(w.h2h.games.length, 1);
  const g = w.h2h.games[0];
  assert.equal(g.away.id, 1);
  assert.ok(g.away.remaining > g.home.remaining, 'the 50 FP/G player out-projects the 20 FP/G one');
  assert.ok(g.homeWin < 0.5, 'so Alpha is favoured despite trailing 280 to 320');
  assert.match(w.my.advice[0], /Matchup with Beta/);
});
