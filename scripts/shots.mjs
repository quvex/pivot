// Visual check with Playwright: screenshots of every page at desktop and phone sizes, plus the
// front page's scroll story at several points. Fails on console errors or sideways overflow.
//   node scripts/shots.mjs [baseUrl] [outDir]
/* global document, innerWidth, innerHeight, scrollTo */ // used inside page.evaluate, which runs in the browser
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';

const base = process.argv[2] || 'http://localhost:5178/';
const out = path.resolve(process.argv[3] || 'shots');
fs.mkdirSync(out, { recursive: true });
const pages = ['home', 'week', 'rankings', 'trades', 'waivers', 'news', 'settings'];
const sizes = [['desktop', { width: 1440, height: 900 }], ['phone', { width: 390, height: 844 }]];

const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const problems = [];
for (const [label, viewport] of sizes) {
  const ctx = await browser.newContext({ viewport, deviceScaleFactor: 1, colorScheme: 'dark', isMobile: label === 'phone', hasTouch: label === 'phone' });
  const page = await ctx.newPage();
  page.on('console', (m) => { if (m.type() === 'error') problems.push(`${label}: console: ${m.text()}`); });
  page.on('pageerror', (e) => problems.push(`${label}: ${e.message}`));
  for (const tab of pages) {
    await page.goto(`${base}#${tab}`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(tab === 'home' ? 3500 : 1200);
    const over = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
    if (over > 1) problems.push(`${label} ${tab}: ${over}px sideways overflow`);
    await page.screenshot({ path: path.join(out, `${label}-${tab}.png`) });
    if (tab === 'home') {
      const travel = await page.evaluate(() => { const s = document.querySelector('#stage'); return s ? s.offsetHeight - innerHeight : 0; });
      for (const f of [0.35, 0.55, 0.9]) {
        await page.evaluate((y) => scrollTo(0, y), Math.round(travel * f));
        await page.waitForTimeout(1600);
        await page.screenshot({ path: path.join(out, `${label}-home-scroll-${Math.round(f * 100)}.png`) });
      }
      await page.evaluate((y) => scrollTo(0, y), travel + 400);
      await page.waitForTimeout(900);
      await page.screenshot({ path: path.join(out, `${label}-home-below.png`) });
    }
  }
  await ctx.close();
}
await browser.close();
console.log(problems.length ? `Problems:\n${problems.join('\n')}` : 'No console errors or overflow.');
console.log(`Screenshots in ${out}`);
process.exit(problems.length ? 1 : 0);
