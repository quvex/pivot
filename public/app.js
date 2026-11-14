// Single-page UI. State comes from /api/state; every page is a pure render of it.
const $ = (sel, el = document) => el.querySelector(sel);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmt = (x, d = 1) => (x == null || Number.isNaN(x) ? '–' : Number(x).toFixed(d));
const signed = (x, d = 1) => (x == null ? '' : `${x > 0 ? '+' : ''}${Number(x).toFixed(d)}`);

let S = null; // server state
let byId = new Map();
const ui = {
  rank: { q: '', pos: '', show: 'all', sort: 'consensus', dir: 1, limit: 150 },
  news: { filter: 'league' },
  give: [], get: [],
  trade: { mode: 'offers', player: null, team: null, partner: null, res: null, loading: false, open: {}, custom: null, evaluating: false },
  home: { offer: undefined, loading: false },
  onboard: { input: '', league: null, teamId: null, private: false, cookies: {}, busy: false, error: '' },
};

// ---------- demo mode ----------
// The public demo is static: the state comes from a saved snapshot and the trade engine runs in
// the browser. Anything that would change data is refused with a clear message.
const DEMO = document.documentElement.dataset.demo === 'true';
const REPO_URL = 'https://github.com/quvex/pivot';
let demo = null;
async function demoApi(path, body) {
  demo ||= { state: await (await fetch('state.json')).json() };
  const url = new URL(path, location.href);
  const p = url.pathname;
  if (p.endsWith('/api/state')) return demo.state;
  if (p.endsWith('/api/status')) return { job: demo.state.job, refreshedAt: demo.state.meta.refreshedAt };
  if (p.includes('/api/trade/')) {
    if (!demo.ctx) {
      const [{ tradeContext, evaluateTrade, mockOffers }, { ownership }] = await Promise.all([import('./lib/trade.mjs'), import('./lib/ownership.mjs')]);
      const d = { players: demo.state.players, league: demo.state.demo.league, schedule: demo.state.demo.schedule, meta: demo.state.meta };
      demo.ctx = tradeContext(d, ownership(d, demo.state.demo.settings));
      demo.lib = { evaluateTrade, mockOffers };
    }
    const num = (k) => (url.searchParams.get(k) ? Number(url.searchParams.get(k)) : null);
    if (p.endsWith('/offers')) return demo.lib.mockOffers(demo.ctx, { playerId: num('player'), teamId: num('team') });
    if (p.endsWith('/evaluate')) return { trade: demo.lib.evaluateTrade(demo.ctx, body.give || [], body.get || []) };
  }
  throw new Error('This is a read-only demo. Run Pivot on your own league to change settings or refresh data.');
}

async function api(path, body) {
  if (DEMO) return demoApi(path, body);
  const res = await fetch(path, body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : undefined);
  const json = await res.json();
  if (!res.ok) { const err = new Error(json.error || `Request failed (${res.status})`); err.code = json.code; throw err; }
  return json;
}

async function load() {
  S = await api('/api/state');
  byId = new Map((S.players || []).map((p) => [p.id, p]));
  ui.trade.res = null; ui.trade.custom = null; ui.home.offer = undefined;
  $('#player-names').innerHTML = (S.players || []).map((p) => `<option value="${esc(p.name)}">`).join('');
  render();
  if (S.job.running) poll();
}

let polling = false;
async function poll() {
  if (polling) return;
  polling = true;
  renderChrome();
  for (;;) {
    await new Promise((r) => setTimeout(r, 1500));
    const st = await api('/api/status').catch(() => null);
    if (st && !st.job.running) break;
  }
  polling = false;
  await load();
}

// ---------- chrome ----------
function timeAgo(t) {
  const m = Math.round((Date.now() - t) / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  if (m < 48 * 60) return `${Math.round(m / 60)}h ago`;
  return `${Math.round(m / 1440)}d ago`;
}

function renderChrome() {
  const tab = (location.hash || '#home').slice(1);
  for (const a of document.querySelectorAll('#tabs a')) a.classList.toggle('active', a.dataset.tab === tab);
  const busy = polling || S?.job.running;
  $('#refresh').disabled = busy;
  $('#refresh span').textContent = busy ? 'Updating' : 'Refresh';
  const failed = S?.ready ? S.meta.status.filter((s) => !s.ok) : [];
  // status bar: the state of the data, always in view
  if (S?.ready) {
    const m = S.meta, ok = m.status.length - failed.length, bt = m.backtest?.results?.find((r) => r.key === 'model');
    $('#statusbar').innerHTML = [
      `<span><i class="dot ${failed.length ? 'off' : ''}"></i>${ok}/${m.status.length} feeds live</span>`,
      DEMO ? `<span>Snapshot of ${esc(new Date(m.refreshedAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }))}</span>` : `<span>Updated ${timeAgo(m.refreshedAt)}</span>`,
      S.league ? `<span>${esc(S.league.name)}</span>` : '',
      `<span>Replacement ${fmt(m.repl)} FP/G</span>`,
      bt ? `<span title="Average miss in rest-of-season FP/G on the ${esc(m.backtest.testSeason)} season, which the model was not tuned on">Model miss ±${bt.mae.toFixed(2)} FP/G</span>` : '',
    ].join('');
  }
  if (DEMO) {
    $('#refresh').hidden = true;
    $('#banner').innerHTML = `<div class="bar demo"><span><b>Demo.</b> A frozen snapshot of one real league from ${S?.ready ? esc(new Date(S.meta.refreshedAt).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })) : 'November 2026'}, with team names changed. Trades and the builder work live; refreshing and settings are off.</span> <a href="#settings">About</a> · <a href="${REPO_URL}" target="_blank" rel="noopener noreferrer">Source on GitHub</a></div>`;
    return;
  }
  $('#banner').innerHTML = busy
    ? '<div class="bar busy">Pulling rankings, stats and news. This takes about 15 seconds.</div>'
    : S?.job.error ? `<div class="bar err">Update failed: ${esc(S.job.error)}</div>`
    : failed.length ? `<div class="bar err">${failed.map((f) => `${esc(f.label)}: ${esc(f.detail)}`).join(' · ')} <a href="#settings">Details</a></div>` : '';
}

// Motion (motion.dev) handles the app's state transitions; the front page's scroll story uses GSAP.
const motion = import('https://cdn.jsdelivr.net/npm/motion@11.11.17/+esm').catch(() => null);
const calm = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
let lastTab = null;
function render() {
  renderChrome();
  const tab = (location.hash || '#home').slice(1);
  if (tab !== 'home') { unmountStage?.(); unmountStage = null; }
  document.body.dataset.page = tab;
  if (tab !== lastTab && lastTab !== null && !calm()) {
    motion.then((m) => m?.animate($('#app'), { opacity: [0, 1], transform: ['translateY(10px)', 'translateY(0)'] }, { duration: 0.42, ease: [0.16, 1, 0.3, 1] }));
  }
  lastTab = tab;
  const app = $('#app');
  if (tab !== 'settings' && !DEMO) {
    const busy = S.job.running || polling;
    const connected = S.settings.leagueId || (S.settings.manualRoster || []).length;
    if (!connected) return renderOnboard(app);
    if (busy && (!S.ready || (S.settings.leagueId && !S.league))) return renderSettingUp(app);
    if (!S.ready) {
      app.innerHTML = '<div class="panel"><div class="empty">No data yet. Press Refresh to pull rankings and news.</div></div>';
      return;
    }
  }
  ({ home: renderHome, week: renderWeek, rankings: renderRankings, trades: renderTrades, waivers: renderWaivers, news: renderNews, settings: renderSettings }[tab] || renderHome)(app);
}

// ---------- shared bits ----------
const INJ = { OUT: ['OUT', 'bad'], DAY_TO_DAY: ['DTD', 'warn'], SUSPENSION: ['SUSP', 'bad'] };
function ownChip(o) {
  if (!o) return '';
  if (o.type === 'mine') return '<span class="chip mine">My team</span>';
  if (o.type === 'fa') return '<span class="chip good">Free agent</span>';
  if (o.type === 'team') return `<span class="chip plain">${esc(o.team)}</span>`;
  return '';
}
function playerCell(p) {
  const inj = INJ[p.injuryStatus];
  const sig = p.signal ? `<span class="call ${p.signal.type}">${p.signal.type === 'buy' ? 'Buy low' : 'Sell high'}</span>` : '';
  return `<div class="player"><span class="nm">${esc(p.name)} ${inj ? `<span class="chip inj ${inj[1]}">${inj[0]}</span>` : ''}${sig}</span>
    <span class="sub">${esc(p.team)} · ${esc(p.pos)} ${ownChip(p.own)}</span></div>`;
}
const plink = (p) => `<span class="pl" data-player="${p.id}">${esc(p.name)} <small>${esc(p.team)} ${esc(p.pos)}</small></span>`;

// ---------- front page ----------
const TRI = (up) => `<svg class="tri" viewBox="0 0 10 10" width="8" height="8" aria-hidden="true"><path d="${up ? 'M5 1l4.5 8h-9z' : 'M5 9L.5 1h9z'}" fill="currentColor"/></svg>`;
const skLines = (n, w = [100, 92, 76]) => Array.from({ length: n }, (_, i) => `<div class="sk" style="height:12px;width:${w[i % w.length]}%;margin-top:${i ? 10 : 0}px"></div>`).join('');

// A dithered landscape flown over in real time: a height field drawn column by column, front
// to back (the old voxel-terrain trick), then reduced to six ember tones with an ordered dither.
let stopTerrain = null;
function startTerrain(canvas) {
  stopTerrain?.();
  const W = 384, H = 208, N = 256, M = N - 1;
  canvas.width = W; canvas.height = H;
  const ctx = canvas.getContext('2d');
  const img = ctx.createImageData(W, H);
  const px = new Uint32Array(img.data.buffer);
  let seed = 11;
  const rnd = () => { seed |= 0; seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  const hm = new Float32Array(N * N);
  for (let o = 0; o < 4; o++) {
    const cells = 3 << o, amp = 1 / (1 << o);
    const g = Float32Array.from({ length: cells * cells }, rnd);
    for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
      const fx = (x / N) * cells, fy = (y / N) * cells, ix = fx | 0, iy = fy | 0;
      const tx = fx - ix, ty = fy - iy, sx = tx * tx * (3 - 2 * tx), sy = ty * ty * (3 - 2 * ty);
      const a = g[iy * cells + ix], b = g[iy * cells + ((ix + 1) % cells)], c = g[((iy + 1) % cells) * cells + ix], d = g[((iy + 1) % cells) * cells + ((ix + 1) % cells)];
      hm[y * N + x] += amp * (a + (b - a) * sx + (c - a) * sy + (a - b - c + d) * sx * sy);
    }
  }
  let lo = Infinity, hi = -Infinity;
  for (const v of hm) { if (v < lo) lo = v; if (v > hi) hi = v; }
  for (let i = 0; i < hm.length; i++) hm[i] = ((hm[i] - lo) / (hi - lo)) ** 1.7 * 120;
  const abgr = (hex) => 0xff000000 | ((hex & 255) << 16) | (hex & 0xff00) | (hex >> 16);
  const PAL = [0x120b07, 0x2a1408, 0x5a260c, 0xa8480f, 0xee7a22, 0xffc78a].map(abgr);
  const BAYER = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5].map((v) => (v + 0.5) / 16);
  const tone = (v, x, y) => { v = Math.min(0.999, Math.max(0, v)) * (PAL.length - 1); const i = v | 0; return PAL[i + (v - i > BAYER[(y & 3) * 4 + (x & 3)] ? 1 : 0)]; };
  const stars = Array.from({ length: 70 }, () => [(rnd() * W) | 0, (rnd() * H * 0.5) | 0]);
  const draw = (t) => {
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) px[y * W + x] = tone(0.05 + 0.1 * (y / H), x, y);
    for (const [x, y] of stars) px[y * W + x] = PAL[3];
    const mx0 = (W * 0.27) | 0, my0 = 40, r = 10;
    for (let y = -r; y <= r; y++) for (let x = -r; x <= r; x++) if (x * x + y * y <= r * r) px[(my0 + y) * W + mx0 + x] = PAL[4];
    const cx = 128 + Math.sin(t * 0.07) * 26, cy = t * 7, camH = 150, horizon = 74, scale = 150;
    for (let x = 0; x < W; x++) {
      const ang = (x / W - 0.5) * 1.05, dx = Math.sin(ang), dy = Math.cos(ang);
      let ybuf = H;
      for (let z = 5, dz = 1; z < 330 && ybuf > 0; z += dz, dz += 0.012) {
        const ax = (cx + dx * z) & M, ay = (cy + dy * z) & M;
        const h = hm[ay * N + ax];
        let sy = ((camH - h) / z * scale + horizon) | 0;
        if (sy >= ybuf) continue;
        if (sy < 0) sy = 0;
        const slope = hm[ay * N + ((ax + 2) & M)] - hm[ay * N + ((ax - 2) & M)];
        const v = (0.5 + slope * 0.045) * (0.28 + 0.72 * Math.min(1, z / 170)); // near ground sits in shadow
        for (let y = sy; y < ybuf; y++) px[y * W + x] = tone(v, x, y);
        ybuf = sy;
      }
    }
    ctx.putImageData(img, 0, 0);
  };
  const still = matchMedia('(prefers-reduced-motion: reduce)').matches;
  let raf = 0, last = 0;
  const t0 = performance.now();
  const loop = (now) => {
    if (!canvas.isConnected) return;
    raf = requestAnimationFrame(loop);
    if (document.hidden || now - last < 42) return; // ~24 frames a second is plenty for a dither
    last = now;
    draw((now - t0) / 1000);
  };
  draw(0);
  if (!still) raf = requestAnimationFrame(loop);
  stopTerrain = () => cancelAnimationFrame(raf);
}

