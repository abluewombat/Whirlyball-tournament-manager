import { query, withTransaction } from "./db";
import { getStandings, type StandingRow } from "./standings";

type ActiveBracketRow = {
  id: number;
  division: string;
  seed_snapshot_json: SeedSnapshot[] | null;
};

type SeedSnapshot = {
  seed: number;
  teamId: number;
  team: string;
  center: string;
};

type BracketGameRow = {
  id: number;
  bracket_id: number;
  game_key: string;
  bracket_side: string;
  round: number;
  position: number;
  team_1_id: number | null;
  team_2_id: number | null;
  winner_team_id: number | null;
  loser_team_id: number | null;
  next_winner_game_key: string | null;
  next_winner_slot: number | null;
  next_loser_game_key: string | null;
  next_loser_slot: number | null;
};

type SeedingGameRow = {
  team_1_id: number;
  team_2_id: number;
  team_1_score: number | null;
  team_2_score: number | null;
  winner_team_id: number | null;
  loser_team_id: number | null;
  result_type: string | null;
};

type SimGame = BracketGameRow & {
  team_1_id: number | null;
  team_2_id: number | null;
  winner_team_id: number | null;
  loser_team_id: number | null;
};

type TeamProfile = {
  teamId: number;
  team: string;
  center: string;
  seed: number;
  rating: number;
  standings: StandingRow | null;
};

export type StoredBracketOdds = {
  generatedAt: string;
  iterations: number;
  teams: Array<{
    teamId: number;
    team: string;
    center: string;
    seed: number;
    record: string;
    pointDiff: number;
    gamesPlayed: number;
    rating: number;
    titleOdds: number;
    finalOdds: number;
    averageFinish: number;
    likelyObstacles: Array<{ teamId: number; team: string; chance: number }>;
    likelyEliminators: Array<{ teamId: number; team: string; chance: number }>;
  }>;
};

type RecalculateResult = {
  bracketId: number;
  division: string;
  teams: number;
  iterations: number;
};

const defaultIterations = 3000;

export async function recalculateBracketOddsForTournament(tournamentId: number, iterations = defaultIterations) {
  const brackets = await query<ActiveBracketRow>(
    "SELECT id, division, seed_snapshot_json FROM brackets WHERE tournament_id = $1 AND status = 'active' ORDER BY division, id",
    [tournamentId]
  );
  const results: RecalculateResult[] = [];
  for (const bracket of brackets) {
    const odds = await calculateBracketOdds(tournamentId, bracket, iterations);
    if (!odds) continue;
    await withTransaction(async (client) => {
      await client.query("UPDATE brackets SET bracket_odds_json = $1::jsonb, updated_at = NOW() WHERE id = $2", [
        JSON.stringify(odds),
        bracket.id
      ]);
    });
    results.push({ bracketId: bracket.id, division: bracket.division, teams: odds.teams.length, iterations });
  }
  return results;
}

export async function recalculateBracketOddsForBracket(tournamentId: number, bracketId: number, iterations = defaultIterations) {
  const [bracket] = await query<ActiveBracketRow>(
    "SELECT id, division, seed_snapshot_json FROM brackets WHERE tournament_id = $1 AND id = $2 AND status = 'active'",
    [tournamentId, bracketId]
  );
  if (!bracket) return null;
  const odds = await calculateBracketOdds(tournamentId, bracket, iterations);
  if (!odds) return null;
  await withTransaction(async (client) => {
    await client.query("UPDATE brackets SET bracket_odds_json = $1::jsonb, updated_at = NOW() WHERE id = $2", [
      JSON.stringify(odds),
      bracketId
    ]);
  });
  return { bracketId, division: bracket.division, teams: odds.teams.length, iterations };
}

