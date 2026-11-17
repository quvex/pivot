import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// hosted.mjs reads PIVOT_DATA_DIR when store.mjs loads, so point it at a temporary folder first
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pivot-hosted-'));
process.env.PIVOT_DATA_DIR = dir;
const hosted = await import('../lib/hosted.mjs');

const LABELS = { 0: 'PTS', 6: 'REB' };
const header = (v) => ({ headers: { 'x-pivot-visitor': Buffer.from(JSON.stringify(v)).toString('base64url') } });

test('a visitor\'s settings come from their own request, checked', () => {
  const v = hosted.visitorFrom(header({ leagueId: 'https://fantasy.espn.com/basketball/league?leagueId=123', untouchables: [7, '7', 'x'], espnS2: 'cookie', aiProvider: 'compatible', altBaseUrl: 'http://evil' }), LABELS);
  assert.equal(v.leagueId, '123');
  assert.deepEqual(v.untouchables, [7]);
  assert.equal(v.espnS2, 'cookie');
  assert.equal(v.aiProvider, 'anthropic', 'server-only settings cannot be set by a visitor');
  assert.equal(v.altBaseUrl, undefined);
  assert.equal(hosted.visitorFrom({ headers: {} }, LABELS).leagueId, '', 'no header: a new visitor');
  assert.equal(hosted.visitorFrom({ headers: { 'x-pivot-visitor': '%%%' } }, LABELS).leagueId, '', 'garbage is ignored');
});

test('custom scoring is kept only for known stats', () => {
  const v = hosted.visitorFrom(header({ scoringSource: 'custom', scoring: { 0: 1.5, 99: 3, 6: 'x' } }), LABELS);
  assert.equal(v.scoringSource, 'custom');
  assert.deepEqual(v.scoring, { 0: 1.5 });
});

test('changing league clears the team; the browser keeps only what the visitor chose', () => {
  const cur = hosted.visitorFrom(header({ leagueId: '1', teamId: 4 }), LABELS);
  assert.equal(cur.teamId, 4);
  const next = hosted.applyVisitor(cur, { leagueId: '2' }, LABELS);
  assert.equal(next.teamId, null);
  const kept = hosted.keepable(next);
  assert.deepEqual(Object.keys(kept).sort(), ['espnS2', 'leagueId', 'manualRoster', 'swid', 'teamId', 'untouchables']);
});

test('the rate limit counts per address and window', () => {
  for (let i = 0; i < 3; i++) assert.ok(hosted.allowed('1.2.3.4', 't', 3));
  assert.ok(!hosted.allowed('1.2.3.4', 't', 3));
  assert.ok(hosted.allowed('5.6.7.8', 't', 3));
});
