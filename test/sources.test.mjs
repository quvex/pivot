// Parser tests run against markup shaped like each site's real pages. The fixtures are generated
// here rather than saved copies of the sites, so the repository does not redistribute their content.
// `npm run check:sources` runs the real fetchers against the live sites.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normName, buildNameIndex, stripHtml,
  parseHashtag, parseBasketballMonster, parseFantasyPros, parseFantasyProsProjections, parseLineups, parseRotoworld,
} from '../lib/sources.mjs';

const N = 60;
const names = Array.from({ length: N }, (_, i) => `Test Player${String.fromCharCode(65 + (i % 26))}${i}`);

test('names normalise across accents, suffixes and nicknames', () => {
  assert.equal(normName('Nikola Jokić'), 'nikola jokic');
  assert.equal(normName('Jaren Jackson Jr.'), 'jaren jackson');
  assert.equal(normName("De'Aaron Fox"), 'deaaron fox');
  assert.equal(normName('Nic Claxton'), 'nicolas claxton');
});

test('the name index matches full names and unambiguous initials', () => {
  const find = buildNameIndex([{ id: 1, name: 'Nikola Jokic' }, { id: 2, name: 'Jalen Williams' }, { id: 3, name: 'Jaylin Williams' }]);
  assert.equal(find('Nikola Jokić'), 1);
  assert.equal(find('N. Jokic'), 1);
  assert.equal(find('J. Williams'), null, 'two J. Williams: ambiguous, so no match');
  assert.equal(find('Nobody Here'), null);
});

test('stripHtml removes tags and decodes entities', () => {
  assert.equal(stripHtml('<b>Tom &amp; Jerry</b>&nbsp; <i>&#39;s</i>'), "Tom & Jerry 's");
});

test('Hashtag Basketball rankings', () => {
  const rows = names.map((n, i) => `<tr><td title="RANK"> ${i + 1} </td><td title="NAME"><span class="d-none d-sm-inline">${n}</span></td></tr>`).join('');
  const out = parseHashtag(`<table>${rows}</table>`);
  assert.equal(out.list.length, N);
  assert.deepEqual(out.list[0], { name: names[0], rank: 1 });
  assert.throws(() => parseHashtag('<table><tr><td>nothing</td></tr></table>'), /layout changed/);
});

test('Basketball Monster rankings', () => {
  const head = '<tr><th>Rank</th><th>Value</th><th>Name</th></tr>';
  const rows = names.map((n, i) => `<tr><td>${i + 1}</td><td>0.5</td><td><a href="#">${n}</a></td></tr>`).join('');
  const out = parseBasketballMonster(`<table>${head}${rows}</table>`);
  assert.equal(out.list.length, N);
  assert.deepEqual(out.list[59], { name: names[59], rank: 60 });
});

test('FantasyPros expert consensus', () => {
  const ecr = { total_experts: 9, last_updated: 'today', players: names.map((n, i) => ({ player_name: n, rank_ecr: i + 1 })) };
  const out = parseFantasyPros(`<script>var ecrData = ${JSON.stringify(ecr)};</script>`);
  assert.equal(out.list.length, N);
  assert.match(out.basis, /9 experts/);
  assert.throws(() => parseFantasyPros('<html></html>'), /layout changed/);
});

test('FantasyPros projections', () => {
  const cols = ['Player', 'PTS', 'REB', 'AST', 'BLK', 'STL', 'FG%', 'FT%', '3PM', 'GP', 'MIN', 'TO'];
  const head = `<tr>${cols.map((c) => `<th>${c}</th>`).join('')}</tr>`;
  const rows = names.map((n) => `<tr><td><a>${n}</a> (BOS - PG)</td><td>20.5</td><td>5</td><td>6</td><td>0.5</td><td>1.2</td><td>.470</td><td>.810</td><td>2.1</td><td>70</td><td>33.0</td><td>2.4</td></tr>`).join('');
  const out = parseFantasyProsProjections(`<table>${head}${rows}</table>`);
  assert.equal(out.list.length, N);
  assert.equal(out.list[0].name, names[0]);
  assert.equal(out.list[0].pts, 20.5);
  assert.equal(out.list[0].fgp, 0.47);
});

test("RotoWire lineups: starters, bench and today's status", () => {
  const li = (n, pct, inj = '') => `<li class="lineup__player is-pct-play-${pct}" title="x"><div class="lineup__pos">PG</div><a title="${n}" href="#">${n}</a>${inj ? `<span class="lineup__inj">${inj}</span>` : ''}</li>`;
  const html = `<ul class="lineup__list is-visit"><li class="lineup__status is-confirmed">Confirmed</li>${li('Starter One', 100)}${li('Starter Two', 75, 'Ques')}<li class="lineup__title">May not play</li>${li('Bench Guy', 0, 'Out')}</ul>`;
  const out = parseLineups(html);
  assert.equal(out.length, 3);
  assert.deepEqual(out[0], { name: 'Starter One', starter: true, confirmed: true, playPct: 100, status: '' });
  assert.equal(out[1].status, 'Ques');
  assert.equal(out[2].starter, false);
  assert.equal(out[2].playPct, 0);
  assert.throws(() => parseLineups('<html></html>'), /layout changed/);
});

test('Rotoworld player news', () => {
  const post = (first, last) => `<div class="PlayerNewsPost"><span class="PlayerNewsPost-firstName">${first}</span> <span class="PlayerNewsPost-lastName">${last}</span>
    <h3 class="PlayerNewsPost-headline"> ${first} ${last} will start Friday. </h3><div class="PlayerNewsPost-analysis">Expect more minutes. <div class="PlayerNewsPost-author">- Writer</div></div>
    <div class="PlayerNewsPost-date" data-date="2026-11-14T04:11:43.638Z"></div></div>`;
  const out = parseRotoworld(post('Norman', 'Powell') + post('Josh', 'Giddey'));
  assert.equal(out.length, 2);
  assert.equal(out[0].name, 'Norman Powell');
  assert.equal(out[0].headline, 'Norman Powell will start Friday.');
  assert.equal(out[0].text, 'Expect more minutes.');
  assert.equal(out[1].time, '2026-11-14T04:11:43.638Z');
});