async function calculateBracketOdds(tournamentId: number, bracket: ActiveBracketRow, iterations: number): Promise<StoredBracketOdds | null> {
  const [standings, bracketGames, seedingGames] = await Promise.all([
    getStandings(tournamentId, bracket.division),
    query<BracketGameRow>(
      "SELECT * FROM bracket_games WHERE bracket_id = $1 ORDER BY bracket_side, round, position, id",
      [bracket.id]
    ),
    query<SeedingGameRow>(
      `SELECT team_1_id, team_2_id, team_1_score, team_2_score, winner_team_id, loser_team_id, result_type
       FROM games
       WHERE tournament_id = $1
         AND phase = 'seeding'
         AND division = $2
         AND team_1_id IS NOT NULL
         AND team_2_id IS NOT NULL
         AND ((team_1_score IS NOT NULL AND team_2_score IS NOT NULL) OR result_type = 'forfeit')`,
      [tournamentId, bracket.division]
    )
  ]);
  const profiles = buildTeamProfiles(bracket.seed_snapshot_json || [], standings, bracketGames);
  if (profiles.length < 2 || bracketGames.length === 0) return null;

  const profileById = new Map(profiles.map((profile) => [profile.teamId, profile]));
  const headToHead = buildHeadToHead(seedingGames);
  const titleCounts = new Map<number, number>();
  const finalCounts = new Map<number, number>();
  const finishTotals = new Map<number, number>();
  const obstacleCounts = new Map<number, Map<number, number>>();
  const eliminatorCounts = new Map<number, Map<number, number>>();

  for (const profile of profiles) {
    titleCounts.set(profile.teamId, 0);
    finalCounts.set(profile.teamId, 0);
    finishTotals.set(profile.teamId, 0);
  }

  for (let iteration = 0; iteration < iterations; iteration++) {
    const rng = seededRandom(`${bracket.id}:${iteration}`);
    const sim = simulateBracket(bracketGames, profileById, headToHead, rng);
    if (sim.championId) titleCounts.set(sim.championId, (titleCounts.get(sim.championId) || 0) + 1);
    for (const finalistId of sim.finalistIds) finalCounts.set(finalistId, (finalCounts.get(finalistId) || 0) + 1);
    for (const profile of profiles) {
      finishTotals.set(profile.teamId, (finishTotals.get(profile.teamId) || 0) + (sim.finishRanks.get(profile.teamId) || profiles.length));
    }
    incrementNestedCounts(obstacleCounts, sim.opponents);
    incrementNestedCounts(eliminatorCounts, sim.eliminators);
  }

  return {
    generatedAt: new Date().toISOString(),
    iterations,
    teams: profiles
      .map((profile) => ({
        teamId: profile.teamId,
        team: profile.team,
        center: profile.center,
        seed: profile.seed,
        record: recordText(profile.standings),
        pointDiff: profile.standings?.point_diff || 0,
        gamesPlayed: profile.standings?.games_played || 0,
        rating: Math.round(profile.rating),
        titleOdds: roundPct((titleCounts.get(profile.teamId) || 0) / iterations),
        finalOdds: roundPct((finalCounts.get(profile.teamId) || 0) / iterations),
        averageFinish: roundOne((finishTotals.get(profile.teamId) || 0) / iterations),
        likelyObstacles: topLinkedTeams(obstacleCounts.get(profile.teamId), profileById, iterations),
        likelyEliminators: topLinkedTeams(eliminatorCounts.get(profile.teamId), profileById, iterations)
      }))
      .sort((left, right) => right.titleOdds - left.titleOdds || left.seed - right.seed)
  };
}

function buildTeamProfiles(seeds: SeedSnapshot[], standings: StandingRow[], bracketGames: BracketGameRow[]) {
  const standingsById = new Map(standings.map((row) => [row.team_id, row]));
  const seedById = new Map(seeds.map((seed) => [seed.teamId, seed]));
  const teamIds = new Set<number>();
  for (const seed of seeds) teamIds.add(seed.teamId);
  for (const game of bracketGames) {
    if (game.team_1_id) teamIds.add(game.team_1_id);
    if (game.team_2_id) teamIds.add(game.team_2_id);
  }

  return [...teamIds].map<TeamProfile>((teamId) => {
    const seed = seedById.get(teamId);
    const standing = standingsById.get(teamId) || null;
    return {
      teamId,
      team: seed?.team || standing?.team || `Team ${teamId}`,
      center: seed?.center || standing?.center || "",
      seed: seed?.seed || standings.findIndex((row) => row.team_id === teamId) + 1 || 99,
      rating: teamRating(standing, seed?.seed || 99),
      standings: standing
    };
  });
}

