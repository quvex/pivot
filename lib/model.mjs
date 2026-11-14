// The prediction model, consensus rankings, buy-low / sell-high signals and trade finder.
// Everything here is a pure function over the player list so it is easy to reason about.

import { estimate, makePrior, durabilityOf, spreadOf, loadParams } from './estimator.mjs';

const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));
const r1 = (x) => Math.round(x * 10) / 10;
const DAY = 86400000;
const GAMES_PER_DAY = 1 / 2.15; // an NBA team plays roughly every 2.15 days

export function fantasyPoints(avg, scoring) {
  let total = 0;
  for (const [stat, pts] of Object.entries(scoring)) total += (avg[stat] || 0) * pts;
  return total;
}

// Compact per-game line for one stat split, scored with the league's settings.
function summarize(avg, scoring) {
  if (!avg || !(avg[42] > 0)) return null;
  return {
    fp: r1(fantasyPoints(avg, scoring)), gp: Math.round(avg[42]), min: r1(avg[40] || 0),
    pts: r1(avg[0] || 0), reb: r1(avg[6] || 0), ast: r1(avg[3] || 0), stl: r1(avg[2] || 0), blk: r1(avg[1] || 0),
    to: r1(avg[11] || 0), tpm: r1(avg[17] || 0), fga: r1(avg[14] || 0), fgp: avg[19] || 0, ftp: avg[20] || 0,
    fgm: r1(avg[13] || 0), ftm: r1(avg[15] || 0), fta: r1(avg[16] || 0),
  };
}

export function scorePlayers(players, scoring) {
  for (const p of players) {
    p.s = {};
    for (const [key, avg] of Object.entries(p.raw || {})) {
      const line = summarize(avg, scoring);
      if (line) p.s[key] = line;
    }
    delete p.raw;
  }
}

const POS_ORDER = ['PG', 'SG', 'SF', 'PF', 'C'];
function posAffinity(a, b) {
  const d = Math.abs(POS_ORDER.indexOf(a) - POS_ORDER.indexOf(b));
  return d === 0 ? 1 : d === 1 ? 0.6 : 0.3;
}

const fmtDate = (d) => new Date(d).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });

// ---------- projections ----------
// 1. Per-game estimate from the game log: minutes and per-minute production are estimated
//    separately, recent games weighted more, both shrunk toward a preseason baseline. The
//    weights were tuned by replaying past seasons (see backtest.mjs and params.json).
// 2. Blend in outside rest-of-season projections, then nudge for role news.
// 3. Redistribute production from injured teammates.
// 4. Convert to rest-of-season value above replacement using expected games.
const pctile = (sorted, q) => sorted[Math.min(sorted.length - 1, Math.max(0, Math.round(q * (sorted.length - 1))))];

