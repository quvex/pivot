import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fitTable, lookup, missedInARow, streakBucket } from '../lib/absence.mjs';
import { rowsFromItems } from '../lib/reports.mjs';
import { normReason, ruleGrade, gradeOf, gradeReasons } from '../lib/reasons.mjs';

test('missedInARow counts the team games since he last played', () => {
  const team = [1, 3, 5, 7, 9, 11];
  assert.equal(missedInARow(team, new Set([1, 3, 5]), 11), 3);
  assert.equal(missedInARow(team, new Set([1, 3, 5]), 8), 1); // games after the day are not known yet
  assert.equal(missedInARow(team, new Set([11]), 11), 0);
});

test('a table answers with as much as it is told, and thin cells lean on the level above', () => {
  const rows = [];
  for (let i = 0; i < 200; i++) rows.push({ k: 0, y: 0.9 });
  for (let i = 0; i < 100; i++) rows.push({ k: 5, status: 'Out', sev: 2, y: 0.6 });
  for (let i = 0; i < 100; i++) rows.push({ k: 5, status: 'Out', sev: 5, y: 0 });
  rows.push({ k: 5, status: 'Out', sev: 4, y: 0 }); // one example only
  const t = fitTable(rows);
  assert.equal(streakBucket(5), 2);
  const boxOnly = lookup(t, { k: 5 });
  assert.ok(boxOnly > 0.25 && boxOnly < 0.35, `box scores alone: ${boxOnly}`);
  assert.ok(lookup(t, { k: 5, status: 'Out', sev: 2 }) > 0.5);
  assert.ok(lookup(t, { k: 5, status: 'Out', sev: 5 }) < 0.05);
  const thin = lookup(t, { k: 5, status: 'Out', sev: 4 });
  assert.ok(thin > 0.2 && thin < boxOnly, `one example barely moves it: ${thin}`);
  assert.equal(lookup(t, { k: 5, status: 'Out', sev: 3 }), lookup(t, { k: 5, status: 'Out' })); // unseen grade
  assert.equal(lookup(null, { k: 1 }), null);
});

test('rowsFromItems reads the upright report layout, wrapped reasons included', () => {
  const it = (x, y, str) => ({ x, y, str });
  const page = [
    it(425, 480, 'Player'), it(457, 480, 'Name'), it(586, 480, 'Current'), it(624, 480, 'Status'), it(666, 480, 'Reason'),
    it(667, 401, 'Injury/Illness'), it(722, 401, '-'), it(727, 401, 'Left'), it(745, 401, 'Patellar'), it(778, 401, 'Tendon;'),
    it(265, 394, 'Houston'), it(302, 394, 'Rockets'), it(426, 394, 'Oladipo,'), it(463, 394, 'Victor'), it(587, 394, 'Out'),
    it(667, 387, 'Repair'),
    it(426, 365, 'Samuels'), it(462, 365, 'Jr.,'), it(476, 365, 'Jermaine'), it(587, 365, 'Out'), it(667, 365, 'G'), it(676, 365, 'League'), it(707, 365, '-'), it(712, 365, 'Two-'), it(732, 365, 'Way'),
  ];
  assert.deepEqual(rowsFromItems([page]), [
    { name: 'Victor Oladipo', team: 'Houston Rockets', status: 'Out', reason: 'Injury/Illness - Left Patellar Tendon; Repair' },
    { name: 'Jermaine Samuels Jr.', team: 'Houston Rockets', status: 'Out', reason: 'G League - Two-Way' },
  ]);
});

test('rowsFromItems reads the sideways layout used before 2022-23', () => {
  const it = (x, y, str) => ({ x, y, str });
  const page = [
    it(64, 371, 'Player Name'), it(64, 499, 'Current Status'), it(64, 605, 'Reason'), it(64, 244, 'Team'),
    it(83, 243, 'Atlanta Hawks'), it(83, 370, 'Bogdanovic, Bogdan'), it(83, 498, 'Out'), it(83, 604, 'Injury/Illness - Right Ankle; Sprain'),
    it(101, 370, 'Hill, Solomon'), it(101, 498, 'Questionable'), it(101, 604, 'Injury/Illness - Right Hamstring; Tear'),
  ];
  assert.deepEqual(rowsFromItems([page]), [
    { name: 'Bogdan Bogdanovic', team: 'Atlanta Hawks', status: 'Out', reason: 'Injury/Illness - Right Ankle; Sprain' },
    { name: 'Solomon Hill', team: 'Atlanta Hawks', status: 'Questionable', reason: 'Injury/Illness - Right Hamstring; Tear' },
  ]);
});

test('reasons are normalised, graded by keyword when unseen, and by the lexicon when known', async () => {
  assert.equal(normReason('Injury/Illness - Left Knee; Meniscus Tear'), 'knee; meniscus tear');
  assert.equal(ruleGrade('G League - Two-Way').kind, 'gleague');
  assert.equal(ruleGrade('Injury/Illness - Right Knee; ACL Surgery').sev, 5);
  assert.equal(ruleGrade('Rest').kind, 'rest');
  assert.deepEqual(gradeOf('Injury/Illness - Left Elbow; Made Up', { 'elbow; made up': { kind: 'injury', body: 'elbow', sev: 3 } }), { kind: 'injury', body: 'elbow', sev: 3 });
});

test('gradeReasons only asks about wordings it has not seen and rejects malformed grades', async () => {
  const asked = [];
  const ask = async (system, user) => { asked.push(user); return { grades: [{ i: 0, kind: 'injury', body: 'Wing', sev: 3 }, { i: 1, kind: 'nonsense', body: 'x', sev: 2 }, { i: 2, kind: 'injury', body: 'x', sev: 9 }] }; };
  const fs = await import('node:fs');
  const file = new URL('../lib/reasons.json', import.meta.url);
  const before = fs.readFileSync(file, 'utf8');
  try {
    const lex = await gradeReasons(['Injury/Illness - Left Wing; Zzz Test', 'Right Wing; Zzz Test', 'Fin; Zzz Bad Kind', 'Tail; Zzz Bad Sev', 'Injury/Illness - Left Ankle; Sprain'], ask);
    assert.equal(asked.length, 1);
    assert.ok(!asked[0].includes('ankle; sprain'), 'already graded wordings are not sent again');
    assert.deepEqual(lex['wing; zzz test'], { kind: 'injury', body: 'wing', sev: 3 });
    assert.equal(lex['fin; zzz bad kind'], undefined);
    assert.equal(lex['tail; zzz bad sev'], undefined);
  } finally { fs.writeFileSync(file, before); }
});
