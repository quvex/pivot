// Trade engine: evaluates any trade from both sides and generates mock offers.
//
// A trade is judged by what it does to each team's projected final points, not by adding up
// FP/G. Around that number it builds a case from everything else the app knows: form, minutes
// and role, health, schedule, expert opinion, roster fit, and how the other manager will see it.

const DAY = 86400000;
const r1 = (x) => Math.round(x * 10) / 10;
const sum = (arr, f) => arr.reduce((a, x) => a + f(x), 0);
const names = (ps) => (ps.length <= 1 ? ps.map((p) => p.name).join('') : `${ps.slice(0, -1).map((p) => p.name).join(', ')} and ${ps.at(-1).name}`);
const POS = [[0, 'PG'], [1, 'SG'], [2, 'SF'], [3, 'PF'], [4, 'C']];
const model = (p) => p.model.fpg;
const market = (p) => p.market.fpg;

export function tradeContext(data, own) {
  const byId = new Map(data.players.map((p) => [p.id, p]));
  const f = data.league?.format;
  const teams = new Map();
  for (const t of data.league?.teams || []) {
    teams.set(t.id, { id: t.id, name: t.name, points: t.points, gamesUsed: t.gamesUsed, slotUsed: t.slotUsed || {}, roster: t.roster.map((id) => byId.get(id)).filter(Boolean) });
  }
  const myTeam = own.myTeam ? teams.get(own.myTeam.id) : null;
  const myRoster = myTeam ? myTeam.roster : data.players.filter((p) => own.mine.has(p.id));
  const teamOf = new Map();
  for (const t of teams.values()) for (const p of t.roster) teamOf.set(p.id, t);
  const now = Date.now();
  const isFree = (p) => { const o = own.get(p.id); return o.type === 'fa' || (o.type === 'unknown' && p.owned < 60); };
  const bestFree = data.players.filter((p) => isFree(p) && p.team !== 'FA' && p.avail.missed < 3 && !p.avail.seasonEnding)
    .sort((a, b) => b.model.value - a.model.value)[0] || null;
  return {
    byId, teams, myTeam, myRoster, teamOf, isFree, bestFree, synced: teams.size > 0,
    repl: data.meta.repl, capTotal: f?.capTotal || 0, seasonFrac: Math.min(1, (data.meta.leagueGp || 0) / 82), slotLimits: f?.slotLimits || {},
    g14: (p) => (data.schedule?.[p.team] || []).filter((t) => t > now && t < now + 14 * DAY).length,
  };
}

// Projected final points for a roster (games-capped league), or total value above replacement.
function outlook(ctx, team, roster, lens) {
  const { repl } = ctx;
  if (ctx.capTotal && team) {
    let room = Math.max(0, ctx.capTotal - team.gamesUsed), add = 0;
    const rows = roster.map((p) => [lens(p), p.avail.games]).sort((a, b) => b[0] - a[0]);
    for (const [fpg, games] of rows) {
      if (room <= 0 || fpg < repl) break;
      const g = Math.min(room, games);
      add += g * fpg; room -= g;
    }
    return team.points + add + room * repl; // unused games get filled from the waiver wire
  }
  return sum(roster, (p) => Math.max(0, lens(p) - repl) * p.avail.games);
}

// Swap players and keep the roster the same size: extra bodies force a drop of the weakest.
function swap(roster, out, inn, lens, repl) {
  const gone = new Set(out.map((p) => p.id));
  let after = [...roster.filter((p) => !gone.has(p.id)), ...inn];
  const drops = [];
  while (after.length > roster.length) {
    const worth = (p) => (lens(p) - repl) * Math.max(1, p.avail.games);
    const worst = after.reduce((a, p) => (worth(p) < worth(a) ? p : a));
    drops.push(worst);
    after = after.filter((p) => p !== worst);
  }
  return { after, drops };
}

const posCount = (roster) => Object.fromEntries(POS.map(([slot, label]) => [label, roster.filter((p) => (p.slots || []).includes(slot) && !p.avail.seasonEnding).length]));