export function projectPlayers(players, { now = Date.now(), rosterSpots = 130, capGames = 0, nowDay = 0, scoring = {} } = {}) {
  const params = loadParams();
  const makeValue = (scoring[13] || 0) + 2.2 * (scoring[0] || 0);
  const teamGp = {};
  for (const p of players) teamGp[p.team] = Math.max(teamGp[p.team] || 0, p.s.season?.gp || 0);
  const leagueGp = Math.max(0, ...Object.values(teamGp));
  const asLine = (x) => (x ? { fp: x.fp, min: x.min, fgm: x.fgm || 0, fga: x.fga || 0 } : null);

  for (const p of players) {
    const { season, l7, proj, prev } = p.s;
    const reasons = [];
    const prior = makePrior(asLine(proj), asLine(prev), params);
    let games = (p.log || []).map((g) => ({ age: Math.max(0, nowDay - g.d), min: g.min, fp: g.fp, fgm: g.fgm, fga: g.fga }));
    // game log unavailable: fall back to the season line as if every game were average
    if (!games.length && season?.gp > 0) games = Array.from({ length: season.gp }, (_, i) => ({ age: 2 * i, min: season.min, fp: season.fp, fgm: season.fgm, fga: season.fga }));
    const est = estimate(games, prior, params, makeValue) || { fp: 0, min: 0, rate: 0, n: 0, trust: 0 };
    let base = est.fp;
    const n = est.n;
    if (n > 0) {
      reasons.push(`Expected minutes: ${r1(est.min)} (season ${season?.min ?? r1(est.min)}${l7 ? `, last week ${l7.min}` : ''})`);
      reasons.push(prior
        ? `Per-minute production ${est.rate.toFixed(2)} FP/min: ${Math.round(est.trust * 100)}% from his ${n} games this season, ${Math.round((1 - est.trust) * 100)}% from the preseason baseline (${r1(prior.fp)} FP/G)`
        : `Per-minute production ${est.rate.toFixed(2)} FP/min from his ${n} games this season (no preseason baseline)`);
    } else if (prior) {
      reasons.push('No games yet this season: using the preseason baseline');
    }
    // outside rest-of-season projections: averaging independent forecasts beats any one of them
    const ext = p.ext?.fpros;
    if (ext && ext.fp > 0 && base > 0) {
      const w = 0.2;
      reasons.push(`Blended 80/20 with FantasyPros' rest-of-season projection (${r1(ext.fp)} FP/G)`);
      base = (1 - w) * base + w * ext.fp;
    }

    // recent form and consistency, for charts and trade reasoning
    if (p.log?.length) {
      const fps = p.log.map((g) => g.fp);
      const mean = fps.reduce((a, b) => a + b, 0) / fps.length;
      const sorted = [...fps].sort((a, b) => a - b);
      const last5 = p.log.slice(-5), last10 = p.log.slice(-10);
      const avg = (arr, k) => arr.reduce((a, g) => a + g[k], 0) / arr.length;
      p.form = {
        sd: r1(Math.sqrt(fps.reduce((a, v) => a + (v - mean) ** 2, 0) / fps.length)),
        floor: r1(pctile(sorted, 0.2)), ceil: r1(pctile(sorted, 0.8)),
        last5: r1(avg(last5, 'fp')), min5: r1(avg(last5, 'min')),
        starts: Math.round(100 * avg(last10, 'gs')),
      };
    }
    const sd = spreadOf(n, params);

    let adj = 0;
    const tags = p.tags || [];
    if (tags.includes('starting')) { adj += 0.03; reasons.push('News: moved into the starting lineup: +3%'); }
    if (tags.includes('bench')) { adj -= 0.05; reasons.push('News: moved to the bench: -5%'); }
    if (tags.includes('minutes_limit')) { adj -= 0.04; reasons.push('News: on a minutes restriction: -4%'); }

    // availability
    const unsigned = p.team === 'FA'; // not on an NBA roster: no games to play
    const gamesLeft = unsigned ? 0 : Math.max(0, 82 - (teamGp[p.team] ?? leagueGp));
    let missed = 0;
    let note = unsigned ? 'Not on an NBA roster' : '';
    const inj = p.injury;
    const seasonEnding = tags.includes('season_ending') || /out for the (season|year)|season-ending|remainder of the season/i.test(inj?.comment || '');
    if (seasonEnding) {
      missed = gamesLeft; note = 'Out for the season';
    } else if (p.injuryStatus === 'OUT' || p.injuryStatus === 'SUSPENSION') {
      const ret = inj?.returnDate ? new Date(inj.returnDate).getTime() : null;
      const days = ret ? Math.max(1, (ret - now) / DAY) : 7;
      missed = Math.min(gamesLeft, Math.max(1, Math.round(days * GAMES_PER_DAY)));
      note = ret ? `Out, expected back around ${fmtDate(ret)} (~${missed} games)` : `Out, no timetable (assuming ~${missed} games)`;
    } else if (p.injuryStatus === 'DAY_TO_DAY') {
      missed = Math.min(gamesLeft, 1); note = 'Day-to-day';
    }
    // share of remaining games a healthy player goes on to play, fitted on past seasons
    const tg = teamGp[p.team] || 0;
    const durability = durabilityOf(prev ? Math.min(1, prev.gp / 82) : null, tg >= 8 ? Math.min(1, n / tg) : null, params);
    p.avail = { gamesLeft, missed, durability: Math.round(durability * 100) / 100, games: r1((gamesLeft - missed) * durability), note, seasonEnding };
    p.model = { base: base * (1 + adj), reasons, boosts: [], sd, min: r1(est.min), games: n };
  }

  // teammate injuries: who absorbs the missing production, and who loses it on the return
  const byTeam = {};
  for (const p of players) (byTeam[p.team] ||= []).push(p);
  for (const out of players) {
    if (out.team === 'FA' || out.avail.missed < 3 || out.model.base < 18) continue;
    const mates = (byTeam[out.team] || []).filter((t) => t !== out && t.avail.missed < 3 && (t.s.season?.min || t.s.proj?.min || 0) >= 12);
    const weights = mates.map((t) => (t.s.season?.min || t.s.proj?.min) * posAffinity(out.pos, t.pos));
    const total = weights.reduce((a, b) => a + b, 0);
    if (!total) continue;
    // How much of the absence is already in teammates' stats.
    const s = out.s;
    const baked = !s.season ? 1 : !s.l15 ? 0.75 : !s.l7 ? 0.5 : 0;
    mates.forEach((t, i) => {
      const perGame = Math.min(4, 0.4 * out.model.base * (weights[i] / total));
      if (perGame < 0.5) return;
      t.model.boosts.push({ from: out.name, fromId: out.id, perGame: r1(perGame), games: out.avail.missed, baked, seasonEnding: out.avail.seasonEnding });
    });
  }

  for (const p of players) {
    const m = p.model;
    let rosAdj = 0, nowAdj = 0;
    for (const b of m.boosts) {
      const left = Math.max(1, p.avail.gamesLeft);
      const outGames = Math.min(b.games, left);
      rosAdj += (b.perGame * (1 - b.baked) * outGames - b.perGame * b.baked * (left - outGames)) / left;
      nowAdj += b.perGame * (1 - b.baked);
      if (b.perGame * (1 - b.baked) >= 0.5) m.reasons.push(`${b.from} out ~${b.games} games: +${r1(b.perGame * (1 - b.baked))} FP/G while he sits`);
      if (b.perGame * b.baked >= 0.5 && !b.seasonEnding) m.reasons.push(`Stats so far include a bump from ${b.from}'s absence: -${r1(b.perGame * b.baked)} FP/G once he returns`);
    }
    m.fpg = r1(Math.max(0, m.base + rosAdj));
    m.next = r1(Math.max(0, m.base + nowAdj)); // expected per game right now
    m.base = r1(m.base);
    if (p.avail.note) m.reasons.push(p.avail.note);
  }

  // replacement level = the best player who would not be rostered
  const sorted = [...players].sort((a, b) => b.model.fpg - a.model.fpg);
  let repl = sorted[Math.min(rosterSpots, sorted.length - 1)]?.model.fpg || 0;
  if (capGames > 0) {
    // Games-capped league: only `capGames` more player-games can count league-wide, so the
    // replacement level is the FP/G of the last game that fits when the best games go first.
    let filled = 0;
    for (const p of sorted) {
      filled += p.avail.games;
      if (filled >= capGames) { repl = Math.max(repl, p.model.fpg); break; }
    }
  }
  for (const p of players) {
    const { season, l15, proj } = p.s;
    p.model.value = Math.round((p.model.fpg - repl) * p.avail.games);
    // "Market" = what box-score watchers think he is: season and last-15 production.
    const marketFpg = season && season.gp >= 3 ? (l15 && l15.gp >= 3 ? 0.5 * season.fp + 0.5 * l15.fp : season.fp) : proj?.fp ?? p.model.fpg;
    p.model.recent = marketFpg;
  }
  const ranked = [...players].sort((a, b) => {
    const ka = a.model.fpg >= repl ? a.model.value : a.model.fpg - repl;
    const kb = b.model.fpg >= repl ? b.model.value : b.model.fpg - repl;
    return kb - ka || b.model.fpg - a.model.fpg;
  });
  ranked.forEach((p, i) => { p.model.rank = i + 1; });
  return { repl: r1(repl), leagueGp };
}

