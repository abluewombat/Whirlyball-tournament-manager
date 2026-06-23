import {
  activeBracketExistsForDivision,
  getActiveBracketScheduleSlots,
  scoreBracketGame
} from "./brackets";
import { exec, query } from "./db";
import { completeAndAdvanceCourtGame } from "./streams";

export type ScoreSyncResult =
  | { ok: true; changed: boolean; kind: "seeding" | "bracket"; gameId: number }
  | { ok: false; reason: string };

export function validScore(value: number) {
  return Number.isInteger(value) && value >= 0;
}

export async function tournamentIsEditable(tournamentId: number) {
  const [tournament] = await query<{ editing_locked: boolean }>("SELECT editing_locked FROM tournaments WHERE id = $1", [tournamentId]);
  return Boolean(tournament && !tournament.editing_locked);
}

export async function scoreCourtGameFromSync(input: {
  gameId: number;
  team1Score: number;
  team2Score: number;
  scoredBy: string;
}): Promise<ScoreSyncResult> {
  if (!validScore(input.team1Score) || !validScore(input.team2Score)) return { ok: false, reason: "Invalid score" };

  const [game] = await query<{
    id: number;
    tournament_id: number;
    phase: string;
    division: string;
    team_1_id: number | null;
    team_2_id: number | null;
    team_1_score: number | null;
    team_2_score: number | null;
    result_type: string | null;
  }>(
    `SELECT id, tournament_id, phase, division, team_1_id, team_2_id,
            team_1_score, team_2_score, result_type
       FROM games
      WHERE id = $1`,
    [input.gameId]
  );
  if (!game || game.team_1_id === null || game.team_2_id === null) return { ok: false, reason: "Game is not scoreable" };
  if (!(await tournamentIsEditable(game.tournament_id))) return { ok: false, reason: "Tournament is locked" };

  if (game.phase === "tournament") {
    const bracketGameId = await bracketGameIdForScheduleGame(game.tournament_id, game.id);
    if (!bracketGameId) return { ok: false, reason: "No active bracket game is linked to this tournament slot" };
    return scoreBracketGameFromSync({
      bracketGameId,
      team1Score: input.team1Score,
      team2Score: input.team2Score
    });
  }

  if (game.phase !== "seeding") return { ok: false, reason: `Unsupported game phase: ${game.phase}` };
  if (await activeBracketExistsForDivision(game.tournament_id, game.division)) {
    return { ok: false, reason: "Seeding score is locked because an active bracket exists for this division" };
  }

  const winnerId = input.team1Score === input.team2Score ? null : input.team1Score > input.team2Score ? game.team_1_id : game.team_2_id;
  const loserId = winnerId === null ? null : winnerId === game.team_1_id ? game.team_2_id : game.team_1_id;
  const wasComplete = (game.team_1_score !== null && game.team_2_score !== null) || game.result_type === "forfeit";
  const changed =
    game.team_1_score !== input.team1Score ||
    game.team_2_score !== input.team2Score ||
    game.result_type !== "score";

  if (!changed) return { ok: true, changed: false, kind: "seeding", gameId: game.id };

  await exec(
    `UPDATE games
        SET team_1_score = $1,
            team_2_score = $2,
            winner_team_id = $3,
            loser_team_id = $4,
            result_type = 'score',
            forfeit_team_id = NULL,
            scored_by = $5,
            scored_at = NOW()
      WHERE id = $6`,
    [input.team1Score, input.team2Score, winnerId, loserId, input.scoredBy, game.id]
  );
  if (!wasComplete) await completeAndAdvanceCourtGame(game.id);
  return { ok: true, changed: true, kind: "seeding", gameId: game.id };
}

export async function scoreBracketGameFromSync(input: {
  bracketGameId: number;
  team1Score: number;
  team2Score: number;
}): Promise<ScoreSyncResult> {
  if (!validScore(input.team1Score) || !validScore(input.team2Score)) return { ok: false, reason: "Invalid score" };
  if (input.team1Score === input.team2Score) return { ok: false, reason: "Bracket games cannot end in a tie" };

  const [game] = await query<{
    tournament_id: number;
    team_1_score: number | null;
    team_2_score: number | null;
    result_type: string | null;
  }>(
    `SELECT brackets.tournament_id, bracket_games.team_1_score, bracket_games.team_2_score, bracket_games.result_type
       FROM bracket_games
       JOIN brackets ON brackets.id = bracket_games.bracket_id
      WHERE bracket_games.id = $1`,
    [input.bracketGameId]
  );
  if (!game) return { ok: false, reason: "Bracket game not found" };
  if (!(await tournamentIsEditable(game.tournament_id))) return { ok: false, reason: "Tournament is locked" };

  const wasComplete = (game.team_1_score !== null && game.team_2_score !== null) || game.result_type === "forfeit";
  const changed =
    game.team_1_score !== input.team1Score ||
    game.team_2_score !== input.team2Score ||
    game.result_type !== "score";
  if (!changed) return { ok: true, changed: false, kind: "bracket", gameId: input.bracketGameId };

  const scheduleSlot = (await getActiveBracketScheduleSlots(game.tournament_id)).get(input.bracketGameId);
  await scoreBracketGame(input.bracketGameId, input.team1Score, input.team2Score);

  const [updated] = await query<{ team_1_score: number | null; team_2_score: number | null; result_type: string | null }>(
    "SELECT team_1_score, team_2_score, result_type FROM bracket_games WHERE id = $1",
    [input.bracketGameId]
  );
  const isComplete = Boolean(
    updated && ((updated.team_1_score !== null && updated.team_2_score !== null) || updated.result_type === "forfeit")
  );
  const didUpdate =
    updated?.team_1_score === input.team1Score &&
    updated?.team_2_score === input.team2Score &&
    updated?.result_type === "score";

  if (!didUpdate) return { ok: false, reason: "Bracket score was blocked by downstream results" };
  if (!wasComplete && isComplete && scheduleSlot?.schedule_game_id) {
    await completeAndAdvanceCourtGame(scheduleSlot.schedule_game_id);
  }
  return { ok: true, changed: true, kind: "bracket", gameId: input.bracketGameId };
}

async function bracketGameIdForScheduleGame(tournamentId: number, scheduleGameId: number) {
  const slots = await getActiveBracketScheduleSlots(tournamentId);
  for (const [bracketGameId, slot] of slots) {
    if (slot.schedule_game_id === scheduleGameId) return bracketGameId;
  }
  return null;
}