async function loadHomeOffer() {
  if (ui.home.loading || ui.home.offer !== undefined) return;
  ui.home.loading = true;
  try { ui.home.offer = (await api('/api/trade/offers')).offers[0] || null; } catch { ui.home.offer = null; }
  ui.home.loading = false;
  const el = $('#home-offer');
  if (el) el.innerHTML = homeOffer();
}

function homeOffer() {
  const t = ui.home.offer;
  if (t === undefined) return `<div aria-busy="true">${skLines(2, [60, 44])}<div style="margin-top:16px">${skLines(3)}</div></div>`;
  if (!t) return `<p class="muted">${S.hasRoster ? 'No trade clears the bar today.' : 'Sync your league in Settings to get trade ideas.'}</p>`;
  const nm = (ids) => ids.map((id) => `<span class="pl" data-player="${id}">${esc(byId.get(id).name)}</span>`).join('<br>');
  return `<div class="swap"><div><span class="k">Give</span>${nm(t.give)}</div><div><span class="k">Get</span>${nm(t.get)}</div>
      <div class="swap-n"><b class="num">+${t.delta}</b><span>points</span></div></div>
    <p class="argument">${esc(t.summary.split('. ').slice(0, 2).join('. '))}.</p>
    <p class="meta">${esc(t.partner ? `With ${t.partner.name}` : 'Trade idea')} · ${esc(t.accept.label)} to be accepted · <button type="button" class="btn link" data-home-edit>Open in builder</button></p>`;
}

const ordinal = (n) => {
  const teen = n % 100 >= 11 && n % 100 <= 13;
  return `${n}${teen ? 'th' : { 1: 'st', 2: 'nd', 3: 'rd' }[n % 10] || 'th'}`;
};

let unmountStage = null;
function renderHome(app) {
  const w = S.week, me = w?.teams.find((t) => t.mine), leader = w?.teams[0];
  const movers = S.players.filter((p) => p.signal).sort((a, b) => b.signal.score - a.signal.score).slice(0, 9);
  const arc = S.players.filter((p) => p.s.season?.gp >= 3 && p.model.rank <= 140)
    .map((p) => ({ p, d: p.model.fpg - p.market.recent })).sort((a, b) => Math.abs(b.d) - Math.abs(a.d)).slice(0, innerWidth < 760 ? 7 : 11);
  const tape = S.players.filter((p) => p.s.season?.gp >= 3 && p.model.rank <= 140)
    .map((p) => ({ p, d: p.model.fpg - p.market.recent })).sort((a, b) => Math.abs(b.d) - Math.abs(a.d)).slice(0, 28);
  const tapeHtml = tape.map(({ p, d }) => `<span class="tick" data-player="${p.id}"><b>${esc(p.name)}</b><span class="num">${fmt(p.model.fpg)}</span><span class="num ${d >= 0 ? 'up' : 'down'}">${TRI(d >= 0)}${fmt(Math.abs(d))}</span></span>`).join('');
  const moves = (w?.my?.advice || []).slice(0, 3).map((a) => a.split(/: (?=[a-z])/)[0].replace(/\.$/, ''));
  const today = new Date(DEMO ? S.meta.refreshedAt : Date.now()).toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });
  const m = myMatchup(w);
  const board = !me ? '' : m
    ? `<div class="board">
        <div><b>${me.record ? `${me.record.wins}-${me.record.losses}` : ordinal(me.rank)}</b><span>${ordinal(me.rank)} of ${w.teams.length}</span></div>
        <div><b class="num">${m.me.projected.toLocaleString('en-US')}</b><span>vs ${esc(m.opp.name)} ${m.opp.projected.toLocaleString('en-US')}</span></div>
        <div><b class="num">${Math.round(m.win * 100)}%</b><span>to win this week</span></div></div>`
    : `<div class="board">
        <div><b>${ordinal(me.rank)}</b><span>of ${w.teams.length}</span></div>
        <div><b class="num">${me.points.toLocaleString('en-US')}</b><span>points</span></div>
        <div><b class="num">${me.rank === 1 ? 'Lead' : `−${(leader.points - me.points).toLocaleString('en-US')}`}</b><span>${me.rank === 1 ? `by ${(me.points - w.teams[1].points).toLocaleString('en-US')}` : `to ${esc(leader.name)}`}</span></div></div>`;

  app.innerHTML = `
    <section class="stage" id="stage" data-beat="a">
      <div class="stage-pin">
        <canvas id="court" aria-hidden="true"></canvas>
        <div class="col-labels" id="col-labels"></div>
        <div class="beat beat-a">
          <h1 class="wordmark">Pivot</h1>
          <p>Your league, priced every morning.</p>
        </div>
        <div class="beat beat-b">
          <h2>Where the market is wrong</h2>
          <p>Each column is a player's rest-of-season projection. Green ones are playing below it, red ones above. Click one for the details.</p>
        </div>
        <aside class="jumbotron" aria-label="Today">
          <p class="today-date">${esc(today)}${me ? ` · ${esc(me.name)}` : ''}</p>
          ${me ? `${board}
            ${moves.length ? `<ol class="moves">${moves.map((x) => `<li>${esc(x)}</li>`).join('')}</ol>` : '<p class="muted">Nothing needs action today.</p>'}
            <a class="more" href="#week">${m ? 'See the matchup' : 'Plan the week'} <span aria-hidden="true">→</span></a>`
          : `<p>Sync your ESPN league to see your standing and today's moves.</p><a class="more" href="#settings">Sync league <span aria-hidden="true">→</span></a>`}
        </aside>
      </div>
    </section>
    <div class="ticker" aria-label="Projection against recent production, biggest gaps first"><div class="track">${tapeHtml}${tapeHtml.replaceAll('data-player', 'aria-hidden="true" data-player')}</div></div>
    <div class="home-grid">
      <section class="panel"><header><h2>Mispriced today</h2><p>Where the projection and recent box scores disagree most</p></header><div class="table-wrap"><table>
        <thead><tr><th class="l">Player</th><th class="l">Call</th><th title="Projected fantasy points per game, rest of season">Proj</th><th title="What recent box scores suggest">Recent</th><th>Gap</th></tr></thead>
        <tbody>${movers.map((p) => { const d = p.model.fpg - p.market.recent; return `<tr data-player="${p.id}"><td class="l">${playerCell({ ...p, signal: null })}</td>
          <td class="l"><span class="call ${p.signal.type}">${p.signal.type === 'buy' ? 'Buy low' : 'Sell high'}</span></td>
          <td class="strong">${fmt(p.model.fpg)}</td><td>${fmt(p.market.recent)}</td><td class="${d >= 0 ? 'up' : 'down'}">${TRI(d >= 0)} ${fmt(Math.abs(d))}</td></tr>`; }).join('') || '<tr><td colspan="5" class="empty">Nothing stands out today.</td></tr>'}</tbody></table></div></section>
      <div class="home-side">
        ${w ? `<section class="panel"><header><h2>Standings</h2><p><a href="#week">Full outlook</a></p></header><div class="table-wrap"><table class="standings">
          <tbody>${w.teams.map((t) => `<tr class="${t.mine ? 'me' : ''}" style="cursor:default"><td class="rank">${t.rank}</td><td class="l">${esc(t.name)}</td>${t.record && w.kind !== 'season' ? `<td class="strong">${t.record.wins}-${t.record.losses}${t.record.ties ? `-${t.record.ties}` : ''}</td><td class="muted">${t.pointsFor.toLocaleString('en-US')}</td>` : `<td class="strong">${t.points.toLocaleString('en-US')}</td><td class="muted">${t.rank === 1 ? '' : `−${(leader.points - t.points).toLocaleString('en-US')}`}</td>`}</tr>`).join('')}</tbody></table></div></section>` : ''}
        <section class="panel"><header><h2>Best offer on the table</h2><p><a href="#trades">All offers</a></p></header><div class="body" id="home-offer">${homeOffer()}</div></section>
      </div>
    </div>`;

  const stage = $('#stage');
  unmountStage?.();
  unmountStage = null;
  import('./stage.js').then(({ mountStage }) => {
    if (!stage.isConnected) return;
    unmountStage = mountStage({
      canvas: $('#court'), labels: $('#col-labels'), section: stage,
      players: arc.map(({ p, d }) => ({ id: p.id, name: p.name, fpg: p.model.fpg, gap: d })),
      onPick: (id) => openPlayer(id),
      onPhase: (pr) => { stage.dataset.beat = pr < 0.2 ? 'a' : pr < 0.74 ? 'b' : 'c'; },
    });
  }).catch(() => stage.classList.add('no-webgl'));
  loadHomeOffer();
  app.onclick = (e) => {
    if (!e.target.closest('[data-home-edit]') || !ui.home.offer) return;
    const t = ui.home.offer;
    openBuilder({ give: t.give, get: t.get, partner: t.partner?.id ?? null });
  };
}

// ---------- first run ----------
// Shown until a league is connected (or players are added by hand). One card over the landscape:
// find the league, unlock it if it is private, pick your team, start.
function renderOnboard(app) {
  const o = ui.onboard;
  const lg = o.league;
  const title = lg ? 'Which team is yours?' : o.private ? 'This league is private' : 'Connect your ESPN league';
  app.innerHTML = `
    <section class="hero onboard">
      <canvas id="terrain" aria-hidden="true"></canvas>
      <h1 class="hero-word" aria-label="Pivot">Pivot</h1>
      <div class="today ob">
        <p class="today-date">Set up · about a minute</p>
        <h2 class="ob-title">${title}</h2>
        ${!lg ? `<form id="ob-find" class="ob-form" novalidate>
            <label for="ob-id">League link or ID</label>
            <input id="ob-id" value="${esc(o.input)}" placeholder="fantasy.espn.com/basketball/league?leagueId=…" autocomplete="off" spellcheck="false">
            ${o.private ? `<p class="ob-help">ESPN only shows private leagues to their members. While signed in to espn.com, open your browser's developer tools, then Application → Cookies → espn.com, and copy these two values. They stay on this computer and are only ever sent to ESPN.</p>
              <label for="ob-s2">espn_s2</label><input id="ob-s2" type="password" autocomplete="off">
              <label for="ob-swid">SWID</label><input id="ob-swid" type="password" autocomplete="off" placeholder="{XXXXXXXX-XXXX-…}">`
            : '<p class="ob-help">Open your league on fantasy.espn.com and copy the address from the browser bar.</p>'}
            ${o.error ? `<p class="ob-err" role="alert">${esc(o.error)}</p>` : ''}
            <div class="ob-actions"><button class="btn primary"${o.busy ? ' aria-busy="true"' : ''}>${o.busy ? 'Looking it up…' : o.private ? 'Try again' : 'Find league'}</button></div>
          </form>`
        : `<p class="ob-league"><b>${esc(lg.name)}</b><span>${esc(lg.format.label)} · ${lg.teams.length} teams</span></p>
          ${lg.format.supported ? '' : '<p class="ob-warn">Pivot is built for points leagues. It still works here, but ranks players and trades on ESPN\'s default points scoring as a stand-in for category value.</p>'}
          <div class="ob-teams" role="radiogroup" aria-label="Your team">${lg.teams.map((t) => `<button type="button" role="radio" aria-checked="${o.teamId === t.id}" class="ob-team ${o.teamId === t.id ? 'on' : ''}" data-team="${t.id}"><b>${esc(t.name)}</b>${t.owner ? `<span>${esc(t.owner)}</span>` : ''}</button>`).join('')}</div>
          ${o.error ? `<p class="ob-err" role="alert">${esc(o.error)}</p>` : ''}
          <div class="ob-actions"><button type="button" class="btn primary" id="ob-go"${o.busy ? ' aria-busy="true"' : ''}>${o.busy ? 'Starting…' : 'Start'}</button><button type="button" class="btn link" id="ob-back">Use a different league</button></div>`}
        <p class="ob-alt">No ESPN league? <a href="#settings">Pick your players by hand</a>.</p>
      </div>
    </section>`;
  startTerrain($('#terrain'));
  const again = () => renderOnboard(app);

  const form = $('#ob-find');
  if (form) {
    form.onsubmit = async (e) => {
      e.preventDefault();
      if (o.busy) return;
      o.input = $('#ob-id').value.trim();
      if (!o.input) { o.error = 'Paste your league link or ID first.'; return again(); }
      const cookies = o.private ? { espnS2: $('#ob-s2').value.trim(), swid: $('#ob-swid').value.trim() } : {};
      if (o.private && (!cookies.espnS2 || !cookies.swid)) { o.error = 'Both cookies are needed for a private league.'; return again(); }
      o.busy = true; o.error = ''; again();
      try {
        const { league } = await api('/api/league/preview', { leagueId: o.input, ...cookies });
        o.league = league;
        o.cookies = cookies;
        o.teamId = league.teams.find((t) => t.isMine)?.id ?? null;
      } catch (err) {
        if (err.code === 'private') { o.error = o.private ? err.message : ''; o.private = true; } else o.error = err.message;
      }
      o.busy = false; again();
      $('#ob-id')?.focus();
    };
    if (!o.input) $('#ob-id').focus();
    return;
  }
  app.querySelector('.ob-teams').onclick = (e) => {
    const b = e.target.closest('[data-team]');
    if (b) { o.teamId = +b.dataset.team; o.error = ''; again(); }
  };
  $('#ob-back').onclick = () => { Object.assign(o, { league: null, teamId: null, error: '' }); again(); };
  $('#ob-go').onclick = async () => {
    if (o.busy) return;
    if (o.teamId == null) { o.error = 'Pick your team first.'; return again(); }
    o.busy = true; o.error = ''; again();
    try {
      await api('/api/settings', { leagueId: o.league.id, teamId: o.teamId, ...o.cookies });
      Object.assign(o, { busy: false, league: null, cookies: {} });
      await load();
    } catch (err) { o.busy = false; o.error = err.message; again(); }
  };
}

function renderSettingUp(app) {
  app.innerHTML = `
    <section class="hero onboard">
      <canvas id="terrain" aria-hidden="true"></canvas>
      <h1 class="hero-word" aria-label="Pivot">Pivot</h1>
      <div class="today ob" aria-busy="true">
        <p class="today-date">Setting up</p>
        <h2 class="ob-title">Pulling your league</h2>
        <p class="ob-help">Rosters, standings, scoring, a season of box scores and ten outside sources. This takes about 20 seconds.</p>
        <div class="ob-progress"><i></i></div>
      </div>
    </section>`;
  startTerrain($('#terrain'));
}

// ---------- head-to-head ----------
function myMatchup(w) {
  const id = S.myTeam?.id;
  const g = w?.h2h?.games.find((x) => x.home.id === id || x.away.id === id);
  if (!g) return null;
  const me = g.home.id === id ? g.home : g.away;
  return { me, opp: me === g.home ? g.away : g.home, win: me === g.home ? g.homeWin : 1 - g.homeWin };
}

function matchupPanel(w) {
  const m = myMatchup(w);
  if (!m) return '';
  const day = (d) => new Date(`${d}T12:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
  const side = (t, cls) => `<div class="mu-side ${cls}"><span class="mu-name">${esc(t.name)}</span><b class="num">${t.projected.toLocaleString('en-US')}</b>
    <span class="mu-sub">${t.points.toLocaleString('en-US')} so far · ${t.starts} start${t.starts === 1 ? '' : 's'} left${t.open ? ` · ${t.open} empty slot${t.open === 1 ? '' : 's'}` : ''}</span></div>`;
  const pct = Math.round(m.win * 100);
  return `<div class="panel"><header><h2>Matchup ${w.h2h.period}</h2><p>${w.h2h.from ? `${day(w.h2h.from)} to ${day(w.h2h.to)} · ` : ''}projected final score</p></header><div class="body">
    <div class="mu">${side(m.me, 'me')}<div class="mu-mid"><b>${pct}%</b><span>chance to win</span></div>${side(m.opp, 'opp')}</div>
    <div class="mu-bar" role="img" aria-label="${pct}% chance to win"><i style="width:${pct}%"></i></div>
    <p class="chart-note">Score so far plus each team's best legal lineup for every remaining day. The chance allows for game-to-game swings and injury odds.</p>
  </div></div>`;
}