// ---------- consensus ----------
// sources: [{ key, label, list: [{ id, rank }] }]. A player missing from a source is only
// penalised when the source plausibly left him out on merit (he ranks deep everywhere else).
export function buildConsensus(players, sources) {
  const byId = new Map(players.map((p) => [p.id, p]));
  for (const p of players) p.ranks = {};
  for (const src of sources) for (const { id, rank } of src.list) {
    const p = byId.get(id);
    if (p && !(src.key in p.ranks)) p.ranks[src.key] = rank;
  }
  const scored = [];
  for (const p of players) {
    const have = Object.values(p.ranks);
    if (have.length < 2 && !(have.length === 1 && sources.length === 1)) { p.consensus = null; continue; }
    const mean = have.reduce((a, b) => a + b, 0) / have.length;
    const all = [...have];
    for (const src of sources) {
      if (!(src.key in p.ranks) && mean > 0.6 * src.list.length) all.push(src.list.length + 10);
    }
    const avg = all.reduce((a, b) => a + b, 0) / all.length;
    const sd = Math.sqrt(all.reduce((a, b) => a + (b - avg) ** 2, 0) / all.length);
    p.consensus = { avg: r1(avg), sd: r1(sd), n: have.length, hi: Math.min(...have), lo: Math.max(...have) };
    scored.push(p);
  }
  scored.sort((a, b) => a.consensus.avg - b.consensus.avg || b.model.fpg - a.model.fpg);
  scored.forEach((p, i) => { p.consensus.rank = i + 1; });
}

