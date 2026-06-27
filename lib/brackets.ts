import { BracketsManager } from "brackets-manager";
import { InMemoryDatabase } from "brackets-memory-db";
import { exec, query, withTransaction } from "./db";
import { getStandings, seedingCompleteForDivision } from "./standings";

type BracketGameRow = {
  id: number;
  bracket_id: number;
  game_key: string;
  bracket_side: string;
  round: number;
  position: number;
  team_1_id: number | null;
  team_2_id: number | null;
  team_1_score: number | null;
  team_2_score: number | null;
  winner_team_id: number | null;
  loser_team_id: number | null;
  result_type: string | null;
  forfeit_team_id: number | null;
  next_winner_game_key: string | null;
  next_winner_slot: number | null;
  next_loser_game_key: string | null;
  next_loser_slot: number | null;
};

export type BracketScoreLock = {
  game_id: number;
  result_locked: boolean;
  result_lock_reason: string | null;
  reset_locked: boolean;
  reset_lock_reason: string | null;
};

export type BracketScheduleSlot = {
  bracket_game_id: number;
  schedule_game_id: number | null;
  schedule_label: string | null;
  starts_at: string | null;
  court: number | null;
  actual_started_at: string | null;
  actual_ended_at: string | null;
};

type BracketScheduleEntry = {
  label: string;
  side: "winners" | "losers" | "finals";
};

type BracketRow = {
  id: number;
  division: string;
  seed_snapshot_json: SeedSnapshot[];
  bracket_data_json: any;
};

type BracketGamePlan = {
  gameKey: string;
  side: "winners" | "losers";
  round: number;
  position: number;
  team1Id: number | null;
  team2Id: number | null;
  nextWinnerGameKey: string | null;
  nextWinnerSlot: number | null;
  nextLoserGameKey: string | null;
  nextLoserSlot: number | null;
};

export async function maybeCreateBracketForDivision(tournamentId: number, division: string) {
  if (!(await seedingCompleteForDivision(tournamentId, division))) return;
  const [existing] = await query<{ id: number }>(
    "SELECT id FROM brackets WHERE tournament_id = $1 AND division = $2 AND status = 'active' ORDER BY id DESC LIMIT 1",
    [tournamentId, division]
  );
  if (!existing) await rebuildBracketForDivision(tournamentId, division);
}

export type TournamentBracketSyncSummary = {
  divisionsChecked: number;
  divisionsReady: number;
  bracketsGenerated: number;
  bracketsSynced: number;
  skipped: Array<{ division: string; reason: string }>;
};

export async function syncCompletedDivisionBracketsToSchedule(tournamentId: number): Promise<TournamentBracketSyncSummary> {
  const divisions = await query<{ division: string }>(
    `SELECT DISTINCT division
       FROM games
      WHERE tournament_id = $1
        AND phase = 'seeding'
        AND division = ANY($2::text[])
      ORDER BY division`,
    [tournamentId, ["A", "B", "C", "D"]]
  );
  const summary: TournamentBracketSyncSummary = {
    divisionsChecked: divisions.length,
    divisionsReady: 0,
    bracketsGenerated: 0,
    bracketsSynced: 0,
    skipped: []
  };

  for (const { division } of divisions) {
    if (!(await seedingCompleteForDivision(tournamentId, division))) {
      summary.skipped.push({ division, reason: "Seeding games still open" });
      continue;
    }
    summary.divisionsReady += 1;

    const [existing] = await query<{ id: number }>(
      "SELECT id FROM brackets WHERE tournament_id = $1 AND division = $2 AND status = 'active' ORDER BY id DESC LIMIT 1",
      [tournamentId, division]
    );
    if (existing) {
      await syncBracketToSchedule(existing.id);
      summary.bracketsSynced += 1;
      continue;
    }

    const bracketId = await rebuildBracketForDivision(tournamentId, division);
    if (bracketId) {
      summary.bracketsGenerated += 1;
      summary.bracketsSynced += 1;
    } else {
      summary.skipped.push({ division, reason: "Bracket could not be generated" });
    }
  }

  return summary;
}