function teamRating(standing: StandingRow | null, seed: number) {
  if (!standing || standing.games_played === 0) return 1500 - seed * 8;
  const games = Math.max(1, standing.games_played);
  const winPct = standing.wins / games;
  const pointDiffPerGame = standing.point_diff / games;
  const pointsPerGame = standing.standing_points / games;
  return 1500 + winPct * 120 + pointsPerGame * 45 + clamp(pointDiffPerGame, -12, 12) * 12 - seed * 5;
}

function recordText(standing: StandingRow | null) {
  if (!standing) return "0-0";
  const base = `${standing.wins}-${standing.losses}`;
  return standing.ties ? `${base}-${standing.ties}` : base;
}

function buildHeadToHead(games: SeedingGameRow[]) {
  const map = new Map<string, { games: number; wins: number; margin: number }>();
  for (const game of games) {
    if (!game.team_1_id || !game.team_2_id) continue;
    const team1Score = game.team_1_score ?? 0;
    const team2Score = game.team_2_score ?? 0;
    addHeadToHead(map, game.team_1_id, game.team_2_id, game.winner_team_id === game.team_1_id ? 1 : 0, team1Score - team2Score);
    addHeadToHead(map, game.team_2_id, game.team_1_id, game.winner_team_id === game.team_2_id ? 1 : 0, team2Score - team1Score);
  }
  return map;
}

function addHeadToHead(map: Map<string, { games: number; wins: number; margin: number }>, teamId: number, opponentId: number, win: number, margin: number) {
  const key = pairKey(teamId, opponentId);
  const row = map.get(key) || { games: 0, wins: 0, margin: 0 };
  row.games += 1;
  row.wins += win;
  row.margin += margin;
  map.set(key, row);
}

function simulateBracket(
  sourceGames: BracketGameRow[],
  profileById: Map<number, TeamProfile>,
  headToHead: Map<string, { games: number; wins: number; margin: number }>,
  rng: () => number
) {
  const games = sourceGames.map<SimGame>((game) => ({ ...game }));
  const byKey = new Map(games.map((game) => [game.game_key, game]));
  const incomingBySlot = buildIncomingBySlot(games);
  const opponents = new Map<number, Map<number, number>>();
  const eliminators = new Map<number, Map<number, number>>();
  const losses = new Map<number, number>();
  const resolvedGames = new Set<string>();
  let championId: number | null = null;
  const finalistIds = new Set<number>();

  for (let pass = 0; pass < 80; pass++) {
    let changed = false;
    for (const game of games.sort(compareBracketGames)) {
      if (game.winner_team_id === null && canAutoAdvanceOneTeamGame(game, byKey, incomingBySlot)) {
        const winnerId = game.team_1_id || game.team_2_id;
        if (winnerId) {
          game.winner_team_id = winnerId;
          changed = true;
        }
      }
      if (game.winner_team_id === null && game.team_1_id !== null && game.team_2_id !== null) {
        const winnerId = chooseWinner(game.team_1_id, game.team_2_id, profileById, headToHead, rng);
        const loserId = winnerId === game.team_1_id ? game.team_2_id : game.team_1_id;
        game.winner_team_id = winnerId;
        game.loser_team_id = loserId;
        changed = true;
      }
      if (game.winner_team_id !== null && game.loser_team_id !== null && !resolvedGames.has(game.game_key)) {
        resolvedGames.add(game.game_key);
        recordResolvedGame(game, opponents, eliminators, losses);
      }
      if (game.winner_team_id !== null && game.next_winner_game_key && game.next_winner_slot) {
        changed = fillSlot(byKey, game.next_winner_game_key, game.next_winner_slot, game.winner_team_id) || changed;
      }
      if (game.loser_team_id !== null && game.next_loser_game_key && game.next_loser_slot) {
        changed = fillSlot(byKey, game.next_loser_game_key, game.next_loser_slot, game.loser_team_id) || changed;
      }
      if (game.game_key === "F1" && game.winner_team_id !== null && game.loser_team_id !== null) {
        finalistIds.add(game.team_1_id as number);
        finalistIds.add(game.team_2_id as number);
        if (game.team_2_id === game.winner_team_id) {
          changed = fillSlot(byKey, "F2", 1, game.winner_team_id) || changed;
          changed = fillSlot(byKey, "F2", 2, game.loser_team_id) || changed;
        } else {
          championId = game.winner_team_id;
        }
      }
      const reset = byKey.get("F2");
      if (reset?.winner_team_id) {
        finalistIds.add(reset.team_1_id as number);
        finalistIds.add(reset.team_2_id as number);
        championId = reset.winner_team_id;
      }
    }
    if (championId || !changed) break;
  }

  const finishRanks = new Map<number, number>();
  for (const teamId of profileById.keys()) {
    if (teamId === championId) finishRanks.set(teamId, 1);
    else if (finalistIds.has(teamId)) finishRanks.set(teamId, 2);
    else finishRanks.set(teamId, Math.min(8, 3 + (losses.get(teamId) || 0)));
  }

  return { championId, finalistIds, finishRanks, opponents, eliminators };
}

