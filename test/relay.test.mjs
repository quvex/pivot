import test from 'node:test';
import assert from 'node:assert/strict';

// pretend to be the public site in a browser, with the relay configured
globalThis.window = {};
globalThis.PIVOT_ESPN_RELAY = 'https://relay.example/';
const calls = [];
globalThis.fetch = async (url, opts) => { calls.push({ url, opts }); return { ok: false, status: 404 }; };
const { fetchEspnLeague } = await import('../lib/sources.mjs');

test('in the browser, pasted cookies go to the relay as headers, never as a Cookie header', async () => {
  calls.length = 0;
  await assert.rejects(fetchEspnLeague({ season: 2027, leagueId: '123', espnS2: 'AEB%2Babc', swid: '{ABCDEF01-2345-6789-ABCD-EF0123456789}' }));
  const { url, opts } = calls[0];
  assert.match(url, /^https:\/\/relay\.example\/apis\/v3\/games\/fba\/seasons\/2027\/segments\/0\/leagues\/123\?view=/);
  assert.equal(opts.headers['X-Espn-S2'], 'AEB%2Babc');
  assert.equal(opts.headers['X-Espn-Swid'], '{ABCDEF01-2345-6789-ABCD-EF0123456789}');
  assert.equal(opts.headers.Cookie, undefined);
  assert.equal(opts.credentials, undefined, 'no espn.com sign-in is sent to the relay');
});

test('in the browser, a public league goes straight to ESPN with the visitor\'s own sign-in', async () => {
  calls.length = 0;
  await assert.rejects(fetchEspnLeague({ season: 2027, leagueId: '123' }));
  assert.match(calls[0].url, /^https:\/\/lm-api-reads\.fantasy\.espn\.com\//);
  assert.equal(calls[0].opts.credentials, 'include');
  assert.equal(calls[0].opts.headers['User-Agent'], undefined);
});
