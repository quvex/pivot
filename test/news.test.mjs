import test from 'node:test';
import assert from 'node:assert/strict';
import { classify } from '../lib/news.mjs';

const tag = (headline, text) => classify(headline, text).tag;

test('a box-score line is a performance note whatever else it says', () => {
  assert.equal(tag('Smith will start: 21 points (8-14 FG, 2-5 3Pt) in win'), 'performance');
});

test('status headlines are recognised', () => {
  assert.equal(tag('Jones ruled out for Friday'), 'out');
  assert.equal(tag('Jones questionable for Saturday'), 'questionable');
  assert.equal(tag('Jones will return Wednesday'), 'returning');
  assert.equal(tag('Jones out for the season with ACL tear'), 'season_ending');
  assert.equal(tag('Jones to be re-evaluated in two weeks'), 'extended');
});

test('role changes are recognised, including negatives', () => {
  assert.equal(tag('Brown will start Tuesday'), 'starting');
  assert.equal(tag("Brown isn't starting Tuesday"), 'bench');
  assert.equal(tag('Brown not listed in the starting lineup'), 'bench');
  assert.equal(tag('Brown on minutes restriction'), 'minutes_limit');
});

test('the article body only counts for long-term news', () => {
  // body mentions a questionable tag for someone else: ignored
  assert.equal(tag('Lee practices fully', 'Teammate Kim is questionable.'), 'note');
  // body says the injury is long-term: used
  assert.equal(tag('Lee update', 'He will miss the rest of the season.'), 'season_ending');
});