// ---------- evaluate one trade ----------
export function evaluateTrade(ctx, giveIds, getIds, { partnerId = null, light = false } = {}) {
  const give = giveIds.map((id) => ctx.byId.get(id)).filter(Boolean);
  const get = getIds.map((id) => ctx.byId.get(id)).filter(Boolean);
  if (!give.length || !get.length) return null;
  const partner = (partnerId != null ? ctx.teams.get(partnerId) : null)
    || [...new Set(get.map((p) => ctx.teamOf.get(p.id)).filter((t) => t && t !== ctx.myTeam))][0] || null;
  const { repl } = ctx;

  // my side
  const mine = swap(ctx.myRoster, give, get, model, repl);
  const fill = give.length > get.length && ctx.bestFree && !get.includes(ctx.bestFree) ? ctx.bestFree : null;
  const myBefore = outlook(ctx, ctx.myTeam, ctx.myRoster, model);
  const myAfter = outlook(ctx, ctx.myTeam, fill ? [...mine.after, fill] : mine.after, model);
  const delta = Math.round(myAfter - myBefore);

  // their side: what it really does to them, and what it looks like to them
  let their = null, seen;
  if (partner) {
    const t = swap(partner.roster, get, give, market, repl);
    const tb = outlook(ctx, partner, partner.roster, market), ta = outlook(ctx, partner, t.after, market);
    seen = Math.round(ta - tb);
    their = { drops: t.drops.map((p) => p.id), before: Math.round(outlook(ctx, partner, partner.roster, model)), after: Math.round(outlook(ctx, partner, swap(partner.roster, get, give, model, repl).after, model)), seen, roster: t.after };
  } else {
    seen = Math.round(sum(give, (p) => Math.max(0, p.market.value)) - sum(get, (p) => Math.max(0, p.market.value)));
  }
  // Managers do not hand over the best player in a deal for an even return: they want a premium
  // that grows with how much better their star is than anything coming back.
  const starOut = get.reduce((a, p) => (p.market.fpg > a.market.fpg ? p : a));
  const starIn = give.reduce((a, p) => (p.market.fpg > a.market.fpg ? p : a));
  const starTax = Math.round(0.25 * Math.max(0, starOut.market.value) * Math.min(1, Math.max(0, (starOut.market.fpg - starIn.market.fpg) / 8)));
  const scale = Math.max(40, 0.15 * sum(get, (p) => Math.max(0, p.market.value)));
  let pAccept = 1 / (1 + Math.exp(-(seen - starTax - 0.25 * scale) / scale)); // an even deal is not quite enough: people want to win
  if (give.some((p) => p.market.value <= 0)) pAccept *= 0.6; // filler does not sweeten a deal
  if (give.some((p) => p.avail.missed >= 5)) pAccept *= 0.85;
  const accept = { p: Math.round(pAccept * 100) / 100, label: pAccept >= 0.58 ? 'Likely' : pAccept >= 0.38 ? 'Possible' : 'Unlikely' };
  const score = delta * Math.min(1, pAccept + 0.15);
  if (light) return { give: giveIds, get: getIds, partnerId: partner?.id ?? null, delta, seen, accept, score };

  // how sure: the edge compared with the model's own typical miss on these players
  const noise = Math.sqrt(sum([...give, ...get], (p) => (p.model.sd * Math.max(1, p.avail.games)) ** 2)) || 1;
  const ratio = Math.abs(delta) / noise;
  const confidence = ratio >= 0.9 ? 'High' : ratio >= 0.45 ? 'Medium' : 'Low';
  const tone = delta >= 25 ? 'good' : delta <= -25 ? 'bad' : '';
  const head = delta >= 120 ? 'Clear win for you' : delta >= 25 ? 'Good for you' : delta > -25 ? 'Roughly even' : delta > -120 ? 'Costs you' : 'Clear loss for you';

  // ----- the case, factor by factor -----
  const factors = [];
  const add = (key, label, lean, weight, text) => factors.push({ key, label, lean, weight, text });
  const unit = ctx.capTotal ? 'projected final points' : 'rest-of-season points above replacement';
  const bestGet = get.reduce((a, p) => (p.model.fpg > a.model.fpg ? p : a));
  const bestGive = give.reduce((a, p) => (p.model.fpg > a.model.fpg ? p : a));
  const inF = sum(get, model), outF = sum(give, model);

  // production
  if (give.length === 1 && get.length === 1) {
    const d = r1(inF - outF);
    const close = Math.abs(d) < 0.5 * bestGet.model.sd;
    add('production', 'Production', d >= 1 ? 'for' : d <= -1 ? 'against' : 'even', 5,
      `${bestGet.name} projects ${bestGet.model.fpg} FP/G the rest of the way, ${bestGive.name} ${bestGive.model.fpg}.${close ? ` That gap is inside the model's typical miss of ±${r1(bestGet.model.sd)} FP/G, so treat them as close on output alone.` : ''}`);
  } else if (give.length > get.length) {
    const up = bestGet.model.fpg - bestGive.model.fpg;
    add('production', 'Production', up >= 1.5 ? 'for' : up <= -1 ? 'against' : 'even', 5,
      `You send out ${r1(outF)} combined FP/G for ${r1(inF)}, but ${ctx.capTotal ? 'starts are capped, so points per game used is what counts' : 'only your starting slots score'}: ${bestGet.name} (${bestGet.model.fpg}) against your best outgoing player, ${bestGive.name} (${bestGive.model.fpg}).`);
  } else {
    add('production', 'Production', inF - outF >= 1 && bestGet.model.fpg >= bestGive.model.fpg - 3 ? 'for' : 'against', 5,
      `You get ${r1(inF)} combined FP/G for ${r1(outF)}, but the best player in the deal, ${bestGive.model.fpg > bestGet.model.fpg ? bestGive.name : bestGet.name}, ${bestGive.model.fpg > bestGet.model.fpg ? 'leaves your roster' : 'comes to you'}. ${ctx.capTotal ? 'With starts capped, depth only helps if those games would otherwise go to weaker players.' : ''}`.trim());
  }

  // form
  const hot = (p) => p.form && p.model.games >= 5 && p.form.last5 >= p.model.fpg * 1.15;
  const cold = (p) => p.form && p.model.games >= 5 && p.form.last5 <= p.model.fpg * 0.85;
  for (const p of get) {
    if (p.signal) continue; // the price factor below already covers his form
    if (cold(p)) add('form', 'Form', 'for', 2.5, `${p.name} is cold: ${p.form.last5} FP/G over his last five against a ${p.model.fpg} projection. That is why the price is down${p.form.min5 >= (p.s.season?.min || 0) * 0.92 ? ', and his minutes have held' : ', though his minutes have dipped too'}.`);
    else if (hot(p)) add('form', 'Form', 'against', 2.5, `${p.name} is running hot: ${p.form.last5} FP/G over his last five against a ${p.model.fpg} projection, so you would be paying a peak price.`);
  }
  for (const p of give) {
    if (p.signal) continue;
    if (hot(p)) add('form', 'Form', 'for', 2.5, `${p.name} is running hot: ${p.form.last5} FP/G over his last five against a ${p.model.fpg} projection. You would be selling at a peak.`);
    else if (cold(p)) add('form', 'Form', 'against', 2, `${p.name} is cold (${p.form.last5} over his last five against ${p.model.fpg} projected), so you would be selling low.`);
  }

  // role and minutes
  const roleNote = (p) => {
    const tags = p.tags || [];
    const season = p.s.season?.min;
    const bits = [];
    if (tags.includes('starting')) bits.push('just moved into the starting lineup');
    if (tags.includes('bench')) bits.push('was just moved to the bench');
    if (tags.includes('minutes_limit')) bits.push('is on a minutes restriction');
    if (p.form && season && p.model.games >= 6) {
      const d = (p.form.min5 - season) / season;
      if (d <= -0.12) bits.push(`has seen his minutes fall to ${p.form.min5} over his last five (season ${season})`);
      if (d >= 0.12) bits.push(`has seen his minutes rise to ${p.form.min5} over his last five (season ${season})`);
    }
    if (p.form && p.form.starts <= 30 && p.model.fpg > repl) bits.push('comes off the bench');
    const cover = p.model.boosts.filter((b) => b.baked >= 0.5 && !b.seasonEnding && b.games <= 15);
    if (cover.length) bits.push(`has been covering for ${cover.map((b) => `${b.from} (back in about ${b.games} games)`).join(' and ')}`);
    const down = bits.some((b) => /bench|restriction|fall|covering/.test(b)), up = bits.some((b) => /starting|rise/.test(b));
    return bits.length ? { text: `${p.name} ${bits.join(' and ')}`, dir: up && !down ? 1 : down && !up ? -1 : 0 } : null;
  };
  for (const [list, sign] of [[get, 1], [give, -1]]) for (const p of list) {
    const n = roleNote(p);
    if (n) add('role', 'Role', n.dir * sign > 0 ? 'for' : n.dir * sign < 0 ? 'against' : 'even', 2.2, `${n.text}.`);
  }

  // health and availability
  const gIn = sum(get, (p) => p.avail.games), gOut = sum(give, (p) => p.avail.games);
  const healthBits = [];
  for (const p of [...get, ...give]) {
    if (p.avail.seasonEnding) healthBits.push(`${p.name} is out for the season`);
    else if (p.avail.missed >= 2) healthBits.push(`${p.name}: ${p.avail.note[0].toLowerCase()}${p.avail.note.slice(1)}`);
    else if (p.injuryStatus === 'DAY_TO_DAY') healthBits.push(`${p.name} is day-to-day`);
  }
  const fragile = (p) => p.avail.durability <= 0.74;
  for (const p of [...get, ...give]) if (fragile(p) && p.avail.missed < 2) healthBits.push(`${p.name} has an injury history (expected to play about ${Math.round(p.avail.durability * 100)}% of his remaining games)`);
  if (give.length === get.length) {
    const d = gIn - gOut;
    add('health', 'Availability', d >= 4 ? 'for' : d <= -4 ? 'against' : 'even', Math.abs(d) >= 4 || healthBits.length ? 3 : 1,
      `Expected games left: ${Math.round(gIn)} coming in, ${Math.round(gOut)} going out.${healthBits.length ? ` ${healthBits.join('; ')}.` : ' Nobody in the deal is hurt.'}`);
  } else if (healthBits.length) {
    const risky = get.filter((p) => p.avail.missed >= 2 || fragile(p)).length - give.filter((p) => p.avail.missed >= 2 || fragile(p)).length;
    add('health', 'Availability', risky > 0 ? 'against' : risky < 0 ? 'for' : 'even', 3, `${healthBits.join('; ')}.`);
  }

  // schedule
  const sIn = sum(get, ctx.g14), sOut = sum(give, ctx.g14);
  if (give.length === get.length && Math.abs(sIn - sOut) >= 2) {
    add('schedule', 'Schedule', sIn > sOut ? 'for' : 'against', 1, `Next two weeks: ${sIn} games coming in against ${sOut} going out.${ctx.capTotal ? ' With a games cap this only shifts when the points arrive, not how many.' : ''}`);
  }

  // what the market thinks
  for (const p of get) {
    if (p.signal?.type === 'buy') add('market', 'Price', 'for', 3, `Buy-low on ${p.name}: ${lower(p.signal.reasons[0])}.`);
    else if (p.signal?.type === 'sell') add('market', 'Price', 'against', 3, `${p.name} is a sell-high candidate, so you would be buying at the top: ${lower(p.signal.reasons[0])}.`);
    else if (p.consensus && p.model.rank - p.consensus.rank >= 15) add('market', 'Price', 'against', 1.5, `Experts rank ${p.name} #${p.consensus.rank}; this model has him #${p.model.rank}. You may be paying for the name.`);
  }
  for (const p of give) {
    if (p.signal?.type === 'sell') add('market', 'Price', 'for', 3, `Sell-high on ${p.name}: ${lower(p.signal.reasons[0])}.`);
    else if (p.signal?.type === 'buy') add('market', 'Price', 'against', 3, `${p.name} is a buy-low candidate, so you would be selling at the bottom: ${lower(p.signal.reasons[0])}.`);
    else if (p.consensus && p.model.rank - p.consensus.rank >= 15) add('market', 'Price', 'for', 1.5, `Experts rank ${p.name} #${p.consensus.rank}; this model has him #${p.model.rank}. His name carries more trade value than his outlook.`);
  }

  // roster fit
  const before = posCount(ctx.myRoster), after = posCount(mine.after);
  for (const [, label] of POS) {
    if (after[label] < before[label] && after[label] <= 1) add('fit', 'Roster fit', 'against', 2.5, `Leaves you with ${after[label] || 'no'} ${label}-eligible player${after[label] === 1 ? '' : 's'}${ctx.slotLimits[POS.find((x) => x[1] === label)[0]] ? `, with ${ctx.slotLimits[POS.find((x) => x[1] === label)[0]]} ${label} starts to fill over the season` : ''}.`);
    else if (after[label] > before[label] && before[label] <= 2) add('fit', 'Roster fit', 'for', 1.5, `Adds ${label} depth, where you have only ${before[label]} eligible player${before[label] === 1 ? '' : 's'}.`);
  }
  if (ctx.myTeam && ctx.capTotal) {
    for (const [slot, label] of POS) {
      const lim = ctx.slotLimits[slot];
      if (!lim) continue;
      const behind = Math.round(lim * ctx.seasonFrac - (ctx.myTeam.slotUsed[slot] || 0));
      if (behind >= 4 && after[label] > before[label]) add('fit', 'Roster fit', 'for', 1.5, `Your ${label} slot is ${behind} starts behind pace, and this adds a ${label}.`);
    }
  }
  if (fill) add('spot', 'Roster spot', 'for', 1.5, `Opens a roster spot. The best free agent right now is ${fill.name} (${fill.model.fpg} FP/G), included in the numbers above.`);
  if (mine.drops.length) add('spot', 'Roster spot', 'against', 2, `You would have to drop ${names(mine.drops)} (${mine.drops.map((p) => p.model.fpg).join(', ')} FP/G) to make room.`);

  // the other side
  const who = partner ? partner.name : 'The other manager';
  const theirBits = [];
  if (partner) {
    const tb = posCount(partner.roster), ta = posCount(their.roster);
    for (const [, label] of POS) if (ta[label] > tb[label] && tb[label] <= 2) theirBits.push(`it gives them a ${label}, where they are thin`);
    if (their.drops.length) theirBits.push(`they would have to drop ${names(their.drops.map((id) => ctx.byId.get(id)))}`);
  }
  if (give.some((p) => p.avail.missed >= 5)) theirBits.push('they would be taking on an injured player');
  add('them', 'Their side', accept.label === 'Unlikely' ? 'against' : 'even', accept.label === 'Unlikely' ? 4 : 1.2,
    `${who} will judge this on recent box scores and expert ranks, where it looks like ${seen >= 0 ? `a gain of about ${seen}` : `a loss of about ${-seen}`} points for them over the season${starTax >= 40 ? `. They would also be giving up the best player in the deal (${starOut.name}), which managers want a premium for` : ''}${theirBits.length ? `; ${theirBits.join(', and ')}` : ''}. Acceptance: ${accept.label.toLowerCase()}.`);

  factors.sort((a, b) => b.weight - a.weight);

  // concise argument: the number, the best reason, the main risk
  const best = factors.find((x) => x.lean === 'for' && x.key !== 'production');
  const risk = factors.find((x) => x.lean === 'against' && x.key !== 'production');
  const kind = give.length === get.length ? (give.length === 1 ? 'One-for-one' : `${give.length}-for-${get.length}`) : give.length > get.length ? 'Consolidation' : 'Depth deal';
  const lead = delta >= 25 ? `Turning ${names(give)} into ${names(get)} adds about ${delta} ${unit}.`
    : delta <= -25 ? `Turning ${names(give)} into ${names(get)} costs you about ${-delta} ${unit}.`
    : `Swapping ${names(give)} for ${names(get)} moves your ${unit} by only ${delta >= 0 ? '+' : ''}${delta}.`;
  const summary = [lead, best ? `The case for it: ${lcFirst(best.text)}` : delta >= 25 ? 'The case rests on the projections alone; nothing else in the data backs it up.' : '',
    risk ? `The risk: ${lcFirst(risk.text)}` : '',
    confidence === 'Low' ? `Confidence is low: the edge is smaller than the model's typical miss on these players.` : ''].filter(Boolean).join(' ');

  return {
    give: give.map((p) => p.id), get: get.map((p) => p.id), partner: partner ? { id: partner.id, name: partner.name } : null, kind,
    delta, unit, my: { before: Math.round(myBefore), after: Math.round(myAfter) },
    their: their ? { before: their.before, after: their.after, seen } : { seen },
    accept, confidence, verdict: { tone, head }, summary, factors: factors.map(({ key, label, lean, text }) => ({ key, label, lean, text })),
    fill: fill?.id ?? null, drops: mine.drops.map((p) => p.id), g14: Object.fromEntries([...give, ...get].map((p) => [p.id, ctx.g14(p)])), score,
  };
}

const lower = (s) => s.replace(/\.$/, '').replace(/^[A-Z](?=[a-z ])/, (c) => c.toLowerCase());
const lcFirst = (s) => s.replace(/^(You|Your|Leaves|Adds|Opens|Expected|Experts|Next|Buy-low|Sell-high) /, (m) => m.toLowerCase());

// ---------- mock offers ----------
const pairs = (arr) => { const out = arr.map((x) => [x]); for (let i = 0; i < arr.length; i++) for (let j = i + 1; j < arr.length; j++) out.push([arr[i], arr[j]]); return out; };
const tradable = (p) => !p.avail.seasonEnding;

// Returns { subject, mode, offers, note }. Pass a player (on another team: offers to get him;
// on my team: what he could fetch from each team) and/or a team to deal with.
export function mockOffers(ctx, { playerId = null, teamId = null } = {}) {
  const subject = playerId != null ? ctx.byId.get(playerId) : null;
  const mine = ctx.myRoster.filter(tradable);
  if (!mine.length) return { mode: 'none', offers: [], note: 'Set up your roster first: sync your ESPN league or add your players in Settings.' };
  const isMine = subject && ctx.myRoster.includes(subject);
  const combos = []; // [giveList, getList, partnerId]

  if (subject && !isMine) {
    const team = ctx.teamOf.get(subject.id);
    if (ctx.synced && !team) {
      const worst = [...ctx.myRoster].sort((a, b) => a.model.value - b.model.value)[0];
      const gain = subject.model.value - worst.model.value;
      return { mode: 'free', subject: subject.id, offers: [], note: `${subject.name} is a free agent in your league, so there is nobody to trade with. ${gain > 20 ? `Adding him for ${worst.name} would add about ${Math.round(gain)} points above replacement over the rest of the season.` : `He does not project above your weakest player (${worst.name}), so there is no move to make.`}` };
    }
    // sweeteners from their roster for two-for-two deals
    const extras = team ? team.roster.filter((p) => p !== subject && tradable(p) && p.model.fpg < subject.model.fpg).sort((a, b) => b.model.value - a.model.value).slice(0, 6) : [];
    for (const g of pairs(mine)) {
      combos.push([g, [subject], team?.id ?? null]);
      if (g.length === 2) for (const e of extras) combos.push([g, [subject, e], team?.id ?? null]);
    }
  } else {
    const teams = [...ctx.teams.values()].filter((t) => t !== ctx.myTeam && (teamId == null || t.id === teamId));
    if (!teams.length) return { mode: 'none', offers: [], note: ctx.synced ? 'Pick a team to trade with.' : 'Sync your ESPN league to see what each team could offer. Until then, search for a player to target.' };
    const giveSets = isMine
      ? [[subject], ...mine.filter((p) => p !== subject).map((p) => [subject, p])]
      : pairs([...mine].sort((a, b) => b.model.value - a.model.value).slice(0, 10));
    for (const t of teams) {
      const theirs = t.roster.filter(tradable).sort((a, b) => b.model.value - a.model.value).slice(0, isMine || teamId != null ? 12 : 8);
      for (const g of giveSets) for (const r of pairs(theirs)) combos.push([g, r, t.id]);
    }
  }

  const scored = [];
  for (const [g, r, pid] of combos) {
    const ev = evaluateTrade(ctx, g.map((p) => p.id), r.map((p) => p.id), { partnerId: pid, light: true });
    if (ev) scored.push(ev);
  }
  // realistic first: offers that help me and that the other side might take
  const good = scored.filter((e) => e.delta >= 15 && e.accept.label !== 'Unlikely').sort((a, b) => b.score - a.score);
  let pool = good, note = '';
  if (!good.length) {
    const helps = scored.filter((e) => e.delta >= 15).sort((a, b) => b.accept.p - a.accept.p);
    const fair = scored.filter((e) => e.accept.label !== 'Unlikely').sort((a, b) => b.delta - a.delta);
    pool = [...helps.slice(0, 2), ...fair.slice(0, 2)];
    note = pool.length ? 'No offer both helps you and looks acceptable to the other side. These are the closest: the first improve your team but will be a hard sell, the rest they would take but do little for you.' : 'No workable offer found.';
  }
  // variety: do not repeat the same outgoing or incoming player too often
  const used = new Map(), out = [], seenKey = new Set();
  const limit = subject ? 5 : 6;
  for (const e of pool) {
    const key = `${[...e.give].sort()}|${[...e.get].sort()}`;
    if (seenKey.has(key)) continue;
    const ids = [...e.give, ...e.get].filter((id) => id !== subject?.id);
    if (ids.some((id) => (used.get(id) || 0) >= 2)) continue;
    if (isMine && out.filter((o) => o.partnerId === e.partnerId).length >= 2) continue;
    seenKey.add(key);
    for (const id of ids) used.set(id, (used.get(id) || 0) + 1);
    out.push(e);
    if (out.length >= limit) break;
  }
  return {
    mode: subject ? (isMine ? 'shop' : 'target') : 'team', subject: subject?.id ?? null, teamId, note,
    offers: out.map((e) => evaluateTrade(ctx, e.give, e.get, { partnerId: e.partnerId })),
  };
}