function h2hStandings(w) {
  const rec = (r) => (r ? `${r.wins}-${r.losses}${r.ties ? `-${r.ties}` : ''}` : '–');
  return `<div class="panel"><header><h2>Standings</h2><p>${esc(w.formatLabel)}</p></header><div class="table-wrap"><table>
    <thead><tr>${['#', 'Team', 'Record', 'Points for', ...(w.h2h ? ['This matchup', 'Win chance'] : [])].map((h, i) => `<th class="${i === 1 ? 'l' : ''}" style="cursor:default">${h}</th>`).join('')}</tr></thead>
    <tbody>${w.teams.map((t) => `<tr style="cursor:default"><td class="rank">${t.rank}</td><td class="l">${t.mine ? `<b>${esc(t.name)}</b> <span class="chip mine">You</span>` : esc(t.name)}</td>
      <td class="strong">${rec(t.record)}</td><td>${t.pointsFor.toLocaleString('en-US')}</td>
      ${w.h2h ? `<td>${t.matchup ? `${t.matchup.projected.toLocaleString('en-US')} <span class="muted">vs ${esc(t.matchup.opp)}</span>` : '–'}</td><td class="${t.matchup ? (t.matchup.win >= 0.5 ? 'up' : 'down') : 'muted'}">${t.matchup ? `${Math.round(t.matchup.win * 100)}%` : '–'}</td>` : ''}</tr>`).join('')}</tbody></table></div></div>`;
}

// ---------- rankings ----------
function renderRankings(app) {
  const r = ui.rank;
  const srcs = S.meta.sources;
  const cols = [
    { key: 'consensus', label: '#', get: (p) => p.consensus?.rank ?? 9999, title: 'Consensus rank across the outside sources' },
    { key: 'name', label: 'Player', cls: 'l', get: (p) => p.name },
    { key: 'avg', label: 'Avg', get: (p) => p.consensus?.avg ?? 9999, title: 'Average rank across sources (± spread)' },
    ...srcs.map((s, i) => ({ key: `src:${s.key}`, label: s.label, cls: i === 0 ? 'grp' : '', get: (p) => p.ranks[s.key] ?? 9999, title: `${s.full}: ${s.basis}` })),
    { key: 'model', label: 'Model', cls: 'grp', get: (p) => p.model.rank, title: 'This app\'s rest-of-season rank (value above replacement)' },
    { key: 'fpg', label: 'Proj FP/G', get: (p) => -p.model.fpg, title: 'Projected fantasy points per game, rest of season' },
    { key: 'delta', label: 'Δ day', get: (p) => -(p.delta.fpg ?? 0), title: 'Change in projection since the previous daily update' },
    { key: 'l15', label: 'L15', cls: 'grp', get: (p) => -(p.s.l15?.fp ?? -1), title: 'Fantasy points per game, last 15 days' },
    { key: 'season', label: 'Season', get: (p) => -(p.s.season?.fp ?? -1), title: 'Fantasy points per game this season' },
    { key: 'owned', label: 'Rost%', get: (p) => -p.owned, title: 'Rostered in ESPN leagues' },
  ];
  const col = cols.find((c) => c.key === r.sort) || cols[0];
  const q = r.q.trim().toLowerCase();
  let rows = S.players.filter((p) => (!q || p.name.toLowerCase().includes(q) || p.team.toLowerCase() === q)
    && (!r.pos || p.pos === r.pos)
    && (r.show === 'all' || (r.show === 'mine' && p.own.type === 'mine') || (r.show === 'fa' && (p.own.type === 'fa' || (p.own.type === 'unknown' && p.owned < 60)))));
  rows.sort((a, b) => {
    const x = col.get(a), y = col.get(b);
    return (typeof x === 'string' ? x.localeCompare(y) : x - y) * r.dir || a.model.rank - b.model.rank;
  });
  const total = rows.length;
  rows = rows.slice(0, r.limit);
  const scoring = Object.entries(S.meta.scoring).map(([k, v]) => `${S.statLabels[k] || k} ${signed(v, Number.isInteger(v) ? 0 : 1)}`).join(' · ');

  app.innerHTML = `
    <div class="page-head">
      <div><h1>Player rankings</h1>
        <p>Five ranking desks beside Pivot's own projection. Hover a column for its source. <span class="muted">Scoring: ${esc(scoring)}</span> <span class="chip plain">${S.meta.scoringSource === 'league' ? 'from your league' : S.meta.scoringSource === 'custom' ? 'custom' : 'ESPN default'}</span></p></div>
      <div class="controls">
        <input type="search" id="q" placeholder="Search player or team" value="${esc(r.q)}">
        <select id="pos"><option value="">All positions</option>${['PG', 'SG', 'SF', 'PF', 'C'].map((x) => `<option ${r.pos === x ? 'selected' : ''}>${x}</option>`).join('')}</select>
        <div class="seg" id="show">${[['all', 'All'], ['mine', 'My team'], ['fa', S.league ? 'Free agents' : 'Widely available']].map(([k, l]) => `<button data-v="${k}" class="${r.show === k ? 'on' : ''}">${l}</button>`).join('')}</div>
      </div>
    </div>
    <div class="panel"><div class="table-wrap"><table>
      <thead><tr>${cols.map((c) => `<th class="${c.cls || ''} ${c.key === r.sort ? 'sorted' : ''}" data-sort="${c.key}" title="${esc(c.title || '')}">${esc(c.label)}${c.key === r.sort ? (r.dir === 1 ? ' ↑' : ' ↓') : ''}</th>`).join('')}</tr></thead>
      <tbody>${rows.map((p) => `<tr data-player="${p.id}">
        <td class="rank">${p.consensus?.rank ?? '–'}</td>
        <td class="l">${playerCell(p)}</td>
        <td>${p.consensus ? `${fmt(p.consensus.avg)} <span class="spread">±${fmt(p.consensus.sd, 0)}</span>` : '–'}</td>
        ${srcs.map((s, i) => `<td class="${i === 0 ? 'grp' : ''}">${p.ranks[s.key] ?? '<span class="muted">–</span>'}</td>`).join('')}
        <td class="grp strong">${p.model.rank}</td>
        <td class="strong">${fmt(p.model.fpg)}</td>
        <td class="${p.delta.fpg > 0 ? 'up' : p.delta.fpg < 0 ? 'down' : 'muted'}">${p.delta.fpg ? signed(p.delta.fpg) : '–'}</td>
        <td class="grp">${fmt(p.s.l15?.fp)}</td>
        <td>${fmt(p.s.season?.fp)}</td>
        <td class="muted">${fmt(p.owned, 0)}</td>
      </tr>`).join('') || `<tr><td colspan="${cols.length}" class="empty">${r.show === 'mine' && !S.hasRoster ? 'No roster yet. Add your league or players in Settings.' : 'No players match.'}</td></tr>`}</tbody>
    </table></div>
    ${total > rows.length ? `<div class="empty"><button class="btn small" id="more">Show all ${total} players</button></div>` : ''}</div>
    <p class="muted" style="margin-top:10px;font-size:12px">${S.meta.comparedTo ? `Δ day compares with the ${esc(S.meta.comparedTo)} update.` : 'Δ day fills in after tomorrow\'s update, once there is a previous day to compare with.'} Replacement level: ${fmt(S.meta.repl)} FP/G.</p>`;

  $('#q').oninput = (e) => { r.q = e.target.value; renderRankings(app); const el = $('#q'); el.focus(); el.setSelectionRange(r.q.length, r.q.length); };
  $('#pos').onchange = (e) => { r.pos = e.target.value; renderRankings(app); };
  $('#show').onclick = (e) => { if (e.target.dataset.v) { r.show = e.target.dataset.v; renderRankings(app); } };
  $('thead', app).onclick = (e) => {
    const k = e.target.closest('th')?.dataset.sort;
    if (!k) return;
    if (r.sort === k) r.dir *= -1; else { r.sort = k; r.dir = 1; }
    renderRankings(app);
  };
  if ($('#more')) $('#more').onclick = () => { r.limit = 9999; renderRankings(app); };
}

// ---------- charts ----------
// Two series colours only: players you get and players you give. Text stays in ink.
const SIDE = { get: 'var(--s-get)', give: 'var(--s-give)' };
const niceMax = (v) => { const step = v > 80 ? 20 : 10; return Math.ceil(v / step) * step; };