type IncomingSource = {
  sourceGameKey: string;
  result: "winner" | "loser";
};

function buildIncomingBySlot(games: SimGame[]) {
  const incoming = new Map<string, IncomingSource[]>();
  for (const game of games) {
    if (game.next_winner_game_key && game.next_winner_slot) {
      addIncoming(incoming, game.next_winner_game_key, game.next_winner_slot, {
        sourceGameKey: game.game_key,
        result: "winner"
      });
    }
    if (game.next_loser_game_key && game.next_loser_slot) {
      addIncoming(incoming, game.next_loser_game_key, game.next_loser_slot, {
        sourceGameKey: game.game_key,
        result: "loser"
      });
    }
  }
  return incoming;
}

function addIncoming(target: Map<string, IncomingSource[]>, gameKey: string, slot: number, source: IncomingSource) {
  const key = slotKey(gameKey, slot);
  target.set(key, [...(target.get(key) || []), source]);
}

function canAutoAdvanceOneTeamGame(game: SimGame, byKey: Map<string, SimGame>, incomingBySlot: Map<string, IncomingSource[]>) {
  if (!oneTeamOnly(game)) return false;
  const emptySlot = game.team_1_id === null ? 1 : 2;
  return slotCannotReceiveTeam(game.game_key, emptySlot, byKey, incomingBySlot);
}

function slotCannotReceiveTeam(
  gameKey: string,
  slot: number,
  byKey: Map<string, SimGame>,
  incomingBySlot: Map<string, IncomingSource[]>
) {
  const sources = incomingBySlot.get(slotKey(gameKey, slot)) || [];
  if (sources.length === 0) return true;
  return sources.every((source) => sourceCannotProduce(source, byKey, incomingBySlot, new Set<string>()));
}

function sourceCannotProduce(
  source: IncomingSource,
  byKey: Map<string, SimGame>,
  incomingBySlot: Map<string, IncomingSource[]>,
  seen: Set<string>
): boolean {
  const sourceGame = byKey.get(source.sourceGameKey);
  if (!sourceGame) return true;

  if (source.result === "winner" && sourceGame.winner_team_id !== null) return false;
  if (source.result === "loser") {
    if (sourceGame.loser_team_id !== null) return false;
    if (sourceGame.winner_team_id !== null) return true;
  }

  const key = `${source.sourceGameKey}:${source.result}`;
  if (seen.has(key)) return false;
  seen.add(key);

  if (sourceGame.team_1_id !== null || sourceGame.team_2_id !== null) return false;
  return slotCannotReceiveTeamRecursive(sourceGame.game_key, 1, byKey, incomingBySlot, seen) &&
    slotCannotReceiveTeamRecursive(sourceGame.game_key, 2, byKey, incomingBySlot, seen);
}

function slotCannotReceiveTeamRecursive(
  gameKey: string,
  slot: number,
  byKey: Map<string, SimGame>,
  incomingBySlot: Map<string, IncomingSource[]>,
  seen: Set<string>
): boolean {
  const sources = incomingBySlot.get(slotKey(gameKey, slot)) || [];
  if (sources.length === 0) return true;
  return sources.every((source) => sourceCannotProduce(source, byKey, incomingBySlot, seen));
}

function recordResolvedGame(
  game: SimGame,
  opponents: Map<number, Map<number, number>>,
  eliminators: Map<number, Map<number, number>>,
  losses: Map<number, number>
) {
  if (game.team_1_id === null || game.team_2_id === null || game.winner_team_id === null || game.loser_team_id === null) return;
  recordOpponent(opponents, game.team_1_id, game.team_2_id);
  recordOpponent(opponents, game.team_2_id, game.team_1_id);
  const newLossCount = (losses.get(game.loser_team_id) || 0) + 1;
  losses.set(game.loser_team_id, newLossCount);
  if (newLossCount >= 2 || (game.game_key === "F1" && game.team_1_id === game.winner_team_id) || game.game_key === "F2") {
    recordOpponent(eliminators, game.loser_team_id, game.winner_team_id);
  }
}