// ---------- market value ----------
// What a typical manager would pay. People anchor on reputation: where the experts rank a player
// and, early in the season, where he was drafted. Recent box scores move that view, but slowly.
export function buildMarket(players, { repl, leagueGp = 0 }) {
  const ladder = players.map((p) => p.model.fpg).sort((x, y) => y - x);
  const drafted = players.filter((p) => p.adp > 0 && p.adp < 200).sort((x, y) => x.adp - y.adp);
  const adpRank = new Map(drafted.map((p, i) => [p.id, i + 1]));
  const wAdp = Math.max(0.1, 0.55 - leagueGp / 82); // draft capital fades as the season goes on
  for (const p of players) {
    const recent = p.model.recent;
    let rank = p.consensus?.rank ?? null;
    const adp = adpRank.get(p.id);
    if (rank != null && adp) rank = (1 - wAdp) * rank + wAdp * adp;
    const reputation = rank == null ? null : ladder[Math.min(ladder.length - 1, Math.max(0, Math.round(rank) - 1))];
    const fpg = reputation == null ? recent : 0.4 * recent + 0.6 * reputation;
    const injuredDiscount = p.avail.missed >= 3 ? 0.85 : 1;
    p.market = { fpg: r1(fpg), recent: r1(recent), value: Math.round((fpg - repl) * p.avail.games * injuredDiscount) };
    delete p.model.recent;
  }
}

// ---------- buy low / sell high ----------
export function buildSignals(players, scoring, { repl }) {
  const pct = (x) => `${Math.round(Math.abs(x) * 100)}%`;
  const shoot = (x) => `${(x * 100).toFixed(1)}%`;
  const prod = players.filter((p) => p.s.season?.gp >= 4).sort((a, b) => b.s.season.fp - a.s.season.fp);
  prod.forEach((p, i) => { p.prodRank = i + 1; });
  const makeValue = (scoring[13] || 0) + 2.15 * (scoring[0] || 0); // fantasy points gained per extra made field goal

  for (const p of players) {
    const { season, l15, prev, proj } = p.s;
    const buy = [], sell = [];
    let b = 0, s = 0;
    const fpg = p.model.fpg;
    const relevant = (p.model.rank <= 220 || p.owned >= 15) && fpg >= repl - 4 && !p.avail.seasonEnding;

    if (relevant && season) {
      if (l15 && l15.gp >= 4 && season.gp >= 6 && fpg > 12) {
        const d = (l15.fp - fpg) / fpg;
        const minutesHold = l15.min >= season.min * 0.94;
        if (d <= -0.1 && minutesHold) {
          b += Math.min(3, -d * 10);
          buy.push(`Cold stretch: ${l15.fp} FP/G over his last ${l15.gp} games vs ${fpg} projected, but minutes are steady at ${l15.min}`);
        }
        if (d >= 0.12) {
          s += Math.min(3, d * 8);
          sell.push(`Running ${pct(d)} hot: ${l15.fp} FP/G over his last ${l15.gp} games vs ${fpg} projected`);
        }
        if (l15.min < season.min * 0.88 && season.min > 18) {
          s += 1.2;
          sell.push(`Minutes sliding: ${l15.min} lately vs ${season.min} on the season`);
        }
      }
      const baseline = prev && prev.gp >= 30 && prev.fga >= 5 ? prev.fgp : proj?.fgp;
      if (baseline && season.fga >= 7 && season.gp >= 5) {
        const luck = (season.fgp - baseline) * season.fga * makeValue;
        if (luck <= -Math.max(1.5, 0.05 * fpg)) {
          b += Math.min(2.5, -luck / 1.5);
          buy.push(`Shooting ${shoot(season.fgp)} vs a ${shoot(baseline)} baseline: worth about +${r1(-luck)} FP/G when it normalises`);
        } else if (luck >= Math.max(1.5, 0.05 * fpg)) {
          s += Math.min(2.5, luck / 1.5);
          sell.push(`Shooting ${shoot(season.fgp)} vs a ${shoot(baseline)} baseline: about ${r1(luck)} FP/G of his output is hot shooting`);
        }
      }
      if (p.consensus && p.prodRank) {
        const gap = p.prodRank - p.consensus.rank;
        if (gap >= 15 && p.consensus.rank <= 120) {
          b += Math.min(2, gap / 20);
          buy.push(`Experts still rank him #${p.consensus.rank}; his production so far ranks #${p.prodRank}`);
        } else if (gap <= -15 && p.prodRank <= 120) {
          s += Math.min(2, -gap / 20);
          sell.push(`Producing like #${p.prodRank} but experts rank him #${p.consensus.rank}: managers may pay for the hot start`);
        }
      }
      for (const boost of p.model.boosts) {
        if (boost.baked >= 0.5 && !boost.seasonEnding && boost.games <= 12) {
          s += 1.5;
          sell.push(`Numbers are inflated by ${boost.from}'s absence, and he is due back in ~${boost.games} games`);
        }
      }
      const edge = fpg - p.market.recent;
      if (edge >= 2) b += Math.min(2, edge / 2);
      if (edge <= -2) s += Math.min(2, -edge / 2);
    }
    if (relevant && p.avail.missed >= 2 && p.avail.missed <= 12 && fpg >= repl + 4) {
      b += 1.5;
      buy.push(`${p.avail.note}. Injured players usually trade at a discount`);
    }
    if (relevant && p.avail.durability <= 0.72 && p.avail.missed === 0 && fpg >= repl + 6) {
      s += 0.8;
      sell.push(`Durability risk: ${prev ? `played ${prev.gp} games last season` : 'no full season on record'}, expected to play about ${Math.round(p.avail.durability * 100)}% of his remaining games, and is healthy right now`);
    }
    const net = r1(b - s);
    p.signal = net >= 3 && buy.length ? { type: 'buy', score: net, reasons: buy }
      : net <= -3 && sell.length ? { type: 'sell', score: -net, reasons: sell }
      : null;
  }
}