// Game-by-game fantasy points for each player (small multiples on one shared scale).
function formChart(entries) {
  const N = 25;
  const logs = entries.map((e) => (e.p.log || []).slice(-N));
  const max = niceMax(Math.max(20, ...logs.flat().map((g) => g.fp), ...entries.map((e) => e.p.model.fpg + e.p.model.sd)));
  const W = 280, H = 140, L = 26, R = 40, T = 8, B = 16, pw = W - L - R, ph = H - T - B;
  const y = (v) => T + ph * (1 - Math.max(0, Math.min(max, v)) / max);
  return `<div class="chart-grid">${entries.map((e, k) => {
    const { p, side } = e, log = logs[k], n = log.length;
    if (!n) return `<figure class="mini"><figcaption><i class="sw" style="background:${SIDE[side]}"></i><b>${esc(p.name)}</b></figcaption><div class="empty" style="padding:30px 0">No games played yet this season.</div></figure>`;
    const step = pw / Math.max(n, 12), bw = Math.max(2, step - 2);
    const cx = (i) => L + i * step + step / 2;
    const bars = log.map((g, i) => { const top = y(g.fp), h = Math.max(1, T + ph - top), r = Math.min(2, bw / 2, h); const x = cx(i) - bw / 2;
      return `<path d="M${x.toFixed(1)},${T + ph}V${(top + r).toFixed(1)}q0,${-r} ${r},${-r}h${(bw - 2 * r).toFixed(1)}q${r},0 ${r},${r}V${T + ph}z" fill="${SIDE[side]}"/>`; }).join('');
    const roll = log.map((_, i) => { const w = log.slice(Math.max(0, i - 4), i + 1); return `${cx(i).toFixed(1)},${y(w.reduce((a, g) => a + g.fp, 0) / w.length).toFixed(1)}`; });
    const fp = p.model.fpg, sd = p.model.sd;
    const hits = log.map((g, i) => `<rect x="${(L + i * step).toFixed(1)}" y="${T}" width="${step.toFixed(1)}" height="${ph}" fill="transparent" data-tip="${esc(`${fmt(g.fp)} FP in ${g.min} min · ${S.meta.nowDay - g.d === 0 ? 'latest game day' : `${S.meta.nowDay - g.d} days ago`}${g.gs ? '' : ' · off the bench'}`)}"/>`).join('');
    return `<figure class="mini"><figcaption><i class="sw" style="background:${SIDE[side]}"></i><b>${esc(p.name)}</b> <span class="muted">${side === 'get' ? 'you get' : 'you give'} · last ${n} game${n === 1 ? '' : 's'}</span></figcaption>
      <svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(`${p.name}: fantasy points in each of his last ${n} games, projection ${fp} per game`)}">
        ${[0, max / 2, max].map((v) => `<line x1="${L}" x2="${L + pw}" y1="${y(v)}" y2="${y(v)}" class="grid"/><text x="${L - 5}" y="${y(v) + 3}" text-anchor="end" class="tick">${v}</text>`).join('')}
        <rect x="${L}" width="${pw}" y="${y(fp + sd)}" height="${Math.max(0, y(fp - sd) - y(fp + sd))}" class="band"/>
        ${bars}
        ${n >= 3 ? `<polyline points="${roll.join(' ')}" class="roll"/>` : ''}
        <line x1="${L}" x2="${L + pw}" y1="${y(fp)}" y2="${y(fp)}" class="proj"/>
        <text x="${L + pw + 4}" y="${y(fp) + 3}" class="lab">${fmt(fp)}</text>
        ${hits}
      </svg></figure>`; }).join('')}</div>
    <p class="chart-note">Bars: fantasy points each game. Solid line: five-game average. Dashed line and shaded band: the rest-of-season projection and its typical miss.</p>`;
}

// What the trade does to each side's season, as signed bars around zero.
function impactChart(t) {
  const rows = [['You', t.delta, 'Change in your projected finish']];
  if (t.their.after != null) rows.push([`${t.partner.name}, in reality`, t.their.after - t.their.before, 'What this model says the trade does to them']);
  rows.push([`${t.partner ? t.partner.name : 'Other side'}, as they see it`, t.their.seen, 'Judged on recent box scores, expert ranks and draft position']);
  const max = Math.max(50, ...rows.map((r) => Math.abs(r[1])));
  return `<div class="impact">${rows.map(([label, v, tip]) => `<div class="irow" data-tip="${esc(tip)}"><span class="ilab">${esc(label)}</span>
    <span class="itrack"><i class="${v >= 0 ? 'pos' : 'neg'}" style="width:${(Math.abs(v) / max * 50).toFixed(1)}%;${v >= 0 ? 'left:50%' : `right:50%`}"></i></span>
    <span class="num ival">${v > 0 ? '+' : ''}${Math.round(v)}</span></div>`).join('')}</div>
    <p class="chart-note">${esc(t.unit[0].toUpperCase() + t.unit.slice(1))}. Bars to the right are gains, to the left losses.</p>`;
}