function chooseWinner(
  team1Id: number,
  team2Id: number,
  profileById: Map<number, TeamProfile>,
  headToHead: Map<string, { games: number; wins: number; margin: number }>,
  rng: () => number
) {
  const probability = matchupWinProbability(team1Id, team2Id, profileById, headToHead);
  return rng() <= probability ? team1Id : team2Id;
}

function matchupWinProbability(
  team1Id: number,
  team2Id: number,
  profileById: Map<number, TeamProfile>,
  headToHead: Map<string, { games: number; wins: number; margin: number }>
) {
  const left = profileById.get(team1Id);
  const right = profileById.get(team2Id);
  const ratingDelta = (left?.rating || 1500) - (right?.rating || 1500);
  const h2h = headToHead.get(pairKey(team1Id, team2Id));
  const h2hDelta = h2h ? clamp((h2h.wins / h2h.games - 0.5) * 1.2 + (h2h.margin / h2h.games) / 24, -0.45, 0.45) : 0;
  const logisticInput = ratingDelta / 180 + h2hDelta;
  return clamp(1 / (1 + Math.exp(-logisticInput)), 0.08, 0.92);
}

function fillSlot(byKey: Map<string, SimGame>, gameKey: string, slot: number, teamId: number) {
  const target = byKey.get(gameKey);
  if (!target) return false;
  const column = slot === 1 ? "team_1_id" : "team_2_id";
  if (target[column] === teamId) return false;
  if (target[column] !== null && target[column] !== teamId) return false;
  target[column] = teamId;
  return true;
}

function oneTeamOnly(game: SimGame) {
  return (game.team_1_id !== null && game.team_2_id === null) || (game.team_1_id === null && game.team_2_id !== null);
}

function compareBracketGames(left: BracketGameRow, right: BracketGameRow) {
  const sideOrder = (value: string) => (value === "winners" ? 0 : value === "losers" ? 1 : 2);
  return sideOrder(left.bracket_side) - sideOrder(right.bracket_side) || left.round - right.round || left.position - right.position || left.id - right.id;
}

function recordOpponent(map: Map<number, Map<number, number>>, teamId: number, opponentId: number) {
  const nested = map.get(teamId) || new Map<number, number>();
  nested.set(opponentId, 1);
  map.set(teamId, nested);
}

function incrementNestedCounts(target: Map<number, Map<number, number>>, source: Map<number, Map<number, number>>) {
  for (const [teamId, nested] of source.entries()) {
    const targetNested = target.get(teamId) || new Map<number, number>();
    for (const [opponentId, count] of nested.entries()) targetNested.set(opponentId, (targetNested.get(opponentId) || 0) + count);
    target.set(teamId, targetNested);
  }
}

function topLinkedTeams(source: Map<number, number> | undefined, profileById: Map<number, TeamProfile>, iterations: number) {
  if (!source) return [];
  return [...source.entries()]
    .map(([teamId, count]) => ({ teamId, team: profileById.get(teamId)?.team || `Team ${teamId}`, chance: roundPct(count / iterations) }))
    .filter((row) => row.chance > 0)
    .sort((left, right) => right.chance - left.chance || left.team.localeCompare(right.team))
    .slice(0, 3);
}

function seededRandom(seed: string) {
  let state = 2166136261;
  for (let index = 0; index < seed.length; index++) {
    state ^= seed.charCodeAt(index);
    state = Math.imul(state, 16777619);
  }
  return () => {
    state += 0x6d2b79f5;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

function pairKey(teamId: number, opponentId: number) {
  return `${teamId}:${opponentId}`;
}

function slotKey(gameKey: string, slot: number) {
  return `${gameKey}:${slot}`;
}

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

function roundPct(value: number) {
  const percent = value * 100;
  if (percent > 0 && percent < 0.1) return 0.1;
  return Math.round(value * 1000) / 10;
}

function roundOne(value: number) {
  return Math.round(value * 10) / 10;
}