// ---------- trade finder ----------
// mine: Set of my player ids. owners: Map playerId -> team name for every other roster (or null
// when no league is synced, in which case any player not on my team is a possible target).
export function recommendTrades(players, mine, owners) {
  const my = players.filter((p) => mine.has(p.id) && !p.avail.seasonEnding);
  const targets = players.filter((p) => !mine.has(p.id) && (owners ? owners.has(p.id) : p.owned >= 50)
    && p.model.value > 0 && (p.signal?.type === 'buy' || p.model.value >= p.market.value * 1.1 + 15));
  const ideas = [];
  const consider = (give, get) => {
    // Sub-replacement players are worth nothing to either side, not a negative to be dumped.
    const mktGive = give.reduce((a, p) => a + Math.max(0, p.market.value), 0);
    const mktGet = get.market.value;
    const valGive = give.reduce((a, p) => a + Math.max(0, p.model.value), 0);
    const gain = get.model.value - valGive;
    // The other manager has to like it on what he can see: recent production.
    if (mktGive < mktGet * (give.length === 1 ? 0.95 : 1.2)) return;
    if (give.some((p) => p.market.value <= 0)) return; // nobody trades for a waiver-level player
    if (gain < Math.max(20, 0.06 * Math.abs(valGive))) return;
    const theirEdge = mktGive - mktGet;
    const sellBonus = give.reduce((a, p) => a + (p.signal?.type === 'sell' ? p.signal.score : 0), 0);
    const buyBonus = get.signal?.type === 'buy' ? get.signal.score : 0;
    const overpay = theirEdge / Math.max(60, Math.abs(mktGet)); // too generous-looking deals are less realistic
    const score = gain * (1 + 0.12 * (sellBonus + buyBonus)) * (1 - clamp(overpay - 0.25, 0, 0.6));
    ideas.push({
      give: give.map((p) => p.id), get: [get.id], team: owners?.get(get.id) || null,
      gain, fpgDelta: r1(get.model.fpg - give.reduce((a, p) => a + p.model.fpg, 0)),
      theirView: r1(give.reduce((a, p) => a + p.market.fpg, 0) - get.market.fpg), score,
      why: [...give.flatMap((p) => (p.signal?.type === 'sell' ? [`Sell ${p.name}: ${p.signal.reasons[0]}`] : [])),
        ...(get.signal?.type === 'buy' ? [`Buy ${get.name}: ${get.signal.reasons[0]}`] : [`${get.name}: model projects ${get.model.fpg} FP/G; his market price is closer to ${get.market.fpg}`])],
    });
  };
  for (const t of targets) {
    for (let i = 0; i < my.length; i++) {
      consider([my[i]], t);
      // two-for-one consolidation: only worth it for a clearly better player
      for (let j = i + 1; j < my.length; j++) {
        if (t.model.fpg > Math.max(my[i].model.fpg, my[j].model.fpg) + 3) consider([my[i], my[j]], t);
      }
    }
  }
  ideas.sort((a, b) => b.score - a.score);
  const perTarget = new Map(), perGive = new Map(), out = [];
  for (const idea of ideas) {
    if ((perTarget.get(idea.get[0]) || 0) >= 1) continue;
    if (idea.give.some((id) => (perGive.get(id) || 0) >= 2)) continue;
    perTarget.set(idea.get[0], 1);
    for (const id of idea.give) perGive.set(id, (perGive.get(id) || 0) + 1);
    out.push(idea);
    if (out.length >= 12) break;
  }
  return out;
}