// Side-by-side numbers behind the argument (this is also the table view of the charts).
function profileTable(t) {
  const cols = [...t.give.map((id) => [byId.get(id), 'give']), ...t.get.map((id) => [byId.get(id), 'get'])];
  const rows = [
    ['Projected FP/G', (p) => `${fmt(p.model.fpg)} ±${fmt(p.model.sd)}`],
    ['Last five games', (p) => fmt(p.form?.last5)],
    ['Season so far', (p) => (p.s.season ? `${fmt(p.s.season.fp)} in ${p.s.season.gp} gp` : '–')],
    ['Usual range (20th to 80th percentile)', (p) => (p.form ? `${fmt(p.form.floor, 0)} to ${fmt(p.form.ceil, 0)}` : '–')],
    ['Expected minutes', (p) => fmt(p.model.min)],
    ['Started (last 10)', (p) => (p.form ? `${p.form.starts}%` : '–')],
    ['Expected games left', (p) => `${fmt(p.avail.games, 0)} (${Math.round(p.avail.durability * 100)}% durability)`],
    ['Games in next 14 days', (p) => t.g14[p.id] ?? '–'],
    ['Expert consensus rank', (p) => p.consensus?.rank ?? '–'],
    ['Model rank', (p) => p.model.rank],
    ['Market price (FP/G)', (p) => fmt(p.market.fpg)],
    ['Age', (p) => p.age ?? '–'],
  ];
  return `<div class="table-wrap"><table class="profile"><thead><tr><th class="l"></th>${cols.map(([p, side]) => `<th><i class="sw" style="background:${SIDE[side]}"></i>${esc(p.name)}</th>`).join('')}</tr></thead>
    <tbody>${rows.map(([label, f]) => `<tr><td class="l">${label}</td>${cols.map(([p]) => `<td>${esc(f(p))}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;
}

// ---------- trades ----------
function sigList(type) {
  const list = S.players.filter((p) => p.signal?.type === type).sort((a, b) => b.signal.score - a.signal.score).slice(0, 12);
  if (!list.length) return '<div class="empty">Nothing stands out today.</div>';
  return list.map((p) => `<div class="sig" data-player="${p.id}">
    <div class="row"><span><b>${esc(p.name)}</b> <span class="muted">${esc(p.team)} · ${esc(p.pos)}</span> ${ownChip(p.own)}</span>
      <span class="num muted" title="Signal strength">${fmt(p.model.fpg)} proj · ${fmt(p.market.recent)} recent<span class="meter ${type}"><i style="width:${Math.min(100, p.signal.score * 11)}%"></i></span></span></div>
    <ul>${p.signal.reasons.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>
    <button class="btn small" data-mock="${p.id}" style="margin-top:8px">Mock offers</button></div>`).join('');
}

const tradeKey = (t) => `${t.give.join('.')}>${t.get.join('.')}`;
function offerCard(t, { open = false, editable = true } = {}) {
  const key = tradeKey(t);
  const st = ui.trade.open[key] || (open ? { why: true, charts: false } : {});
  const side = (ids, s) => ids.map((id) => { const p = byId.get(id); const inj = INJ[p.injuryStatus];
    return `<div class="tp"><i class="sw" style="background:${SIDE[s]}"></i><div>${plink(p)}${inj ? ` <span class="chip ${inj[1]}">${inj[0]}</span>` : ''}<div class="muted num">${fmt(p.model.fpg)} proj · ${fmt(p.form?.last5)} last 5 · ${fmt(p.model.min, 0)} min</div></div></div>`; }).join('');
  const lean = { for: ['For', 'good'], against: ['Against', 'bad'], even: ['Note', 'plain'] };
  return `<article class="offer" data-offer="${key}">
    <div class="offer-top">
      <div class="sides"><div><div class="lbl">You give</div>${side(t.give, 'give')}</div><div class="arrow" aria-hidden="true"><svg viewBox="0 0 16 16" width="14" height="14"><path d="M3 8h10M9 4l4 4-4 4" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg></div>
        <div><div class="lbl">You get${t.partner ? ` from ${esc(t.partner.name)}` : ''}</div>${side(t.get, 'get')}</div></div>
      <div class="score"><b class="num ${t.delta >= 25 ? 'up' : t.delta <= -25 ? 'down' : ''}">${t.delta > 0 ? '+' : ''}${t.delta}</b><span>${esc(t.unit)}</span></div>
    </div>
    <div class="foot"><span class="chip ${t.verdict.tone || 'plain'}">${esc(t.verdict.head)}</span><span class="chip plain">${esc(t.kind)}</span>
      <span class="chip ${t.accept.label === 'Likely' ? 'info' : t.accept.label === 'Possible' ? 'plain' : 'warn'}" title="How the other manager is likely to react, judged on recent box scores, expert ranks and draft position">Acceptance: ${t.accept.label.toLowerCase()}</span>
      <span class="chip plain" title="The size of the edge compared with the model's typical miss on these players">Confidence: ${t.confidence.toLowerCase()}</span></div>
    <p class="argument">${esc(t.summary)}</p>
    <div class="offer-actions"><button class="btn small" data-toggle="why" aria-expanded="${!!st.why}">${st.why ? 'Hide' : 'Show'} full reasoning</button>
      <button class="btn small" data-toggle="charts" aria-expanded="${!!st.charts}">${st.charts ? 'Hide' : 'Show'} graphs</button>
      ${editable ? `<button class="btn small primary" data-edit="${key}">Edit in builder</button>` : ''}</div>
    ${st.why ? `<ul class="factors">${t.factors.map((f) => `<li><span class="chip ${lean[f.lean][1]}">${lean[f.lean][0]}</span><span><b>${esc(f.label)}.</b> ${esc(f.text)}</span></li>`).join('')}</ul>` : ''}
    ${st.charts ? `<div class="charts"><h3>Season impact</h3>${impactChart(t)}<h3>Form</h3>${formChart([...t.give.map((id) => ({ p: byId.get(id), side: 'give' })), ...t.get.map((id) => ({ p: byId.get(id), side: 'get' }))])}<h3>Side by side</h3>${profileTable(t)}</div>` : ''}
  </article>`;
}

async function loadOffers() {
  const tr = ui.trade;
  const qs = new URLSearchParams();
  if (tr.player) qs.set('player', tr.player);
  if (tr.team && !tr.player) qs.set('team', tr.team);
  const token = (tr.token = (tr.token || 0) + 1);
  tr.loading = true;
  try { const res = await api(`/api/trade/offers?${qs}`); if (token === tr.token) tr.res = res; }
  catch (e) { if (token === tr.token) tr.res = { offers: [], note: e.message }; }
  if (token === tr.token) { tr.loading = false; if ((location.hash || '') === '#trades') renderFinder(); }
}

async function evalCustom() {
  const token = (ui.trade.evalToken = (ui.trade.evalToken || 0) + 1);
  if (!ui.give.length || !ui.get.length) { ui.trade.custom = null; ui.trade.evaluating = false; return renderAnalyzer(); }
  let t = null;
  try { t = (await api('/api/trade/evaluate', { give: ui.give, get: ui.get })).trade; } catch { t = null; }
  if (token !== ui.trade.evalToken) return; // a newer edit is already on its way
  ui.trade.custom = t; ui.trade.evaluating = false;
  renderAnalyzer();
}

function renderTrades(app) {
  const tr = ui.trade;
  const mode = tr.mode || 'offers';
  app.innerHTML = `
    <div class="page-head"><div><h1>Trade tool</h1>
      <p>${mode === 'build' ? 'Click players on either side. The verdict updates as you go.' : 'Offers drafted from your roster, judged by what they do to your final total and how the other side will see them.'}</p></div>
      <div class="seg" id="tmode" role="tablist" aria-label="Trade tool mode">${[['offers', 'Mock offers'], ['build', 'Build an offer']].map(([k, l]) => `<button role="tab" aria-selected="${mode === k}" data-v="${k}" class="${mode === k ? 'on' : ''}">${l}</button>`).join('')}</div></div>
    <div class="stack">
      ${mode === 'build'
        ? '<div class="panel"><header><h2>Build an offer</h2><p>Click players to add or remove them</p></header><div class="body" id="analyzer"></div></div>'
        : `<div class="panel"><header><h2>Mock offers</h2><p>${S.league ? esc(S.league.name) : 'No league synced'}</p></header><div class="body" id="finder"></div></div>`}
      <div class="grid2">
        <div class="panel"><header><h2>Buy low</h2><p>Projection above recent production</p></header>${sigList('buy')}</div>
        <div class="panel"><header><h2>Sell high</h2><p>Recent production above projection</p></header>${sigList('sell')}</div>
      </div>
    </div>`;
  $('#tmode').onclick = (e) => {
    const v = e.target.closest('[data-v]')?.dataset.v;
    if (v && v !== mode) { tr.mode = v; renderTrades(app); }
  };
  if (mode === 'build') { renderAnalyzer(); if (ui.give.length && ui.get.length && !tr.custom) evalCustom(); }
  else { renderFinder(); if (!tr.res && !tr.loading) loadOffers(); }
}

// Open the builder with a trade loaded (from an offer card, the drawer, or a fresh start).
function openBuilder({ give = ui.give, get = ui.get, partner = undefined } = {}) {
  ui.give = [...give]; ui.get = [...get];
  ui.trade.partner = partner !== undefined ? partner : partnerOf(ui.get[0]);
  ui.trade.custom = null;
  ui.trade.mode = 'build';
  if (location.hash !== '#trades') location.hash = '#trades';
  else { renderTrades($('#app')); window.scrollTo({ top: 0, behavior: 'smooth' }); }
}

const otherTeams = () => (S.league?.teams || []).filter((t) => t.id !== S.myTeam?.id);
function partnerOf(id) {
  const o = id != null ? byId.get(id)?.own : null;
  return o?.type === 'team' ? otherTeams().find((t) => t.name === o.team)?.id ?? null : null;
}

function renderFinder() {
  const el = $('#finder');
  if (!el) return;
  const tr = ui.trade;
  const subject = tr.player ? byId.get(tr.player) : null;
  const teams = S.league?.teams || [];
  const team = teams.find((t) => t.id === tr.team);
  const roster = team ? team.roster.map((id) => byId.get(id)).filter(Boolean).sort((a, b) => b.model.fpg - a.model.fpg) : [];
  const res = tr.res;
  const heading = subject ? (res?.mode === 'shop' ? `What ${subject.name} could fetch` : `Offers to get ${subject.name}`)
    : team ? (team.id === S.myTeam?.id ? 'Pick one of your players to shop' : `Best offers with ${team.name}`) : 'Best offers across the league';
  const fallback = res && !res.offers.length && !subject && S.trades.length ? S.trades : null;
  el.innerHTML = `
    <div class="finder">
      <div class="field"><label for="tq">Any NBA player</label><input id="tq" list="player-names" placeholder="Search a player to target or shop" value="${esc(subject?.name || '')}" autocomplete="off"></div>
      ${teams.length ? `<div class="field"><label for="tteam">Or browse a roster</label><select id="tteam"><option value="">All teams</option>${teams.map((t) => `<option value="${t.id}" ${tr.team === t.id ? 'selected' : ''}>${esc(t.name)}${t.id === S.myTeam?.id ? ' (you)' : ''}</option>`).join('')}</select></div>` : ''}
      ${subject || team ? '<button class="btn small" id="tclear">Clear</button>' : ''}
    </div>
    ${roster.length ? `<div class="roster-pick" role="group" aria-label="${esc(team.name)} roster">${roster.map((p) => `<button class="pchip ${tr.player === p.id ? 'on' : ''}" data-pick="${p.id}">${esc(p.name)} <span class="num">${fmt(p.model.fpg)}</span></button>`).join('')}</div>` : ''}
    <h3 class="finder-head">${esc(heading)}${subject ? ` <span class="muted">${esc(subject.team)} · ${esc(subject.pos)} · ${fmt(subject.model.fpg)} proj FP/G · model rank ${subject.model.rank}</span>` : ''}</h3>
    ${tr.loading && !res ? `<div class="offers" aria-busy="true" aria-label="Drafting offers">${[0, 1, 2].map(() => `<div class="offer"><div class="sk-row"><div>${skLines(2, [55, 70])}</div><div>${skLines(2, [62, 48])}</div></div><div style="margin-top:18px">${skLines(3)}</div></div>`).join('')}</div>` : ''}
    ${res?.note ? `<div class="callout"><span>${esc(res.note)}</span></div>` : ''}
    ${res ? `<div class="offers">${(fallback || res.offers).map((t) => offerCard(t)).join('')}</div>` : ''}
    ${res && !res.offers.length && !res.note && !fallback ? `<div class="empty">${team && team.id === S.myTeam?.id && !subject ? 'Choose a player above to see what he could bring back.' : 'No workable offer found.'}</div>` : ''}`;
  const pick = (id, teamId = tr.team) => { tr.player = id; tr.team = teamId; tr.res = null; renderFinder(); if (!(teamId === S.myTeam?.id && !id) || !teamId) loadOffers(); else { tr.res = { offers: [] }; renderFinder(); } };
  $('#tq').onchange = (e) => { const p = S.players.find((x) => x.name.toLowerCase() === e.target.value.trim().toLowerCase()); if (p) pick(p.id, null); };
  if ($('#tteam')) $('#tteam').onchange = (e) => pick(null, e.target.value ? +e.target.value : null);
  if ($('#tclear')) $('#tclear').onclick = () => pick(null, null);
  el.onclick = (e) => {
    const chip = e.target.closest('[data-pick]');
    if (chip) return pick(+chip.dataset.pick);
    offerClick(e, [...(fallback || res?.offers || [])], renderFinder);
  };
}

// Shared by every list of offer cards: expand reasoning or graphs, or load into the builder.
function offerClick(e, offers, rerender) {
  const card = e.target.closest('[data-offer]');
  if (!card) return;
  const key = card.dataset.offer;
  const tog = e.target.closest('[data-toggle]');
  if (tog) { const st = (ui.trade.open[key] ||= card.dataset.open ? { why: true } : {}); st[tog.dataset.toggle] = !st[tog.dataset.toggle]; rerender(); return; }
  if (e.target.closest('[data-edit]')) {
    const t = offers.find((o) => tradeKey(o) === key);
    if (t) openBuilder({ give: t.give, get: t.get, partner: t.partner?.id ?? null });
  }
}

function renderAnalyzer() {
  const el = $('#analyzer');
  if (!el) return;
  const tr = ui.trade;
  const teams = otherTeams();
  const partner = teams.find((t) => t.id === tr.partner) || null;
  const byFpg = (a, b) => b.model.fpg - a.model.fpg;
  const mine = S.players.filter((p) => p.own?.type === 'mine').sort(byFpg);
  const theirs = partner ? partner.roster.map((id) => byId.get(id)).filter(Boolean).sort(byFpg) : [];
  const chip = (p, key) => {
    const on = ui[key].includes(p.id), inj = INJ[p.injuryStatus];
    return `<button type="button" class="pchip ${on ? 'on' : ''}" data-pick-side="${key}:${p.id}" aria-pressed="${on}">${esc(p.name)} <span class="num">${fmt(p.model.fpg)}</span>${inj ? ` <span class="chip ${inj[1]}">${inj[0]}</span>` : ''}</button>`;
  };
  // players picked that are not in the roster lists (added by search, e.g. with no league synced)
  const extra = (key, list) => ui[key].filter((id) => !list.some((p) => p.id === id)).map((id) => byId.get(id)).filter(Boolean);
  const side = (key, title, list, controls) => `<div class="side">
      <div class="side-head"><div class="lbl">${title}${ui[key].length ? ` <span class="num muted">${ui[key].length} · ${fmt(ui[key].reduce((a, id) => a + byId.get(id).model.fpg, 0))} FP/G</span>` : ''}</div>${controls || ''}</div>
      <div class="roster-pick">${[...extra(key, list), ...list].map((p) => chip(p, key)).join('') || `<span class="muted">${key === 'get' && teams.length ? 'Choose a team to see its roster.' : 'No players.'}</span>`}</div>
      <input list="player-names" data-add="${key}" placeholder="${key === 'get' ? 'Or search any player…' : 'Search a player…'}" aria-label="${title}: add a player by name">
    </div>`;
  const teamSelect = teams.length ? `<select id="bteam" aria-label="Team to trade with"><option value="">Choose a team…</option>${teams.map((t) => `<option value="${t.id}" ${tr.partner === t.id ? 'selected' : ''}>${esc(t.name)}</option>`).join('')}</select>` : '';
  const t = tr.custom;
  if (t) tr.open[tradeKey(t)] ||= { why: true, charts: false };
  const result = !ui.give.length || !ui.get.length
    ? `<p class="muted builder-hint">${!ui.give.length && !ui.get.length ? 'Pick at least one player on each side to see the verdict.' : !ui.give.length ? 'Now pick what you give.' : 'Now pick what you get.'}</p>`
    : t ? `<div class="offers ${tr.evaluating ? 'stale' : ''}">${offerCard(t, { editable: false })}</div>`
    : `<div class="offer" aria-busy="true"><div>${skLines(2, [60, 44])}</div><div style="margin-top:16px">${skLines(3)}</div></div>`;
  el.innerHTML = `
    <div class="analyzer">${side('give', 'You give', mine)}${side('get', partner ? `You get from ${esc(partner.name)}` : 'You get', theirs, teamSelect)}</div>
    <div class="builder-bar">${ui.give.length || ui.get.length ? '<button type="button" class="btn small" id="bclear">Clear</button>' : ''}${ui.give.length && ui.get.length ? '<button type="button" class="btn small" id="bswap" title="See the same deal from the other side">Flip sides</button>' : ''}</div>
    <div id="bresult">${result}</div>`;

  const changed = () => { tr.evaluating = true; renderAnalyzer(); evalCustom(); };
  if ($('#bteam')) $('#bteam').onchange = (e) => {
    tr.partner = e.target.value ? +e.target.value : null;
    ui.get = ui.get.filter((id) => partnerOf(id) === tr.partner); // a trade is with one team
    changed();
  };
  for (const input of el.querySelectorAll('[data-add]')) {
    input.onchange = () => {
      const p = S.players.find((x) => x.name.toLowerCase() === input.value.trim().toLowerCase());
      if (!p) return;
      const key = input.dataset.add, o = p.own?.type;
      if (key === 'give' && S.league && o !== 'mine') { input.value = ''; input.placeholder = `${p.name} is not on your roster`; return; }
      if (key === 'get' && o === 'mine') { input.value = ''; input.placeholder = `${p.name} is already yours`; return; }
      if (key === 'get' && o === 'fa') { input.value = ''; input.placeholder = `${p.name} is a free agent: add him on Waivers`; return; }
      if (key === 'get') {
        const team = partnerOf(p.id);
        if (team != null && team !== tr.partner) { tr.partner = team; ui.get = ui.get.filter((id) => partnerOf(id) === team); }
      }
      if (!ui.give.includes(p.id) && !ui.get.includes(p.id) && ui[key].length < 5) ui[key].push(p.id);
      changed();
    };
  }
  if ($('#bclear')) $('#bclear').onclick = () => { ui.give = []; ui.get = []; tr.custom = null; renderAnalyzer(); };
  if ($('#bswap')) $('#bswap').onclick = () => {
    // what would I accept if they offered this? shown as the reverse deal
    [ui.give, ui.get] = [ui.get, ui.give];
    tr.partner = partnerOf(ui.get[0]);
    changed();
  };
  el.onclick = (e) => {
    const pick = e.target.closest('[data-pick-side]');
    if (pick) {
      const [key, id] = pick.dataset.pickSide.split(':');
      const n = +id;
      if (ui[key].includes(n)) ui[key] = ui[key].filter((x) => x !== n);
      else if (ui[key].length < 5) ui[key].push(n);
      return changed();
    }
    offerClick(e, t ? [t] : [], renderAnalyzer);
  };
}

// one tooltip for every chart mark
const tip = document.createElement('div');
tip.id = 'tip'; tip.hidden = true; document.body.append(tip);
document.addEventListener('pointermove', (e) => {
  const el = e.target.closest?.('[data-tip]');
  if (!el) { tip.hidden = true; return; }
  tip.textContent = el.dataset.tip; tip.hidden = false;
  const w = tip.offsetWidth;
  tip.style.left = `${Math.max(8, Math.min(window.innerWidth - w - 8, e.clientX - w / 2))}px`;
  tip.style.top = `${e.clientY - tip.offsetHeight - 12 < 4 ? e.clientY + 16 : e.clientY - tip.offsetHeight - 12}px`;
});

// ---------- this week ----------
function renderWeek(app) {
  const w = S.week;
  if (!w) {
    app.innerHTML = `<div class="page-head"><div><h1>This week</h1></div></div><div class="callout"><span>The weekly plan needs your league's schedule, standings and lineup slots. Sync your ESPN league first.</span><a class="btn primary" href="#settings">Sync league</a></div>`;
    return;
  }
  const my = w.my;
  const dayName = (d) => new Date(`${d}T12:00:00Z`).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' });
  const leader = w.teams[0];
  const weekBlock = (wk, title) => {
    const days = my.days.filter((d) => d.week === wk);
    if (!days.length) return '';
    const total = days.reduce((a, d) => a + d.total, 0);
    return `<div class="panel"><header><h2>${title}</h2><p>Projected ${total} points from your best legal lineup each day</p></header><div class="table-wrap"><table class="plan">
      <thead><tr><th class="l" style="cursor:default">Player</th>${days.map((d) => `<th style="cursor:default">${esc(dayName(d.date))}</th>`).join('')}<th class="grp" style="cursor:default">Games</th><th style="cursor:default">Points</th></tr></thead>
      <tbody>${my.players.map((r) => { const p = byId.get(r.id); if (!p) return ''; return `<tr data-player="${p.id}"><td class="l">${playerCell(p)}</td>
        ${days.map((d) => { const g = d.games.find((x) => x.id === p.id); return `<td>${!g ? '<span class="muted">·</span>' : g.chance === 0 ? '<span class="chip inj bad">Out</span>' : g.start ? `<span class="${g.chance < 0.75 ? 'chip warn' : 'strong'}" title="${Math.round(g.chance * 100)}% chance to play">${fmt(g.exp)}</span>` : `<span class="chip plain" title="No lineup slot left for him this day">Bench</span>`}</td>`; }).join('')}
        <td class="grp">${r.games[wk]}</td><td class="strong">${fmt(r.pts[wk], 0)}</td></tr>`; }).join('')}
        <tr style="cursor:default"><td class="l strong">Day total</td>${days.map((d) => `<td class="strong">${d.total}</td>`).join('')}<td class="grp"></td><td class="strong">${total}</td></tr></tbody></table></div></div>`;
  };
  const intro = w.kind === 'h2h' ? 'Head-to-head points: each week you play one team. The matchup below adds the score so far to your best legal lineup for every remaining day, with injuries and return dates applied.'
    : w.kind === 'categories' ? `${w.formatLabel}. Pivot projects fantasy points, so this page uses ESPN's default points scoring as a stand-in for category value.`
    : w.capped ? `Your league is season-long total points with a games cap (${w.capTotal} starts per team), not head-to-head. You gain ground each week by getting more points out of every game you use, not by playing more games.`
    : 'Projected points for each team from today through next week, with injuries and return dates applied.';
  app.innerHTML = `
    <div class="page-head"><div><h1>This week</h1>
      <p>${esc(intro)} Days are US Eastern.</p></div></div>
    <div class="stack">
      ${matchupPanel(w)}
      ${my ? `<div class="panel"><header><h2>What to do</h2><p>${esc(my.name)}${my.capLine ? ` · cap line ${fmt(my.capLine)} FP/G` : ''}</p></header><div class="brief">${my.advice.length ? `<ol>${my.advice.map((a) => `<li>${esc(a)}</li>`).join('')}</ol>` : '<span class="muted">Nothing needs action.</span>'}</div></div>` : `<div class="callout"><span>Choose your team in Settings to get a plan for your roster.</span><a class="btn primary" href="#settings">Choose team</a></div>`}
      ${w.kind === 'h2h' || w.kind === 'categories' ? h2hStandings(w) : `
      <div class="panel"><header><h2>Standings outlook</h2><p>${w.seasonPct}% of the NBA season played</p></header><div class="table-wrap"><table>
        <thead><tr>${['#', 'Team', 'Points', 'Behind', ...(w.capped ? ['Games used', 'Pts / game', 'Pace'] : []), 'Rest of week', 'Next week', ...(w.capped ? ['Cap line', 'Projected final'] : [])].map((h, i) => `<th class="${i === 1 ? 'l' : ''}" style="cursor:default">${h}</th>`).join('')}</tr></thead>
        <tbody>${w.teams.map((t) => `<tr style="cursor:default"><td class="rank">${t.rank}</td><td class="l">${t.mine ? `<b>${esc(t.name)}</b> <span class="chip mine">You</span>` : esc(t.name)}</td>
          <td class="strong">${t.points}</td><td class="muted">${t.rank === 1 ? '–' : leader.points - t.points}</td>
          ${w.capped ? `<td>${t.gamesUsed}</td><td>${fmt(t.perGame)}</td><td class="${t.pace >= 5 ? 'down' : 'muted'}" title="Games used compared with an even pace through the season">${t.pace > 0 ? `${t.pace} ahead` : t.pace < 0 ? `${-t.pace} behind` : 'even'}</td>` : ''}
          <td>${t.week[0]}</td><td>${t.week[1]}</td>
          ${w.capped ? `<td>${fmt(t.capLine)}</td><td class="strong">${t.projected}</td>` : ''}</tr>`).join('')}</tbody></table></div>
        ${w.capped ? '<div class="body muted" style="font-size:12px;border-top:1px solid var(--line)">Cap line: the FP/G of the last game that fits under a team\'s cap if its best players\' games go first. Starting anyone below it gives up points. Projected final fills each team\'s remaining games with its current roster, and any shortfall at replacement level.</div>' : ''}
      </div>
      `}
      ${my ? `${weekBlock(0, 'Rest of this week')}${weekBlock(1, 'Next week')}
      ${my.slots.length ? `<div class="panel"><header><h2>Games used by slot</h2><p>Each slot has its own cap</p></header><div class="body slots">${my.slots.map((s) => `<div class="slot"><div class="row"><b>${esc(s.label)}</b><span class="num ${s.used - s.even >= 3 ? 'down' : 'muted'}">${s.used} / ${s.limit}${s.used - s.even >= 3 ? ` · ${s.used - s.even} ahead` : ''}</span></div>
        <div class="bar"><i style="width:${Math.min(100, (s.used / s.limit) * 100)}%"></i><u style="left:${Math.min(100, (s.even / s.limit) * 100)}%" title="Even pace"></u></div></div>`).join('')}</div></div>` : ''}` : ''}
    </div>`;
}

// ---------- waivers ----------
function renderWaivers(app) {
  const w = S.waivers;
  const pool = S.league ? `free agents in ${esc(S.league.name)}` : 'players rostered in under 60% of ESPN leagues';
  const move = (m) => {
    const add = byId.get(m.add), drop = byId.get(m.drop);
    const inj = (p) => (INJ[p.injuryStatus] ? ` <span class="chip inj ${INJ[p.injuryStatus][1]}">${INJ[p.injuryStatus][0]}</span>` : '');
    return `<div class="trade">
      <div class="sides"><div><div class="lbl">Add</div>${plink(add)}${inj(add)}<div class="muted num" style="font-size:12px">${fmt(add.model.fpg)} proj · ${fmt(add.s.l15?.fp)} L15</div></div><div class="arrow">for</div>
        <div><div class="lbl">Drop</div>${plink(drop)}${inj(drop)}<div class="muted num" style="font-size:12px">${fmt(drop.model.fpg)} proj · ${fmt(drop.s.l15?.fp)} L15</div></div></div>
      ${m.why.length ? `<ul>${m.why.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>` : ''}
      <div class="foot"><span class="chip good">+${m.gain} ROS points above replacement</span><span class="chip info">${signed(m.fpgDelta)} FP/G</span>${m.stash ? '<span class="chip warn">Stash: out for now</span>' : ''}</div></div>`;
  };
  app.innerHTML = `
    <div class="page-head"><div><h1>Waiver wire</h1><p>The best ${pool}, by this app's rest-of-season projection, matched against the weakest players on your roster.</p></div></div>
    <div class="stack">
      <div class="panel"><header><h2>Recommended moves</h2><p>Best available for your weakest roster spots</p></header>
        ${!S.hasRoster ? '<div class="body"><div class="callout"><span>Sync your ESPN league or add your players by hand to get add/drop recommendations.</span><a class="btn primary" href="#settings">Set up roster</a></div></div>'
          : w.moves.length ? `<div class="trades">${w.moves.map(move).join('')}</div>`
          : '<div class="empty">No add clears the bar today: nobody available projects meaningfully above your weakest player.</div>'}
      </div>
      <div class="grid2 wide-left">
        <div class="panel"><header><h2>Best available</h2><p>Sorted by rest-of-season value</p></header><div class="table-wrap"><table>
          <thead><tr><th class="l" style="cursor:default">Player</th><th style="cursor:default" title="Projected fantasy points per game, rest of season">Proj</th><th style="cursor:default" title="Expected per game over the next few games">Next</th><th style="cursor:default">L15</th><th style="cursor:default">Season</th><th style="cursor:default" title="Rostered in ESPN leagues, and change this week">Rost%</th></tr></thead>
          <tbody>${w.adds.map(({ id, why }) => { const p = byId.get(id); return `<tr data-player="${p.id}">
            <td class="l">${playerCell(p)}${why.length ? `<div class="muted" style="font-size:12px;white-space:normal;max-width:52ch;margin-top:2px">${esc(why[0])}</div>` : ''}</td>
            <td class="strong">${fmt(p.model.fpg)}</td><td>${fmt(p.model.next)}</td><td>${fmt(p.s.l15?.fp)}</td><td>${fmt(p.s.season?.fp)}</td>
            <td class="muted">${fmt(p.owned, 0)} ${p.ownedChange >= 1 ? `<span class="up">+${fmt(p.ownedChange, 0)}</span>` : p.ownedChange <= -1 ? `<span class="down">${fmt(p.ownedChange, 0)}</span>` : ''}</td></tr>`; }).join('') || '<tr><td colspan="6" class="empty">Nobody worth adding is available.</td></tr>'}</tbody></table></div></div>
        <div class="panel"><header><h2>Your weakest spots</h2><p>Lowest value first</p></header>
          ${w.drops.map((id) => { const p = byId.get(id); return `<div class="sig" data-player="${p.id}"><div class="row"><span><b>${esc(p.name)}</b> <span class="muted">${esc(p.team)} · ${esc(p.pos)}</span></span><span class="num muted">${fmt(p.model.fpg)} proj</span></div>
            <div class="muted" style="font-size:12px;margin-top:2px">${esc(p.avail.note || (p.signal ? `${p.signal.type === 'buy' ? 'Buy-low candidate' : 'Sell-high candidate'}: ${p.signal.reasons[0]}` : `${fmt(p.s.l15?.fp)} FP/G over the last 15 days`))}</div></div>`; }).join('') || '<div class="empty">No roster set.</div>'}
        </div>
      </div>
    </div>`;
}

// ---------- news ----------
function renderNews(app) {
  const f = ui.news.filter;
  const filters = [['league', 'Affects my league'], ['mine', 'My team'], ['injury', 'Injuries'], ['role', 'Role changes'], ['all', 'Everything']];
  const INJURY = ['out', 'extended', 'season_ending', 'questionable', 'returning'];
  const ROLE = ['starting', 'bench', 'minutes_limit', 'transaction'];
  let items = S.news.filter((n) => f === 'all' || (f === 'league' && n.relevance >= 1 && n.tag !== 'note') || (f === 'mine' && n.own?.type === 'mine')
    || (f === 'injury' && INJURY.includes(n.tag)) || (f === 'role' && ROLE.includes(n.tag)));
  if (f === 'all') items = [...items].sort((a, b) => b.time - a.time);
  const b = S.briefing;
  app.innerHTML = `
    <div class="page-head"><div><h1>Daily news</h1><p>The last three days of player news, sorted by how much it matters to ${S.myTeam ? esc(S.myTeam.name) : 'your team'}, with what to do about each item.</p></div>
      <div class="seg" id="nf">${filters.map(([k, l]) => `<button data-v="${k}" class="${f === k ? 'on' : ''}">${l}</button>`).join('')}</div></div>
    <div class="news-layout">
      <div class="stack">
        <div class="panel"><header><h2>Today's briefing</h2><p>${b.by === 'claude' ? `Written by ${esc(b.model)}` : 'Rule-based. Connect a model in Settings for a written briefing.'}</p></header>
          <div class="brief">${b.lines.length ? `<ol>${b.lines.map((l) => `<li>${esc(l)}</li>`).join('')}</ol>` : `<span class="muted">${S.hasRoster ? 'Nothing in the last three days needs action from you.' : 'Set up your roster in Settings to get takeaways specific to your team.'}</span>`}</div></div>
        <div class="news-list">${items.slice(0, 120).map((n) => `<article class="card ${n.own?.type === 'mine' ? 'mine' : ''}">
          <div class="head"><span class="chip ${n.tone}">${esc(n.label)}</span>${n.name ? `<span class="pl" data-player="${n.playerId}">${esc(n.name)} <small>${esc(n.team)} ${esc(n.pos)}</small></span>` : ''}${ownChip(n.own)}
            <span class="time" title="${esc(new Date(n.time).toLocaleString())}">${timeAgo(n.time)} · ${esc(n.source)}</span></div>
          ${n.headline ? `<p class="txt">${esc(n.headline)}</p>` : ''}
          ${n.text ? `<p class="more">${esc(n.text)}</p>` : ''}
          ${n.ai || n.lines.length ? `<div class="out"><div class="lbl">For your league</div><ul>${n.ai ? `<li>${esc(n.ai)}</li>` : n.lines.map((l) => `<li>${esc(l)}</li>`).join('')}</ul></div>` : ''}
        </article>`).join('') || '<div class="panel"><div class="empty">No news in this view. Try "Everything".</div></div>'}</div>
      </div>
      <div class="panel"><header><h2>League headlines</h2><p>ESPN</p></header>
        ${S.headlines.map((h) => `<a class="headline" href="${esc(/^https:\/\//.test(h.url) ? h.url : '#')}" target="_blank" rel="noopener noreferrer">${esc(h.headline)}<div class="muted" style="font-size:12px">${timeAgo(h.time)}</div></a>`).join('') || `<div class="empty">${DEMO ? 'Headlines are left out of the public demo.' : 'No headlines.'}</div>`}</div>
    </div>`;
  $('#nf').onclick = (e) => { if (e.target.dataset.v) { ui.news.filter = e.target.dataset.v; renderNews(app); } };
}

// ---------- settings ----------
function renderAbout(app) {
  const m = S.meta;
  app.innerHTML = `
    <div class="page-head"><div><h1>About</h1>
      <p>Pivot is a decision tool for an ESPN fantasy basketball points league. This demo is a frozen copy of one real league, taken ${esc(new Date(m.refreshedAt).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' }))}.</p></div></div>
    <div class="grid2">
      <div class="stack">${m.backtest ? accuracyPanel(m.backtest, m.live) : ''}</div>
      <div class="stack">
        <div class="panel"><header><h2>What's in the demo</h2></header><div class="body about">
          <p>Everything you see is computed from real data: player stats, schedules, injuries and the league's actual standings and rosters. The trade tool runs its engine in your browser, so mock offers and the builder work exactly as they do in the app.</p>
          <p>Some things are left out of the public copy:</p>
          <ul>
            <li>Team and owner names, replaced with made-up ones.</li>
            <li>News headlines, article text and injury-report wording, which belong to their publishers. Pivot's own read of each item is kept.</li>
            <li>Individual ranking sites' lists. Only ESPN's projection and the combined consensus are shown.</li>
          </ul>
          <p><a href="${REPO_URL}" target="_blank" rel="noopener noreferrer">Source code, method and evaluation on GitHub</a></p>
        </div></div>
        <div class="panel"><header><h2>Sources in the full app</h2><p>Status on the snapshot day</p></header>
          ${m.status.map((st) => `<div class="src-row"><span><span class="dot ${st.ok ? '' : 'off'}"></span>${esc(st.label)}</span><span class="muted">${esc(st.detail)}</span></div>`).join('')}
        </div>
      </div>
    </div>`;
}

function renderSettings(app) {
  if (DEMO) return renderAbout(app);
  const s = S.settings;
  const scoreStats = [0, 6, 3, 2, 1, 11, 17, 13, 14, 15, 16, 4, 5, 23, 24, 37, 38, 9];
  const scoring = S.ready ? S.meta.scoring : s.scoring;
  const roster = (s.manualRoster || []).map((id) => byId.get(id)).filter(Boolean);
  app.innerHTML = `
    <div class="page-head"><div><h1>Settings</h1><p>Everything is stored on this computer in <code>~/fantasy-hoops/data</code>. Cookies and keys are never sent anywhere except ESPN and Anthropic respectively.</p></div></div>
    <div class="grid2">
      <div class="stack">
        <div class="panel"><header><h2>ESPN league</h2><p>${S.league ? `Synced: ${esc(S.league.name)} (${S.league.teams.length} teams)` : 'Not synced'}</p></header><div class="body"><form class="form" id="f-league">
          <div class="field"><label for="leagueId">League ID or league URL</label><input id="leagueId" value="${esc(s.leagueId)}" placeholder="e.g. 12345678" autocomplete="off">
            <span class="hint">Open your league on fantasy.espn.com; the number after <code>leagueId=</code> in the address bar.</span></div>
          <div class="field"><label for="season">Season (the year it ends)</label><input id="season" type="number" value="${esc(s.season)}" style="width:120px"></div>
          ${S.league ? `<div class="field"><label for="teamId">My team</label><select id="teamId"><option value="">Choose…</option>${S.league.teams.map((t) => `<option value="${t.id}" ${S.myTeam?.id === t.id ? 'selected' : ''}>${esc(t.name)}${t.owner ? ` (${esc(t.owner)})` : ''}</option>`).join('')}</select></div>` : ''}
          <div class="field"><label>Private league cookies ${s.hasEspnCookies ? '<span class="chip good">Saved</span>' : ''}</label>
            <input id="espnS2" type="password" placeholder="${s.hasEspnCookies ? 'espn_s2 saved (leave blank to keep)' : 'espn_s2'}" autocomplete="off">
            <input id="swid" type="password" placeholder="${s.hasEspnCookies ? 'SWID saved (leave blank to keep)' : 'SWID, including the {braces}'}" autocomplete="off">
            <span class="hint">Only needed if the league is not public. While logged in to espn.com: browser dev tools → Application → Cookies → espn.com, copy <code>espn_s2</code> and <code>SWID</code>.${s.hasEspnCookies ? ' <button type="button" class="btn link" id="clear-espn">Remove saved cookies</button>' : ''}</span></div>
          <div><button class="btn primary">Save and sync</button></div>
        </form></div></div>

        <div class="panel"><header><h2>My roster (manual)</h2><p>${S.league ? 'Ignored while a league is synced' : 'Used when no league is synced'}</p></header><div class="body">
          <div class="roster-chips">${roster.map((p) => `<span class="chip mine">${esc(p.name)}<button data-drop="${p.id}" aria-label="Remove ${esc(p.name)}">×</button></span>`).join('') || '<span class="muted">No players added.</span>'}</div>
          <input list="player-names" id="add-roster" placeholder="Add player…" style="margin-top:10px;width:260px" ${S.ready ? '' : 'disabled'}>
        </div></div>

        <div class="panel"><header><h2>Written briefing (optional)</h2><p>${s.aiReady ? 'Enabled' : 'Off: news outcomes use built-in rules'}</p></header><div class="body">
          <div class="field" style="margin-bottom:14px"><label for="aiProvider">Provider</label><select id="aiProvider" style="width:260px"><option value="anthropic" ${s.aiProvider !== 'compatible' ? 'selected' : ''}>Anthropic (Claude)</option><option value="compatible" ${s.aiProvider === 'compatible' ? 'selected' : ''}>Other (OpenAI-compatible API)</option></select></div>
          <form class="form" id="f-alt" ${s.aiProvider === 'compatible' ? '' : 'hidden'}>
          <div class="field"><label for="altBaseUrl">API address</label><input id="altBaseUrl" value="${esc(s.altBaseUrl)}" placeholder="https://…/v1" autocomplete="off">
            <span class="hint">The provider's OpenAI-compatible base address, the part before <code>/chat/completions</code>. A model running on this computer works too, for example <code>http://localhost:11434/v1</code> for Ollama.</span></div>
          <div class="field"><label for="altModel">Model name</label><input id="altModel" value="${esc(s.altModel)}" placeholder="Exactly as the provider lists it" autocomplete="off"></div>
          <div class="field"><label for="altKey">API key ${s.hasAltKey ? '<span class="chip good">Saved</span>' : ''}</label>
            <input id="altKey" type="password" placeholder="${s.hasAltKey ? 'Key saved (leave blank to keep)' : 'Not needed for a local model'}" autocomplete="off">
            <span class="hint">Stored only on this computer and sent only to the address above, along with your roster and the day's news.${s.hasAltKey ? ' <button type="button" class="btn link" id="clear-alt">Remove key</button>' : ''}</span></div>
          <div><button class="btn primary">Save</button></div>
          </form>
          <form class="form" id="f-ai" ${s.aiProvider === 'compatible' ? 'hidden' : ''}>
          <div class="field"><label for="anthropicKey">Anthropic API key ${s.hasAnthropicKey ? '<span class="chip good">Saved</span>' : ''}</label>
            <input id="anthropicKey" type="password" placeholder="${s.hasAnthropicKey ? 'Key saved (leave blank to keep)' : 'sk-ant-…'}" autocomplete="off">
            <span class="hint">With a key, each daily update asks Claude to write the briefing and a one-line outcome per news item for your team. One request per update.${s.hasAnthropicKey ? ' <button type="button" class="btn link" id="clear-ai">Remove key</button>' : ''}</span></div>
          <div class="field"><label for="aiModel">Model</label><select id="aiModel" style="width:220px">${['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5', 'claude-fable-5-2'].map((m) => `<option ${s.aiModel === m ? 'selected' : ''}>${m}</option>`).join('')}</select></div>
          <div><button class="btn primary">Save</button></div>
        </form></div></div>
      </div>

      <div class="stack">
        <div class="panel"><header><h2>Scoring</h2><p>${s.scoringSource === 'league' ? 'Imported from your league' : s.scoringSource === 'custom' ? 'Custom' : 'ESPN default points scoring'}</p></header><div class="body"><form id="f-scoring">
          <div class="scoring">${scoreStats.map((id) => `<label>${esc(S.statLabels[id])}<input type="number" step="0.25" data-stat="${id}" value="${scoring[id] ?? 0}"></label>`).join('')}</div>
          <div style="margin-top:12px;display:flex;gap:8px"><button class="btn primary">Save scoring</button><button type="button" class="btn" id="reset-scoring">Reset to ${S.league ? 'league' : 'ESPN default'}</button></div>
        </form></div></div>

${S.meta?.backtest ? accuracyPanel(S.meta.backtest, S.meta.live) : ''}
        <div class="panel"><header><h2>Daily update</h2><p>${S.ready ? `Last run ${esc(new Date(S.meta.refreshedAt).toLocaleString())}` : 'Never run'}</p></header>
          <div class="body"><form class="form" id="f-hour"><div class="field"><label for="refreshHour">Update once a day after this hour (0 to 23)</label>
            <div style="display:flex;gap:8px"><input id="refreshHour" type="number" min="0" max="23" value="${esc(s.refreshHour)}" style="width:90px"><button class="btn">Save</button></div>
            <span class="hint">Runs while the app is running. For updates when it is closed, schedule <code>npm run refresh</code>.</span></div></form></div>
          ${S.ready ? S.meta.status.map((st) => `<div class="src-row"><span><span class="dot ${st.ok ? '' : 'off'}"></span>${esc(st.label)}</span><span class="muted">${esc(st.detail)}</span></div>`).join('') : ''}
        </div>
      </div>
    </div>`;

  const save = async (body) => {
    try { await api('/api/settings', body); await load(); } catch (e) { alert(e.message); }
  };
  $('#f-league').onsubmit = (e) => {
    e.preventDefault();
    save({ leagueId: $('#leagueId').value, season: $('#season').value, espnS2: $('#espnS2').value, swid: $('#swid').value, ...($('#teamId') ? { teamId: $('#teamId').value } : {}) });
  };
  $('#f-ai').onsubmit = (e) => { e.preventDefault(); save({ anthropicKey: $('#anthropicKey').value, aiModel: $('#aiModel').value }); };
  $('#aiProvider').onchange = (e) => save({ aiProvider: e.target.value });
  $('#f-alt').onsubmit = (e) => { e.preventDefault(); save({ aiProvider: 'compatible', altBaseUrl: $('#altBaseUrl').value, altModel: $('#altModel').value, altKey: $('#altKey').value }); };
  if ($('#clear-alt')) $('#clear-alt').onclick = () => save({ clear: ['altKey'] });
  $('#f-hour').onsubmit = (e) => { e.preventDefault(); save({ refreshHour: $('#refreshHour').value }); };
  $('#f-scoring').onsubmit = (e) => {
    e.preventDefault();
    const out = { ...scoring };
    for (const i of document.querySelectorAll('[data-stat]')) out[i.dataset.stat] = Number(i.value) || 0;
    save({ scoring: out });
  };
  $('#reset-scoring').onclick = () => save({ resetScoring: true });
  if ($('#clear-espn')) $('#clear-espn').onclick = () => save({ clear: ['espnS2', 'swid'] });
  if ($('#clear-ai')) $('#clear-ai').onclick = () => save({ clear: ['anthropicKey'] });
  $('#add-roster').onchange = (e) => {
    const p = S.players.find((x) => x.name.toLowerCase() === e.target.value.trim().toLowerCase());
    if (p) save({ manualRoster: [...(s.manualRoster || []), p.id] });
  };
  $('.roster-chips').onclick = (e) => {
    const id = e.target.dataset.drop;
    if (id) save({ manualRoster: s.manualRoster.filter((x) => x !== +id) });
  };
}

// How the projection model did on past seasons it was not tuned on, and how it is doing live.
function accuracyPanel(bt, live) {
  const ci = (x) => `<span class="ci">${x.lo.toFixed(2)} to ${x.hi.toFixed(2)}</span>`;
  const signedD = (d) => `${d.diff >= 0 ? '+' : '−'}${Math.abs(d.diff).toFixed(2)}`;
  const folds = bt.folds || [];
  const pooled = bt.pooled;
  const max = pooled ? Math.max(...bt.baselines.map((k) => pooled.mae[k].hi)) : 1;
  const liveBlock = DEMO ? '<p>The full app saves every daily projection and scores it once the players have had a week of games, next to their season average on the same day. Logging began on the day this snapshot was taken, so the demo has no live results yet.</p>' : !live ? '' : live.overall
    ? `<p>Projections saved by each daily update are compared with what the player has averaged since. Across ${live.scored.length} scored day${live.scored.length === 1 ? '' : 's'} (${live.overall.n.toLocaleString('en-US')} player projections), Pivot has missed by <b class="num">${live.overall.model.toFixed(2)}</b> FP/G against <b class="num">${live.overall.seasonAvg.toFixed(2)}</b> for the season average on the same days.</p>`
    : `<p>Each daily update now saves its projections. ${live.snapshots ? `${live.snapshots} saved so far; the first ${live.nextScoredOn != null ? `can be scored in ${Math.max(1, live.nextScoredOn)} day${live.nextScoredOn === 1 ? '' : 's'}` : 'is waiting for games'}` : 'None saved yet'}, once the players have had a week of games.</p>`;
  return `<div class="panel"><header><h2>Projection accuracy</h2><p>Tested on seasons it never saw</p></header><div class="body acc-body">
    <p class="muted">Each test season is scored by a version of the model tuned only on earlier seasons. Figures are the average miss in rest-of-season FP/G; small numbers are 95% ranges from resampling players. Lower is better.</p>
    ${folds.length ? `<div class="table-wrap"><table class="acc">
      <thead><tr><th class="l">Test season</th><th>Pivot</th><th>Season avg</th><th>Previous</th><th title="How much smaller Pivot's miss is than the season average's">Gain</th></tr></thead>
      <tbody>${folds.map((f) => `<tr style="cursor:default"><td class="l">${esc(f.test)} <span class="ci">tuned on ${esc(f.train.join(', '))}</span></td>
        <td class="strong">${f.mae.model.mae.toFixed(2)} ${ci(f.mae.model)}</td><td>${f.mae.seasonAvg.mae.toFixed(2)}</td><td>${f.mae.old.mae.toFixed(2)}</td>
        <td class="up">${Math.round((1 - f.mae.model.mae / f.mae.seasonAvg.mae) * 100)}%</td></tr>`).join('')}</tbody></table></div>` : ''}
    ${pooled ? `<h3 class="acc-h">All test seasons together</h3>
      <div class="impact acc">${bt.baselines.map((k) => { const m = pooled.mae[k]; return `<div class="irow" data-tip="${esc(`${bt.labels[k]}: ${m.mae.toFixed(2)} FP/G, 95% range ${m.lo.toFixed(2)} to ${m.hi.toFixed(2)}`)}"><span class="ilab">${k === 'model' ? `<b>${esc(bt.labels[k])}</b>` : esc(bt.labels[k])}</span>
        <span class="itrack flat"><i class="${k === 'model' ? 'pos' : 'base'}" style="width:${(m.mae / max * 100).toFixed(1)}%"></i><u style="left:${(m.lo / max * 100).toFixed(1)}%;width:${((m.hi - m.lo) / max * 100).toFixed(1)}%"></u></span><span class="num ival">${m.mae.toFixed(2)}</span></div>`; }).join('')}</div>
      <h3 class="acc-h">What each piece is worth</h3>
      <p class="muted">The model with one piece taken away. A bigger miss means the piece helps; a range that crosses zero means it makes no measurable difference.</p>
      <div class="table-wrap"><table class="acc"><thead><tr><th class="l">Change</th><th>Miss</th><th>Against full model</th></tr></thead>
        <tbody>${bt.ablations.map((k) => { const d = pooled.diff[k]; const helps = d.lo > 0; return `<tr style="cursor:default"><td class="l">${esc(bt.labels[k])}</td><td>${pooled.mae[k].mae.toFixed(2)}</td>
          <td class="${helps ? 'down' : 'muted'}">${signedD(d)} <span class="ci">${d.lo.toFixed(2)} to ${d.hi.toFixed(2)}</span></td></tr>`; }).join('')}</tbody></table></div>
      <p class="chart-note">The FantasyPros blend in the live model has no history to test against, so it is not in these numbers.</p>` : ''}
    <h3 class="acc-h">Live this season</h3>${liveBlock}
    <p class="chart-note">Re-run the evaluation with <code>npm run backtest</code>.</p></div></div>`;
}

// ---------- player drawer ----------
function openPlayer(id) {
  const p = byId.get(+id);
  if (!p) return;
  const splits = [['season', 'Season'], ['l30', 'Last 30d'], ['l15', 'Last 15d'], ['l7', 'Last 7d'], ['proj', 'ESPN proj'], ['prev', 'Last season']];
  const news = S.news.filter((n) => n.playerId === p.id).slice(0, 4);
  const d = $('#drawer');
  d.innerHTML = `<button class="close" aria-label="Close">×</button>
    <h2>${esc(p.name)}</h2>
    <div class="muted" style="margin-top:4px">${esc(p.team)} · ${esc(p.pos)} · ${fmt(p.owned, 0)}% rostered ${ownChip(p.own)} ${INJ[p.injuryStatus] ? `<span class="chip inj ${INJ[p.injuryStatus][1]}">${INJ[p.injuryStatus][0]}</span>` : ''}</div>
    <div class="kpis">
      <div class="kpi"><b>${p.consensus?.rank ?? '–'}</b><span>Consensus rank</span></div>
      <div class="kpi"><b>${p.model.rank}</b><span>Model rank</span></div>
      <div class="kpi"><b>${fmt(p.model.fpg)}</b><span>Proj FP/G (ROS)</span></div>
      <div class="kpi"><b>${fmt(p.avail.games, 0)}</b><span>Expected games left</span></div>
    </div>
    <section><h3>Game by game</h3>${formChart([{ p, side: 'get' }])}</section>
    ${p.signal ? `<section><h3>${p.signal.type === 'buy' ? 'Buy low' : 'Sell high'}</h3><ul>${p.signal.reasons.map((x) => `<li>${esc(x)}</li>`).join('')}</ul></section>` : ''}
    <section><h3>How the projection was built</h3><ul>${p.model.reasons.map((x) => `<li>${esc(x)}</li>`).join('')}
      <li>Typical miss at this point of a season: ±${fmt(p.model.sd)} FP/G, measured on past seasons</li>
      <li>Next few games: ${fmt(p.model.next)} FP/G · rest-of-season value above replacement: ${p.model.value} points${p.delta.rank ? ` · model rank ${p.delta.rank > 0 ? 'up' : 'down'} ${Math.abs(p.delta.rank)} since the last update` : ''}</li></ul></section>
    <section><h3>Source ranks</h3><div class="table-wrap"><table><thead><tr>${S.meta.sources.map((s) => `<th>${esc(s.label)}</th>`).join('')}<th>Model</th></tr></thead>
      <tbody><tr style="cursor:default">${S.meta.sources.map((s) => `<td>${p.ranks[s.key] ?? '–'}</td>`).join('')}<td class="strong">${p.model.rank}</td></tr></tbody></table></div></section>
    <section><h3>Per-game production</h3><div class="table-wrap"><table><thead><tr><th class="l">Split</th><th>GP</th><th>MIN</th><th>FP</th><th>PTS</th><th>REB</th><th>AST</th><th>STL</th><th>BLK</th><th>TO</th><th>FG%</th></tr></thead>
      <tbody>${splits.filter(([k]) => p.s[k]).map(([k, l]) => { const x = p.s[k]; return `<tr style="cursor:default"><td class="l">${l}</td><td>${x.gp}</td><td>${fmt(x.min)}</td><td class="strong">${fmt(x.fp)}</td><td>${fmt(x.pts)}</td><td>${fmt(x.reb)}</td><td>${fmt(x.ast)}</td><td>${fmt(x.stl)}</td><td>${fmt(x.blk)}</td><td>${fmt(x.to)}</td><td>${fmt(x.fgp * 100)}</td></tr>`; }).join('')}</tbody></table></div></section>
    ${p.injury?.comment ? `<section><h3>Injury report</h3><p>${esc(p.injury.comment)}</p></section>` : ''}
    ${news.length ? `<section><h3>Recent news</h3><ul>${news.map((n) => `<li><span class="chip ${n.tone}">${esc(n.label)}</span> ${esc(n.headline || n.lines?.[0] || '')} <span class="muted">${timeAgo(n.time)}</span></li>`).join('')}</ul></section>` : ''}
    <section><button class="btn small primary" data-mock="${p.id}">Mock offers</button> ${p.own?.type === 'mine' || !S.league ? `<button class="btn small" data-analyze="give:${p.id}">Offer him in a trade</button>` : ''} ${p.own?.type === 'team' || !S.league ? `<button class="btn small" data-analyze="get:${p.id}">Build an offer for him</button>` : ''}</section>`;
  d.hidden = false; $('#scrim').hidden = false;
  if (!calm()) motion.then((m) => {
    if (!m) return;
    m.animate(d, { transform: ['translateX(48px)', 'translateX(0)'], opacity: [0.4, 1] }, { type: 'spring', stiffness: 320, damping: 32 });
    m.animate([...d.querySelectorAll('section')], { opacity: [0, 1], transform: ['translateY(8px)', 'translateY(0)'] }, { delay: m.stagger(0.035, { startDelay: 0.05 }), duration: 0.3 });
  });
}
function closeDrawer() { $('#drawer').hidden = true; $('#scrim').hidden = true; }

document.addEventListener('click', (e) => {
  const mock = e.target.closest('[data-mock]');
  if (mock) {
    Object.assign(ui.trade, { player: +mock.dataset.mock, team: null, res: null });
    closeDrawer();
    if (location.hash === '#trades') { renderFinder(); loadOffers(); window.scrollTo(0, 0); } else location.hash = '#trades';
    return;
  }
  const an = e.target.closest('[data-analyze]');
  if (an) {
    const [key, id] = an.dataset.analyze.split(':');
    const give = ui.give.filter((x) => x !== +id), get = ui.get.filter((x) => x !== +id);
    let partner = ui.trade.partner;
    if (key === 'get') {
      const team = partnerOf(+id);
      if (team != null && team !== partner) { partner = team; get.splice(0, get.length, ...get.filter((x) => partnerOf(x) === team)); }
    }
    (key === 'give' ? give : get).push(+id);
    closeDrawer();
    openBuilder({ give, get, partner });
    return;
  }
  if (e.target.closest('.close') || e.target.id === 'scrim') return closeDrawer();
  if (e.target.closest('button, a, input, select')) return;
  const el = e.target.closest('[data-player]');
  if (el) openPlayer(el.dataset.player);
});
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeDrawer(); });
window.addEventListener('hashchange', () => { closeDrawer(); if (S) render(); window.scrollTo(0, 0); });
$('#refresh').onclick = async () => { await api('/api/refresh', {}); S.job.running = true; poll(); };
// Pick up a daily update that ran while the page was open.
async function checkFresh() {
  if (!S || polling) return;
  const st = await api('/api/status').catch(() => null);
  if (!st) return;
  if (st.job.running) poll();
  else if (st.refreshedAt && st.refreshedAt !== S.meta?.refreshedAt) load();
  else renderChrome();
}
setInterval(checkFresh, 60000);
document.addEventListener('visibilitychange', () => { if (!document.hidden) checkFresh(); });

load().catch((e) => { $('#app').innerHTML = `<div class="panel"><div class="empty">Could not reach the app server: ${esc(e.message)}</div></div>`; });
