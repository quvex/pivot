// Who owns each player, from the synced league or the manual roster. No dependencies, so it also
// runs in the browser for the static demo.
export function ownership(data, settings) {
  const league = data.league;
  const map = new Map();
  let mine = new Set();
  if (league) {
    const myTeam = league.teams.find((t) => t.id === settings.teamId) || league.teams.find((t) => t.isMine);
    for (const t of league.teams) {
      for (const id of t.roster) map.set(id, t === myTeam ? { type: 'mine', team: t.name } : { type: 'team', team: t.name });
    }
    if (myTeam) mine = new Set(myTeam.roster);
    return { map, mine, synced: true, myTeam: myTeam || null, get: (id) => map.get(id) || { type: 'fa' } };
  }
  mine = new Set(settings.manualRoster || []);
  return {
    map, mine, synced: false, myTeam: null,
    get: (id) => (mine.has(id) ? { type: 'mine' } : { type: 'unknown' }),
  };
}