// ---------- waiver wire ----------
// free: players available to add. Pairs the best available players with the weakest players
// on my roster, as long as the swap adds real rest-of-season value.
export function recommendWaivers(players, mine, isFree, repl) {
  const why = (p) => {
    const out = [];
    if ((p.tags || []).includes('starting')) out.push('Recently moved into the starting lineup');
    for (const b of p.model.boosts) {
      const now = b.perGame * (1 - b.baked);
      if (now >= 0.5) out.push(`+${r1(now)} FP/G while ${b.from} is out (~${b.games} games)`);
    }
    if (p.signal?.type === 'buy') out.push(p.signal.reasons[0]);
    if (p.signal?.type === 'sell') out.push(`Caution: ${p.signal.reasons[0]}`);
    if (p.ownedChange >= 3) out.push(`Being added across ESPN: rostered in ${Math.round(p.owned)}% of leagues, up ${r1(p.ownedChange)} this week`);
    if (p.crowd?.adds >= 3000) out.push(`Trending on Sleeper: added in ${p.crowd.adds.toLocaleString('en-US')} leagues in the last two days`);
    if (p.avail.missed >= 2) out.push(`${p.avail.note}: needs an IR slot or patience`);
    return out;
  };
  const adds = players.filter((p) => isFree(p) && !p.avail.seasonEnding && p.team !== 'FA' && p.model.fpg >= repl - 6)
    .sort((a, b) => b.model.value - a.model.value || b.model.fpg - a.model.fpg).slice(0, 30);
  const roster = players.filter((p) => mine.has(p.id)).sort((a, b) => a.model.value - b.model.value || a.model.fpg - b.model.fpg);
  const moves = [];
  const usedDrop = new Set();
  for (const add of adds) {
    if (moves.length >= 5) break;
    const drop = roster.find((d) => !usedDrop.has(d.id));
    if (!drop) break;
    const gain = add.model.value - drop.model.value;
    // need a real upgrade both over the season and per game
    if (gain < 40 || add.model.fpg < drop.model.fpg + 1.5) continue;
    if (add.avail.missed >= 3 && moves.some((m) => m.stash)) continue; // one injury stash is plenty
    usedDrop.add(drop.id);
    moves.push({
      add: add.id, drop: drop.id, gain, fpgDelta: r1(add.model.fpg - drop.model.fpg),
      stash: add.avail.missed >= 3,
      why: [...why(add), ...(drop.avail.seasonEnding ? [`${drop.name} is out for the season`] : drop.signal?.type === 'buy' ? [`Note: ${drop.name} is a buy-low candidate (${drop.signal.reasons[0]}), so try to trade him before dropping`] : [])],
    });
  }
  return {
    moves,
    adds: adds.map((p) => ({ id: p.id, why: why(p) })),
    drops: roster.slice(0, 6).map((p) => p.id),
  };
}

// ---------- weekly plan ----------
const ET_DAY = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }); // YYYY-MM-DD in US Eastern
const etDay = (ms) => ET_DAY.format(new Date(ms));

