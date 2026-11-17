import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// hosted.mjs reads PIVOT_DATA_DIR when store.mjs loads, so point it at a temporary folder first
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pivot-hosted-'));
process.env.PIVOT_DATA_DIR = dir;
process.env.PIVOT_SECRET = 'test-secret';
const hosted = await import('../lib/hosted.mjs');

test('private-league cookies are encrypted at rest and read back', () => {
  const box = hosted.seal('my-espn-s2');
  assert.notEqual(box, 'my-espn-s2');
  assert.ok(!box.includes('my-espn-s2'));
  assert.equal(hosted.unseal(box), 'my-espn-s2');
  assert.equal(hosted.unseal('garbage.box.here'), '', 'a box that does not open reads as empty');
});

test('each visitor has their own settings, and the session id is not written to disk', () => {
  const a = 'a'.repeat(32), b = 'b'.repeat(32);
  hosted.saveVisitor(a, { leagueId: '123', espnS2: 'secret-cookie', untouchables: [7] });
  assert.equal(hosted.visitorSettings(a).leagueId, '123');
  assert.equal(hosted.visitorSettings(a).espnS2, 'secret-cookie');
  assert.deepEqual(hosted.visitorSettings(a).untouchables, [7]);
  assert.equal(hosted.visitorSettings(b).leagueId, '', 'another visitor starts empty');
  const files = fs.readdirSync(path.join(dir, 'users'));
  assert.equal(files.length, 1);
  assert.ok(!files[0].includes(a));
  const raw = fs.readFileSync(path.join(dir, 'users', files[0]), 'utf8');
  assert.ok(!raw.includes('secret-cookie'), 'cookies are not stored in the clear');
});

test('a new visitor gets a session cookie; a returning one keeps theirs', () => {
  const headers = {};
  const res = { setHeader: (k, v) => { headers[k] = v; } };
  const sid = hosted.sessionId({ headers: {}, socket: {} }, res);
  assert.match(headers['Set-Cookie'], /HttpOnly; SameSite=Lax/);
  const again = hosted.sessionId({ headers: { cookie: `x=1; pv=${sid}` }, socket: {} }, { setHeader: () => assert.fail('no new cookie') });
  assert.equal(again, sid);
});

test('the rate limit counts per address and window', () => {
  for (let i = 0; i < 3; i++) assert.ok(hosted.allowed('1.2.3.4', 't', 3));
  assert.ok(!hosted.allowed('1.2.3.4', 't', 3));
  assert.ok(hosted.allowed('5.6.7.8', 't', 3));
});
