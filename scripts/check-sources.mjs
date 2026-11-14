// Live smoke test: run every scraper against the real site and report what it returned.
// Not part of CI (it depends on outside sites); run it when a source shows an error in Settings.
//   npm run check:sources
import * as src from '../lib/sources.mjs';

const checks = [
  ['Hashtag Basketball', () => src.fetchHashtag(), (v) => `${v.list.length} ranked`],
  ['Basketball Monster', () => src.fetchBasketballMonster(), (v) => `${v.list.length} ranked`],
  ['FantasyPros consensus', () => src.fetchFantasyPros(), (v) => `${v.list.length} ranked`],
  ['FantasyPros projections', () => src.fetchFantasyProsProjections(), (v) => `${v.list.length} projected`],
  ['RotoWire lineups', () => src.fetchLineups(), (v) => `${v.length} players listed`],
  ['Rotoworld news', () => src.fetchRotoworld(), (v) => `${v.length} items`],
  ['ESPN injuries', () => src.fetchInjuries(), (v) => `${v.length} injuries`],
];

let failed = 0;
for (const [label, run, describe] of checks) {
  const t0 = Date.now();
  try {
    const value = await run();
    console.log(`ok    ${label.padEnd(26)} ${describe(value)} (${Date.now() - t0} ms)`);
  } catch (e) {
    failed++;
    console.log(`FAIL  ${label.padEnd(26)} ${e.message}`);
  }
}
process.exit(failed ? 1 : 0);