// Chance a player suits up for a game at `time`; `nth` is which of his upcoming games it is.
function playChance(p, time, nth, now) {
  if (p.avail.seasonEnding || p.team === 'FA') return 0;
  if (p.injuryStatus === 'OUT' || p.injuryStatus === 'SUSPENSION') {
    const ret = p.injury?.returnDate ? new Date(p.injury.returnDate).getTime() : now + 7 * DAY;
    if (time < ret - DAY / 2) return 0;
    return time < ret + 2 * DAY ? 0.7 : 0.92; // return dates slip
  }
  // today's game: RotoWire's lineup report is more specific than a day-to-day tag
  if (nth === 0 && time - now < 18 * 3600000 && p.lineup?.playPct != null) return Math.min(0.97, p.lineup.playPct / 100);
  if (p.injuryStatus === 'DAY_TO_DAY') return nth === 0 ? 0.5 : nth === 1 ? 0.8 : 0.95;
  return 0.97;
}

// Best legal lineup for one day: highest expected points first, respecting slot eligibility.
function fillLineup(cands, slots) {
  const owner = new Array(slots.length).fill(null);
  const tryPlace = (c, seen) => {
    for (let i = 0; i < slots.length; i++) {
      if (seen.has(i) || !(c.p.slots || []).includes(slots[i])) continue;
      seen.add(i);
      if (owner[i] == null || tryPlace(owner[i], seen)) { owner[i] = c; return true; }
    }
    return false;
  };
  for (const c of [...cands].sort((a, b) => b.exp - a.exp)) c.start = tryPlace(c, new Set());
}

// Day-by-day projection for one roster from today (US Eastern) through the end of next week.
export function weekPlan(roster, schedule, slotCounts, now = Date.now()) {
  const slots = Object.entries(slotCounts).filter(([s]) => +s < 12).flatMap(([s, n]) => Array(n).fill(+s));
  const today = etDay(now);
  const dow = (new Date(`${today}T12:00:00Z`).getUTCDay() + 6) % 7; // Monday = 0
  const dayCount = 7 - dow + 7;
  const days = [];
  for (let i = 0; i < dayCount; i++) {
    const d = new Date(`${today}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + i);
    days.push({ date: d.toISOString().slice(0, 10), week: i < 7 - dow ? 0 : 1, games: [], total: 0 });
  }
  const byDate = new Map(days.map((d) => [d.date, d]));
  const perPlayer = {};
  for (const p of roster) {
    const upcoming = (schedule[p.team] || []).filter((t) => t > now);
    perPlayer[p.id] = { games: [0, 0], exp: [0, 0], pts: [0, 0] };
    upcoming.forEach((t, nth) => {
      const day = byDate.get(etDay(t));
      if (!day) return;
      const chance = playChance(p, t, nth, now);
      perPlayer[p.id].games[day.week]++;
      day.games.push({ p, id: p.id, chance, exp: chance * p.model.next, start: false });
    });
  }
  const totals = [0, 0];
  for (const day of days) {
    fillLineup(day.games.filter((g) => g.chance > 0), slots);
    for (const g of day.games) {
      if (g.start) { day.total += g.exp; perPlayer[g.id].exp[day.week] += g.chance; perPlayer[g.id].pts[day.week] += g.exp; }
      delete g.p;
    }
    day.total = Math.round(day.total);
    totals[day.week] += day.total;
  }
  return { days, totals, perPlayer };
}

// Rest-of-season outlook for a team in a games-capped league: fill the remaining cap with the
// roster's best expected games; anything left over is filled at replacement level.
export function capOutlook(roster, points, gamesUsed, capTotal, repl) {
  let room = Math.max(0, capTotal - gamesUsed);
  let add = 0;
  let line = repl; // FP/G of the last game that fits: below this, a start costs you points
  const sorted = [...roster].sort((a, b) => b.model.fpg - a.model.fpg);
  for (const p of sorted) {
    if (room <= 0) break;
    if (p.model.fpg < repl) break;
    const g = Math.min(room, p.avail.games);
    add += g * p.model.fpg; room -= g;
    if (g > 0) line = p.model.fpg;
  }
  if (room > 0) { add += room * repl; line = repl; }
  return { projected: Math.round(points + add), capLine: r1(line), unfilled: Math.round(room) };
}