export async function rebuildBracketForDivision(tournamentId: number, division: string, options: { force?: boolean } = {}) {
  if (!options.force && (await scoredTournamentResultCountForDivision(tournamentId, division)) > 0) return null;
  const standings = (await getStandings(tournamentId, division)).filter((row) => row.division === division);
  if (standings.length < 2) return null;
  const seeds = standings.map((row, index) => ({ seed: index + 1, teamId: row.team_id, team: row.team, center: row.center }));
  const bracketData = await createManagedDoubleEliminationBracket(division, seeds);

  const bracketId = await withTransaction(async (client) => {
    await client.query(
      "UPDATE brackets SET status = 'archived', updated_at = NOW() WHERE tournament_id = $1 AND division = $2 AND status = 'active'",
      [tournamentId, division]
    );
    const bracketResult = await client.query<{ id: number }>(
      "INSERT INTO brackets (tournament_id, division, seed_snapshot_json, bracket_data_json) VALUES ($1, $2, $3::jsonb, $4::jsonb) RETURNING id",
      [tournamentId, division, JSON.stringify(seeds), JSON.stringify(bracketData)]
    );
    await client.query("DELETE FROM bracket_games WHERE bracket_id = $1", [bracketResult.rows[0].id]);
    const size = nextPowerOfTwo(seeds.length);
    const plans = buildDoubleEliminationPlan(
      seeds.map((seed) => seed.teamId),
      size
    );
    for (const plan of plans) {
      await client.query(
        `INSERT INTO bracket_games (
           bracket_id, game_key, bracket_side, round, position, team_1_id, team_2_id,
           next_winner_game_key, next_winner_slot, next_loser_game_key, next_loser_slot
         )
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
        [
          bracketResult.rows[0].id,
          plan.gameKey,
          plan.side,
          plan.round,
          plan.position,
          plan.team1Id,
          plan.team2Id,
          plan.nextWinnerGameKey,
          plan.nextWinnerSlot,
          plan.nextLoserGameKey,
          plan.nextLoserSlot
        ]
      );
    }
    return bracketResult.rows[0].id;
  });
  await advanceBracket(bracketId);
  return bracketId;
}

type SeedSnapshot = {
  seed: number;
  teamId: number;
  team: string;
  center: string;
};

async function createManagedDoubleEliminationBracket(division: string, seeds: SeedSnapshot[]) {
  const size = nextPowerOfTwo(seeds.length);
  const seeding = [...seeds.map((seed) => seed.team), ...Array<string | null>(size - seeds.length).fill(null)];
  const storage = new InMemoryDatabase();
  const manager = new BracketsManager(storage);
  const stage = await manager.create.stage({
    tournamentId: 0,
    name: `${division} Division`,
    type: "double_elimination",
    seeding,
    settings: { grandFinal: "double" }
  });
  return manager.get.stageData(stage.id);
}

export async function scoreBracketGame(gameId: number, team1Score: number, team2Score: number) {
  if (!isValidScore(team1Score) || !isValidScore(team2Score) || team1Score === team2Score) return;
  const [game] = await query<BracketGameRow>("SELECT * FROM bracket_games WHERE id = $1", [gameId]);
  if (!game || game.team_1_id === null || game.team_2_id === null) return;
  const winnerId = team1Score >= team2Score ? game.team_1_id : game.team_2_id;
  const loserId = winnerId === game.team_1_id ? game.team_2_id : game.team_1_id;
  const sameResult = winnerId === game.winner_team_id && loserId === game.loser_team_id;
  if (!sameResult) {
    const downstreamBlocker = await findScoredDownstreamGame(game);
    if (downstreamBlocker) return;
    await clearDownstreamFromGame(game);
  }
  await exec(
    `UPDATE bracket_games
     SET team_1_score = $1, team_2_score = $2, winner_team_id = $3, loser_team_id = $4,
         result_type = 'score', forfeit_team_id = NULL
     WHERE id = $5`,
    [team1Score, team2Score, winnerId, loserId, gameId]
  );
  await advanceBracket(game.bracket_id);
  await syncBracketToSchedule(game.bracket_id);
}

export async function forfeitBracketGame(gameId: number, forfeitingTeamId: number) {
  const [game] = await query<BracketGameRow>("SELECT * FROM bracket_games WHERE id = $1", [gameId]);
  if (!game || game.team_1_id === null || game.team_2_id === null) return;
  if (forfeitingTeamId !== game.team_1_id && forfeitingTeamId !== game.team_2_id) return;

  const winnerId = forfeitingTeamId === game.team_1_id ? game.team_2_id : game.team_1_id;
  const sameResult = winnerId === game.winner_team_id && forfeitingTeamId === game.loser_team_id;
  if (!sameResult) {
    const downstreamBlocker = await findScoredDownstreamGame(game);
    if (downstreamBlocker) return;
    await clearDownstreamFromGame(game);
  }

  await exec(
    `UPDATE bracket_games
     SET team_1_score = NULL, team_2_score = NULL, winner_team_id = $1, loser_team_id = $2,
         result_type = 'forfeit', forfeit_team_id = $2
     WHERE id = $3`,
    [winnerId, forfeitingTeamId, gameId]
  );
  await advanceBracket(game.bracket_id);
  await syncBracketToSchedule(game.bracket_id);
}

export async function resetBracketGameScore(gameId: number) {
  const [game] = await query<BracketGameRow>("SELECT * FROM bracket_games WHERE id = $1", [gameId]);
  if (!game) return;
  const downstreamBlocker = await findScoredDownstreamGame(game);
  if (downstreamBlocker) return;
  await clearDownstreamFromGame(game);
  await exec(
    `UPDATE bracket_games
     SET team_1_score = NULL, team_2_score = NULL, winner_team_id = NULL, loser_team_id = NULL,
         result_type = NULL, forfeit_team_id = NULL
     WHERE id = $1`,
    [gameId]
  );
  await advanceBracket(game.bracket_id);
  await syncBracketToSchedule(game.bracket_id);
}

export async function getActiveBracketScoreLocks(tournamentId: number) {
  const games = await query<BracketGameRow & { division: string }>(
    `SELECT bracket_games.*, brackets.division
     FROM bracket_games
     JOIN brackets ON brackets.id = bracket_games.bracket_id
     WHERE brackets.tournament_id = $1 AND brackets.status = 'active'
     ORDER BY brackets.division,
              CASE bracket_games.bracket_side WHEN 'winners' THEN 1 WHEN 'losers' THEN 2 ELSE 3 END,
              bracket_games.round, bracket_games.position`,
    [tournamentId]
  );
  const byBracketId = new Map<number, BracketGameRow[]>();
  for (const game of games) byBracketId.set(game.bracket_id, [...(byBracketId.get(game.bracket_id) || []), game]);

  const locks = new Map<number, BracketScoreLock>();
  for (const game of games) {
    const blocker = findScoredDownstreamGameInList(game, byBracketId.get(game.bracket_id) || []);
    if (!blocker) continue;
    const blockerLabel = bracketGameLabel(blocker);
    locks.set(game.id, {
      game_id: game.id,
      result_locked: true,
      result_lock_reason: `Winner is locked because ${blockerLabel} is already scored. Same-winner score corrections are still allowed.`,
      reset_locked: true,
      reset_lock_reason: `Cannot reset because ${blockerLabel} is already scored.`
    });
  }
  return locks;
}

export async function getActiveBracketScheduleSlots(tournamentId: number) {
  const brackets = await query<{ id: number; division: string }>(
    "SELECT id, division FROM brackets WHERE tournament_id = $1 AND status = 'active' ORDER BY division, id",
    [tournamentId]
  );
  const slots = new Map<number, BracketScheduleSlot>();

  for (const bracket of brackets) {
    const bracketGames = await query<BracketGameRow>("SELECT * FROM bracket_games WHERE bracket_id = $1", [bracket.id]);
    const labels = bracketScheduleLabels(bracketGames);
    const scheduleGames = await query<{
      id: number;
      label: string | null;
      starts_at: string;
      court: number;
      actual_started_at: string | null;
      actual_ended_at: string | null;
    }>(
      `SELECT id, label, starts_at, court, actual_started_at, actual_ended_at
       FROM games
       WHERE tournament_id = $1 AND phase = 'tournament' AND division = $2`,
      [tournamentId, bracket.division]
    );
    const scheduleByLabel = new Map(scheduleGames.filter((game) => game.label).map((game) => [game.label as string, game]));

    for (const game of bracketGames) {
      const scheduleLabel = labels.get(game.id) || null;
      const scheduleGame = scheduleLabel ? scheduleByLabel.get(scheduleLabel) : null;
      slots.set(game.id, {
        bracket_game_id: game.id,
        schedule_game_id: scheduleGame?.id || null,
        schedule_label: scheduleLabel,
        starts_at: scheduleGame?.starts_at || null,
        court: scheduleGame?.court || null,
        actual_started_at: scheduleGame?.actual_started_at || null,
        actual_ended_at: scheduleGame?.actual_ended_at || null
      });
    }
  }

  return slots;
}

export async function activeBracketExistsForDivision(tournamentId: number, division: string) {
  const [row] = await query<{ count: string }>(
    "SELECT COUNT(*) as count FROM brackets WHERE tournament_id = $1 AND division = $2 AND status = 'active'",
    [tournamentId, division]
  );
  return Number(row?.count || 0) > 0;
}

export async function scoredTournamentResultCountForDivision(tournamentId: number, division: string) {
  const [row] = await query<{ count: string }>(
    `SELECT (
       SELECT COUNT(*)
       FROM bracket_games
       JOIN brackets ON brackets.id = bracket_games.bracket_id
       WHERE brackets.tournament_id = $1
         AND brackets.status = 'active'
         AND brackets.division = $2
         AND (
           (bracket_games.team_1_score IS NOT NULL AND bracket_games.team_2_score IS NOT NULL)
           OR bracket_games.result_type = 'forfeit'
         )
     ) + (
       SELECT COUNT(*)
       FROM games
       WHERE tournament_id = $1
         AND phase IN ('tournament', 'unlimited')
         AND division = $2
         AND (
           (team_1_score IS NOT NULL AND team_2_score IS NOT NULL)
           OR result_type = 'forfeit'
         )
     ) as count`,
    [tournamentId, division]
  );
  return Number(row?.count || 0);
}

export async function recordedScoreCount(tournamentId: number) {
  const [row] = await query<{ count: string }>(
    `SELECT (
       SELECT COUNT(*)
       FROM games
       WHERE tournament_id = $1
         AND phase <> 'tournament'
         AND (team_1_score IS NOT NULL OR team_2_score IS NOT NULL OR result_type = 'forfeit')
     ) + (
       SELECT COUNT(*)
       FROM bracket_games
       JOIN brackets ON brackets.id = bracket_games.bracket_id
       WHERE brackets.tournament_id = $1
         AND (
           bracket_games.team_1_score IS NOT NULL
          OR bracket_games.team_2_score IS NOT NULL
          OR bracket_games.result_type = 'forfeit'
         )
     ) as count`
    ,
    [tournamentId]
  );
  return Number(row?.count || 0);
}

export async function advanceBracket(bracketId: number) {
  for (let pass = 0; pass < 8; pass++) {
    const games = await query<BracketGameRow>("SELECT * FROM bracket_games WHERE bracket_id = $1 ORDER BY bracket_side, round, position", [bracketId]);
    let changed = false;
    for (const game of games) {
      if (game.winner_team_id === null && isFirstRoundBye(game)) {
        const winnerId = game.team_1_id || game.team_2_id;
        if (!winnerId) continue;
        await exec("UPDATE bracket_games SET winner_team_id = $1 WHERE id = $2", [winnerId, game.id]);
        game.winner_team_id = winnerId;
        changed = true;
      }
      if (game.winner_team_id !== null && game.next_winner_game_key && game.next_winner_slot) {
        changed = (await fillSlot(bracketId, game.next_winner_game_key, game.next_winner_slot, game.winner_team_id)) || changed;
      }
      if (game.loser_team_id !== null && game.next_loser_game_key && game.next_loser_slot) {
        changed = (await fillSlot(bracketId, game.next_loser_game_key, game.next_loser_slot, game.loser_team_id)) || changed;
      }
      if (game.game_key === "F1" && game.winner_team_id !== null && game.loser_team_id !== null && game.team_2_id === game.winner_team_id) {
        changed = (await fillSlot(bracketId, "F2", 1, game.winner_team_id)) || changed;
        changed = (await fillSlot(bracketId, "F2", 2, game.loser_team_id)) || changed;
      }
    }
    if (!changed) break;
  }
  await refreshBracketViewerData(bracketId);
  await syncBracketToSchedule(bracketId);
}

function buildDoubleEliminationPlan(teamIds: number[], size: number) {
  const rounds = Math.log2(size);
  const slots = seedOrder(size).map((seed) => teamIds[seed - 1] || null);
  const plans: BracketGamePlan[] = [];

  for (let round = 1; round <= rounds; round++) {
    const count = size / 2 ** round;
    for (let position = 1; position <= count; position++) {
      const gameKey = `W${round}-${position}`;
      const nextWinnerGameKey = round < rounds ? `W${round + 1}-${Math.ceil(position / 2)}` : "F1";
      const nextWinnerSlot = round < rounds ? (position % 2 ? 1 : 2) : 1;
      const loserRound = round === 1 ? 1 : 2 * round - 2;
      const nextLoserGameKey = round <= rounds ? `L${loserRound}-${Math.ceil(position / (round === 1 ? 2 : 1))}` : null;
      const nextLoserSlot = round === 1 ? (position % 2 ? 1 : 2) : 2;
      plans.push({
        gameKey,
        side: "winners",
        round,
        position,
        team1Id: round === 1 ? slots[(position - 1) * 2] : null,
        team2Id: round === 1 ? slots[(position - 1) * 2 + 1] : null,
        nextWinnerGameKey,
        nextWinnerSlot,
        nextLoserGameKey,
        nextLoserSlot
      });
    }
  }

  for (let round = 1; round <= 2 * (rounds - 1); round++) {
    const count = Math.max(1, size / 2 ** (Math.floor((round + 1) / 2) + 1));
    for (let position = 1; position <= count; position++) {
      const evenRound = round % 2 === 0;
      const lastLoserRound = round === 2 * (rounds - 1);
      plans.push({
        gameKey: `L${round}-${position}`,
        side: "losers",
        round,
        position,
        team1Id: null,
        team2Id: null,
        nextWinnerGameKey: lastLoserRound ? "F1" : evenRound ? `L${round + 1}-${Math.ceil(position / 2)}` : `L${round + 1}-${position}`,
        nextWinnerSlot: lastLoserRound ? 2 : evenRound ? (position % 2 ? 1 : 2) : 1,
        nextLoserGameKey: null,
        nextLoserSlot: null
      });
    }
  }

  plans.push({
    gameKey: "F1",
    side: "winners",
    round: rounds + 1,
    position: 1,
    team1Id: null,
    team2Id: null,
    nextWinnerGameKey: null,
    nextWinnerSlot: null,
    nextLoserGameKey: null,
    nextLoserSlot: null
  });
  plans.push({
    gameKey: "F2",
    side: "winners",
    round: rounds + 2,
    position: 1,
    team1Id: null,
    team2Id: null,
    nextWinnerGameKey: null,
    nextWinnerSlot: null,
    nextLoserGameKey: null,
    nextLoserSlot: null
  });

  return plans;
}

function nextPowerOfTwo(value: number) {
  let size = 1;
  while (size < value) size *= 2;
  return size;
}

function seedOrder(size: number): number[] {
  if (size === 1) return [1];
  const previous = seedOrder(size / 2);
  return previous.flatMap((seed) => [seed, size + 1 - seed]);
}

function isFirstRoundBye(game: BracketGameRow) {
  return game.bracket_side === "winners" && game.round === 1 && oneTeamOnly(game);
}

function oneTeamOnly(game: BracketGameRow) {
  return (game.team_1_id !== null && game.team_2_id === null) || (game.team_1_id === null && game.team_2_id !== null);
}

async function fillSlot(bracketId: number, gameKey: string, slot: number, teamId: number) {
  const column = slot === 1 ? "team_1_id" : "team_2_id";
  const [target] = await query<{ id: number; current_team_id: number | null }>(
    `SELECT id, ${column} as current_team_id FROM bracket_games WHERE bracket_id = $1 AND game_key = $2`,
    [bracketId, gameKey]
  );
  if (!target || target.current_team_id === teamId) return false;
  if (target.current_team_id !== null && target.current_team_id !== teamId) return false;
  await exec(`UPDATE bracket_games SET ${column} = $1 WHERE id = $2`, [teamId, target.id]);
  return true;
}

export async function syncActiveBracketsToSchedule(tournamentId: number) {
  const brackets = await query<{ id: number }>(
    "SELECT id FROM brackets WHERE tournament_id = $1 AND status = 'active' ORDER BY division, id",
    [tournamentId]
  );
  for (const bracket of brackets) await syncBracketToSchedule(bracket.id);
}

export async function syncBracketToSchedule(bracketId: number) {
  const [bracket] = await query<{ id: number; tournament_id: number; division: string }>(
    "SELECT id, tournament_id, division FROM brackets WHERE id = $1",
    [bracketId]
  );
  if (!bracket) return;
  const games = await query<BracketGameRow>("SELECT * FROM bracket_games WHERE bracket_id = $1", [bracketId]);
  const labels = bracketScheduleLabels(games);
  for (const game of games) {
    const label = labels.get(game.id);
    if (!label) continue;
    await exec(
      `UPDATE games
       SET team_1_id = $1, team_2_id = $2, team_1_score = $3, team_2_score = $4,
           winner_team_id = $5, loser_team_id = $6, result_type = $7, forfeit_team_id = $8
       WHERE tournament_id = $9 AND phase = 'tournament' AND division = $10 AND label = $11`,
      [
        game.team_1_id,
        game.team_2_id,
        game.team_1_score,
        game.team_2_score,
        game.winner_team_id,
        game.loser_team_id,
        game.result_type,
        game.forfeit_team_id,
        bracket.tournament_id,
        bracket.division,
        label
      ]
    );
  }
}

export function bracketScheduleLabelForGameNumber(teamCount: number, gameNumber: number) {
  return bracketScheduleLabelsForTeamCount(teamCount)[gameNumber - 1] || null;
}

export function bracketSchedulePlaceholderText(division: string, teamCount: number, label: string | null) {
  const stage = bracketScheduleDisplayNameForLabel(teamCount, label);
  return stage ? `${division} - Playoffs (${stage})` : null;
}

function bracketScheduleDisplayNameForLabel(teamCount: number, label: string | null) {
  if (!label) return null;
  if (label === "Championship") return "CHAMPIONSHIP";
  if (label === "If-needed Championship") return "IF NEEDED CHAMPIONSHIP";

  const winnerMatch = label.match(/^Winners (?:R1 Game|bracket Game) (\d+)$/);
  if (winnerMatch) return winnerStageName(teamCount, Number(winnerMatch[1]));

  const loserMatch = label.match(/^Losers bracket Game (\d+)$/);
  if (loserMatch) return loserStageName(teamCount, Number(loserMatch[1]));

  return null;
}

function winnerStageName(teamCount: number, winnerIndex: number) {
  if (teamCount <= 1 || winnerIndex < 1) return null;
  const size = nextPowerOfTwo(teamCount);
  const firstRoundGames = teamCount === size ? size / 2 : teamCount - size / 2;
  const roundCounts = [firstRoundGames].filter((count) => count > 0);
  for (let gameCount = size / 4; gameCount >= 1; gameCount = Math.floor(gameCount / 2)) {
    roundCounts.push(gameCount);
  }

  let cursor = 0;
  for (let index = 0; index < roundCounts.length; index++) {
    const gameCount = roundCounts[index];
    cursor += gameCount;
    if (winnerIndex > cursor) continue;
    if (gameCount === 4) return "QUARTERFINALS";
    if (gameCount === 2) return "SEMIFINALS";
    if (gameCount === 1) return "W FINALS";
    if (index === 0 && firstRoundGames !== size / 2) return "PLAY-IN";
    return `W ROUND ${index + 1}`;
  }
  return null;
}

function loserStageName(teamCount: number, loserIndex: number) {
  const loserGameTotal = Math.max(0, teamCount - 2);
  if (loserIndex < 1 || loserIndex > loserGameTotal) return null;
  const remainingAfterGame = loserGameTotal - loserIndex;
  if (remainingAfterGame === 0) return "L FINALS";
  if (remainingAfterGame <= 2) return "L SEMIS";
  if (remainingAfterGame <= 4) return "L QUARTERS";
  return "L PLAYOFFS";
}

function bracketScheduleLabelsForTeamCount(teamCount: number) {
  return bracketScheduleEntriesForTeamCount(teamCount).map((entry) => entry.label);
}

function bracketScheduleEntriesForTeamCount(teamCount: number): BracketScheduleEntry[] {
  if (teamCount <= 1) return [];
  const size = nextPowerOfTwo(teamCount);
  const entries: BracketScheduleEntry[] = [];
  let winnerIndex = 0;
  let loserIndex = 0;
  const firstRoundGames = teamCount === size ? size / 2 : teamCount - size / 2;
  const winnerGameTotal = teamCount - 1;
  const loserGameTotal = Math.max(0, teamCount - 2);

  for (let position = 1; position <= firstRoundGames; position++) {
    winnerIndex += 1;
    entries.push({ label: `Winners R1 Game ${winnerIndex}`, side: "winners" });
  }
  while (loserIndex < loserGameTotal || winnerIndex < winnerGameTotal) {
    if (loserIndex < loserGameTotal) {
      loserIndex += 1;
      entries.push({ label: `Losers bracket Game ${loserIndex}`, side: "losers" });
    }
    if (winnerIndex < winnerGameTotal) {
      winnerIndex += 1;
      entries.push({ label: `Winners bracket Game ${winnerIndex}`, side: "winners" });
    }
  }
  entries.push({ label: "Championship", side: "finals" });
  entries.push({ label: "If-needed Championship", side: "finals" });
  return entries;
}

function bracketScheduleLabels(games: BracketGameRow[]) {
  const labels = new Map<number, string>();
  const teamIds = new Set<number>();
  for (const game of games.filter((candidate) => candidate.bracket_side === "winners" && candidate.round === 1)) {
    if (game.team_1_id !== null) teamIds.add(game.team_1_id);
    if (game.team_2_id !== null) teamIds.add(game.team_2_id);
  }
  const teamCount = teamIds.size;
  const loserGameTotal = Math.max(0, teamCount - 2);
  const firstRoundGames = games
    .filter((candidate) => candidate.bracket_side === "winners" && candidate.round === 1 && !isFirstRoundBye(candidate))
    .sort((left, right) => left.position - right.position);
  const laterWinnerGames = games
    .filter((candidate) => candidate.bracket_side === "winners" && candidate.round > 1 && candidate.game_key !== "F1" && candidate.game_key !== "F2")
    .sort((left, right) => left.round - right.round || left.position - right.position);
  const loserGames = games
    .filter((candidate) => candidate.bracket_side === "losers")
    .sort((left, right) => left.round - right.round || left.position - right.position)
    .slice(0, loserGameTotal);
  let winnerIndex = 0;
  let loserIndex = 0;

  for (const game of firstRoundGames) {
    winnerIndex++;
    labels.set(game.id, `Winners R1 Game ${winnerIndex}`);
  }
  for (let index = 0; index < Math.max(loserGames.length, laterWinnerGames.length); index++) {
    const loser = loserGames[index];
    if (loser) {
      loserIndex++;
      labels.set(loser.id, `Losers bracket Game ${loserIndex}`);
    }
    const winner = laterWinnerGames[index];
    if (winner) {
      winnerIndex++;
      labels.set(winner.id, `Winners bracket Game ${winnerIndex}`);
    }
  }
  for (const game of games) {
    if (game.game_key === "F1") labels.set(game.id, "Championship");
    if (game.game_key === "F2") labels.set(game.id, "If-needed Championship");
  }
  return labels;
}

async function refreshBracketViewerData(bracketId: number) {
  const [bracket] = await query<BracketRow>("SELECT * FROM brackets WHERE id = $1", [bracketId]);
  if (!bracket?.bracket_data_json) return;

  const seeds = bracket.seed_snapshot_json || [];
  const participantByTeamId = new Map(seeds.map((seed, index) => [seed.teamId, index]));
  const bracketGames = await query<BracketGameRow>("SELECT * FROM bracket_games WHERE bracket_id = $1", [bracketId]);
  const data = structuredClone(bracket.bracket_data_json);
  const groupsById = new Map<number, { id: number; number: number }>((data.group || []).map((group: any) => [group.id, group]));
  const roundsById = new Map<number, { id: number; number: number }>((data.round || []).map((round: any) => [round.id, round]));

  for (const match of (data.match || []) as Array<{ group_id: number; round_id: number; number: number; opponent1?: unknown; opponent2?: unknown; status?: number }>) {
    const group = groupsById.get(match.group_id);
    const round = roundsById.get(match.round_id);
    if (!group || !round) continue;
    const gameKey = gameKeyForManagedMatch(group.number, round.number, match.number);
    const bracketGame = bracketGames.find((game) => game.game_key === gameKey);
    if (!bracketGame) continue;
    match.opponent1 = managedOpponent(bracketGame.team_1_id, bracketGame.team_1_score, bracketGame.winner_team_id, participantByTeamId);
    match.opponent2 = managedOpponent(bracketGame.team_2_id, bracketGame.team_2_score, bracketGame.winner_team_id, participantByTeamId);
    match.status = isCompleteResult(bracketGame) ? 4 : bracketGame.team_1_id !== null && bracketGame.team_2_id !== null ? 2 : 0;
  }

  await exec("UPDATE brackets SET bracket_data_json = $1::jsonb, updated_at = NOW() WHERE id = $2", [JSON.stringify(data), bracketId]);
}

function managedOpponent(teamId: number | null, score: number | null, winnerTeamId: number | null, participantByTeamId: Map<number, number>) {
  const id = teamId === null ? null : participantByTeamId.get(teamId);
  const opponent: Record<string, unknown> = { id: id ?? null };
  if (score !== null) opponent.score = score;
  if (teamId !== null && winnerTeamId !== null) opponent.result = teamId === winnerTeamId ? "win" : "loss";
  return opponent;
}

function gameKeyForManagedMatch(groupNumber: number, roundNumber: number, matchNumber: number) {
  if (groupNumber === 1) return `W${roundNumber}-${matchNumber}`;
  if (groupNumber === 2) return `L${roundNumber}-${matchNumber}`;
  if (groupNumber === 3) return roundNumber === 1 ? "F1" : "F2";
  return "";
}

function isValidScore(score: number) {
  return Number.isInteger(score) && score >= 0;
}

function isCompleteResult(game: Pick<BracketGameRow, "team_1_score" | "team_2_score" | "result_type">) {
  return (game.team_1_score !== null && game.team_2_score !== null) || game.result_type === "forfeit";
}

function bracketGameLabel(game: Pick<BracketGameRow, "game_key" | "bracket_side" | "round" | "position">) {
  if (game.game_key === "F1") return "Championship";
  if (game.game_key === "F2") return "If-needed Championship";
  return `${game.bracket_side === "losers" ? "Losers" : "Winners"} Round ${game.round} Game ${game.position}`;
}

async function findScoredDownstreamGame(game: BracketGameRow) {
  const games = await query<BracketGameRow>("SELECT * FROM bracket_games WHERE bracket_id = $1", [game.bracket_id]);
  return findScoredDownstreamGameInList(game, games);
}

function findScoredDownstreamGameInList(game: BracketGameRow, games: BracketGameRow[], seen = new Set<number>()): BracketGameRow | null {
  if (seen.has(game.id)) return null;
  seen.add(game.id);

  for (const target of downstreamTargetsForCurrentResult(game, games)) {
    if (isCompleteResult(target)) return target;
    const nested = findScoredDownstreamGameInList(target, games, seen);
    if (nested) return nested;
  }

  return null;
}

function downstreamTargetsForCurrentResult(game: BracketGameRow, games: BracketGameRow[]) {
  const targets: BracketGameRow[] = [];
  const byKey = new Map(games.map((candidate) => [candidate.game_key, candidate]));

  if (game.winner_team_id !== null && game.next_winner_game_key && game.next_winner_slot) {
    const target = downstreamSlotTarget(byKey, game.next_winner_game_key, game.next_winner_slot, game.winner_team_id);
    if (target) targets.push(target);
  }
  if (game.loser_team_id !== null && game.next_loser_game_key && game.next_loser_slot) {
    const target = downstreamSlotTarget(byKey, game.next_loser_game_key, game.next_loser_slot, game.loser_team_id);
    if (target) targets.push(target);
  }
  if (game.game_key === "F1") {
    const finalReset = byKey.get("F2");
    if (finalReset) targets.push(finalReset);
  }

  return targets;
}

function downstreamSlotTarget(byKey: Map<string, BracketGameRow>, gameKey: string, slot: number, teamId: number) {
  const target = byKey.get(gameKey);
  if (!target) return null;
  const currentTeamId = slot === 1 ? target.team_1_id : target.team_2_id;
  return currentTeamId === teamId ? target : null;
}

async function clearDownstreamFromGame(game: BracketGameRow, seen = new Set<number>()) {
  if (seen.has(game.id)) return;
  seen.add(game.id);

  if (game.winner_team_id !== null && game.next_winner_game_key && game.next_winner_slot) {
    await clearDownstreamSlot(game.bracket_id, game.next_winner_game_key, game.next_winner_slot, game.winner_team_id, seen);
  }
  if (game.loser_team_id !== null && game.next_loser_game_key && game.next_loser_slot) {
    await clearDownstreamSlot(game.bracket_id, game.next_loser_game_key, game.next_loser_slot, game.loser_team_id, seen);
  }
  if (game.game_key === "F1") {
    const [finalReset] = await query<BracketGameRow>("SELECT * FROM bracket_games WHERE bracket_id = $1 AND game_key = 'F2'", [game.bracket_id]);
    if (finalReset) {
      await clearDownstreamFromGame(finalReset, seen);
      await exec(
        `UPDATE bracket_games
         SET team_1_id = NULL, team_2_id = NULL, team_1_score = NULL, team_2_score = NULL,
             winner_team_id = NULL, loser_team_id = NULL, result_type = NULL, forfeit_team_id = NULL
         WHERE id = $1`,
        [finalReset.id]
      );
    }
  }
}

async function clearDownstreamSlot(bracketId: number, gameKey: string, slot: number, teamId: number, seen: Set<number>) {
  const column = slot === 1 ? "team_1_id" : "team_2_id";
  const [target] = await query<BracketGameRow & { current_team_id: number | null }>(
    `SELECT *, ${column} as current_team_id FROM bracket_games WHERE bracket_id = $1 AND game_key = $2`,
    [bracketId, gameKey]
  );
  if (!target || target.current_team_id !== teamId) return;

  await clearDownstreamFromGame(target, seen);
  await exec(
    `UPDATE bracket_games
     SET ${column} = NULL, team_1_score = NULL, team_2_score = NULL, winner_team_id = NULL, loser_team_id = NULL,
         result_type = NULL, forfeit_team_id = NULL
     WHERE id = $1`,
    [target.id]
  );
}
