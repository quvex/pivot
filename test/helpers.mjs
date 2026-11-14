// Small synthetic players and leagues for tests. Only the fields the code under test reads.

let nextId = 1;
const SLOT = { PG: 0, SG: 1, SF: 2, PF: 3, C: 4 };

export function player({ name, team = 'BOS', pos = 'PG', fpg = 30, games = 50, market = fpg, repl = 25, ...rest } = {}) {
  const id = rest.id ?? nextId++;
  return {
    id, name: name ?? `Player ${id}`, team, pos,
    slots: [SLOT[pos], pos === 'PG' || pos === 'SG' ? 5 : 6, 11],
    injuryStatus: 'ACTIVE', owned: 50, tags: [],
    s: { season: { fp: fpg, gp: 12, min: 30, pts: 15, ftm: 3 } },
    model: { fpg, next: fpg, sd: 4.5, games: 12, min: 30, rank: 50, boosts: [], value: Math.round((fpg - repl) * games), reasons: [] },
    avail: { games, gamesLeft: games, missed: 0, durability: 0.8, note: '', seasonEnding: false },
    market: { fpg: market, recent: market, value: Math.round((market - repl) * games) },
    signal: null, consensus: null,
    form: { last5: fpg, min5: 30, starts: 100, sd: 10, floor: fpg - 8, ceil: fpg + 8 },
    ...rest,
  };
}

// A two-team, games-capped league: my team (id 1) and Rivals (id 2), plus free agents.
export function league({ mine, theirs, free = [], capTotal = 820, repl = 25 }) {
  const players = [...mine, ...theirs, ...free];
  return {
    players,
    schedule: {},
    meta: { repl, leagueGp: 13 },
    league: {
      format: { capTotal, slotLimits: { 0: 82, 1: 82, 2: 82, 3: 82, 4: 82 }, slotCounts: { 0: 1, 1: 1, 2: 1, 3: 1, 4: 1, 11: 3 } },
      teams: [
        { id: 1, name: 'Mine', points: 4000, gamesUsed: 120, slotUsed: {}, roster: mine.map((p) => p.id), isMine: true },
        { id: 2, name: 'Rivals', points: 4100, gamesUsed: 125, slotUsed: {}, roster: theirs.map((p) => p.id) },
      ],
    },
  };
}

export const SETTINGS = { teamId: 1, manualRoster: [] };
