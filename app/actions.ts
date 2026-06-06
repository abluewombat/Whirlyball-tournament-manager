"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { createSnapshot, exec, listTournamentDivisions, query, restoreSnapshot, SHIRT_SIZES, withTransaction } from "@/lib/db";
import {
  loginAdmin,
  loginCenter,
  loginScorekeeper,
  logoutAdmin,
  logoutCenter,
  logoutScorekeeper,
  requireAdmin,
  requireCenterId,
  requireScorekeeperOrAdmin
} from "@/lib/auth";
import { hashSecret } from "@/lib/security";
import { generateSchedule } from "@/lib/schedule";
import { scheduleDefaults } from "@/lib/schedule-defaults";
import {
  activeBracketExistsForDivision,
  forfeitBracketGame,
  getActiveBracketScheduleSlots,
  rebuildBracketForDivision,
  recordedScoreCount,
  resetBracketGameScore,
  scoredTournamentResultCountForDivision,
  scoreBracketGame,
  syncActiveBracketsToSchedule
} from "@/lib/brackets";
import { currentTournament, currentTournamentId, normalizePersonName, tournamentPath } from "@/lib/tournaments";
import { completeAndAdvanceCourtGame, saveCourtStream, youtubeVideoId } from "@/lib/streams";

function text(formData: FormData, key: string) {
  return String(formData.get(key) || "").trim();
}

function num(formData: FormData, key: string, fallback = 0) {
  const value = Number(formData.get(key));
  return Number.isFinite(value) ? value : fallback;
}

function validScore(value: number) {
  return Number.isInteger(value) && value >= 0;
}

function checkbox(formData: FormData, key: string) {
  return formData.get(key) === "on";
}

function dateTimeMs(value: string) {
  return Date.parse(`${value.length === 16 ? `${value}:00` : value}Z`);
}

async function safeDivision(tournamentId: number, value: string) {
  const divisions = await listTournamentDivisions(tournamentId);
  return divisions.some((division) => division.name === value) ? value : divisions.find((division) => !division.is_exhibition)?.name || divisions[0]?.name || "D";
}

function safeSize(value: string) {
  return SHIRT_SIZES.includes(value as never) ? value : "L";
}

export async function centerLoginAction(formData: FormData) {
  const ok = await loginCenter(num(formData, "center_id"), text(formData, "passcode"));
  if (!ok) redirect("/center?error=1");
  redirect("/center/dashboard");
}

export async function centerLogoutAction() {
  await logoutCenter();
  redirect("/center");
}

export async function scorekeeperLoginAction(formData: FormData) {
  const tournamentId = await currentTournamentId(text(formData, "tournament_id") || null);
  const ok = await loginScorekeeper(tournamentId, text(formData, "passcode"));
  if (!ok) redirect("/score?error=1");
  redirect("/score");
}

export async function scorekeeperLogoutAction() {
  await logoutScorekeeper();
  redirect("/score");
}

export async function adminLoginAction(formData: FormData) {
  const ok = await loginAdmin(text(formData, "password"));
  if (!ok) redirect("/admin?error=1");
  redirect("/admin/dashboard");
}

export async function adminLogoutAction() {
  await logoutAdmin();
  redirect("/admin");
}

export async function addTeamAction(formData: FormData) {
  const tournamentId = await currentTournamentId(text(formData, "tournament_id") || null);
  if (!(await ensureTournamentEditable(tournamentId))) return;
  const centerId = formData.has("center_id") ? num(formData, "center_id") : await requireCenterId();
  if (formData.has("center_id")) await requireAdmin();
  const name = text(formData, "name");
  if (!name) return;
  await exec(
    `INSERT INTO teams (tournament_id, center_id, division, name, early_available)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT DO NOTHING`,
    [tournamentId, centerId, await safeDivision(tournamentId, text(formData, "division")), name, checkbox(formData, "early_available")]
  );
  revalidatePath("/");
  revalidatePath("/center/dashboard");
  revalidatePath("/admin/dashboard");
}

export async function updateTeamAction(formData: FormData) {
  const adminEdit = formData.has("admin");
  if (adminEdit) await requireAdmin();
  const centerId = adminEdit ? null : await requireCenterId();
  const teamId = num(formData, "team_id");
  const [team] = await query<{ tournament_id: number }>("SELECT tournament_id FROM teams WHERE id = $1", [teamId]);
  if (!team || !(await ensureTournamentEditable(team.tournament_id))) return;
  await exec(
    `UPDATE teams
     SET name = $1, division = $2, early_available = $3, updated_at = NOW()
     WHERE id = $4 ${adminEdit ? "" : "AND center_id = $5"}`,
    adminEdit
      ? [text(formData, "name"), await safeDivision(team.tournament_id, text(formData, "division")), checkbox(formData, "early_available"), teamId]
      : [text(formData, "name"), await safeDivision(team.tournament_id, text(formData, "division")), checkbox(formData, "early_available"), teamId, centerId]
  );
  revalidatePath("/");
  revalidatePath("/center/dashboard");
  revalidatePath("/admin/dashboard");
}

export async function addTeamAvailabilityBlockAction(formData: FormData) {
  const adminEdit = formData.has("admin");
  if (adminEdit) await requireAdmin();
  const centerId = adminEdit ? null : await requireCenterId();
  const teamId = num(formData, "team_id");
  const [targetTeam] = await query<{ tournament_id: number }>("SELECT tournament_id FROM teams WHERE id = $1", [teamId]);
  if (!targetTeam || !(await ensureTournamentEditable(targetTeam.tournament_id))) return;
  if (!adminEdit) {
    const owned = await query("SELECT id FROM teams WHERE id = $1 AND center_id = $2 AND deleted_at IS NULL", [teamId, centerId]);
    if (!owned.length) return;
  }

  const startsAt = text(formData, "starts_at");
  const endsAt = text(formData, "ends_at");
  const startMs = dateTimeMs(startsAt);
  const endMs = dateTimeMs(endsAt);
  if (!startsAt || !endsAt || Number.isNaN(startMs) || Number.isNaN(endMs) || endMs <= startMs) return;

  await exec("INSERT INTO team_availability_blocks (team_id, starts_at, ends_at, reason) VALUES ($1, $2, $3, $4)", [
    teamId,
    startsAt,
    endsAt,
    text(formData, "reason") || null
  ]);
  revalidatePath("/center/dashboard");
  revalidatePath("/admin/dashboard");
  revalidatePath("/admin/schedule");
}

export async function deleteTeamAvailabilityBlockAction(formData: FormData) {
  const adminEdit = formData.has("admin");
  if (adminEdit) await requireAdmin();
  const centerId = adminEdit ? null : await requireCenterId();
  const blockId = num(formData, "block_id");
  const [block] = await query<{ tournament_id: number }>(
    "SELECT teams.tournament_id FROM team_availability_blocks JOIN teams ON teams.id = team_availability_blocks.team_id WHERE team_availability_blocks.id = $1",
    [blockId]
  );
  if (!block || !(await ensureTournamentEditable(block.tournament_id))) return;
  await exec(
    `DELETE FROM team_availability_blocks
     WHERE id = $1 ${
       adminEdit
         ? ""
         : `AND EXISTS (
              SELECT 1 FROM teams
              WHERE teams.id = team_availability_blocks.team_id
                AND teams.center_id = $2
            )`
     }`,
    adminEdit ? [blockId] : [blockId, centerId]
  );
  revalidatePath("/center/dashboard");
  revalidatePath("/admin/dashboard");
  revalidatePath("/admin/schedule");
}

export async function softDeleteTeamAction(formData: FormData) {
  const adminEdit = formData.has("admin");
  if (adminEdit) await requireAdmin();
  const centerId = adminEdit ? null : await requireCenterId();
  const teamId = num(formData, "team_id");
  const [team] = await query<{ tournament_id: number }>("SELECT tournament_id FROM teams WHERE id = $1", [teamId]);
  if (!team || !(await ensureTournamentEditable(team.tournament_id))) return;
  await exec(
    `UPDATE teams SET deleted_at = NOW() WHERE id = $1 ${adminEdit ? "" : "AND center_id = $2"}`,
    adminEdit ? [teamId] : [teamId, centerId]
  );
  revalidatePath("/");
  revalidatePath("/center/dashboard");
  revalidatePath("/admin/dashboard");
}

export async function restoreTeamAction(formData: FormData) {
  await requireAdmin();
  const teamId = num(formData, "team_id");
  const [team] = await query<{ tournament_id: number }>("SELECT tournament_id FROM teams WHERE id = $1", [teamId]);
  if (!team || !(await ensureTournamentEditable(team.tournament_id))) return;
  await exec("UPDATE teams SET deleted_at = NULL WHERE id = $1", [teamId]);
  revalidatePath("/");
  revalidatePath("/admin/dashboard");
}

export async function addPlayerAction(formData: FormData) {
  const adminEdit = formData.has("admin");
  if (adminEdit) await requireAdmin();
  const centerId = adminEdit ? null : await requireCenterId();
  const teamId = num(formData, "team_id");
  if (!adminEdit) {
    const team = await query("SELECT id FROM teams WHERE id = $1 AND center_id = $2 AND deleted_at IS NULL", [teamId, centerId]);
    if (!team.length) return;
  }
  const [team] = await query<{ tournament_id: number; center_id: number | null; division: string }>(
    "SELECT tournament_id, center_id, division FROM teams WHERE id = $1 AND deleted_at IS NULL",
    [teamId]
  );
  if (!team || team.center_id === null || !(await ensureTournamentEditable(team.tournament_id))) return;
  const [existing] = await query<{ count: string }>("SELECT COUNT(*) as count FROM players WHERE team_id = $1 AND deleted_at IS NULL", [teamId]);
  if (Number(existing?.count || 0) >= 5) return;
  const name = text(formData, "name");
  await withTransaction(async (client) => {
    const personResult = await client.query<{ id: number }>(
      `INSERT INTO people (center_id, name, normalized_name)
       VALUES ($1, $2, $3)
       ON CONFLICT (center_id, normalized_name)
       DO UPDATE SET name = EXCLUDED.name, updated_at = NOW()
       RETURNING id`,
      [team.center_id, name, normalizePersonName(name)]
    );
    await client.query(
      `INSERT INTO players (tournament_id, person_id, team_id, name, shirt_size, notes)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [team.tournament_id, personResult.rows[0].id, teamId, name, safeSize(text(formData, "shirt_size")), text(formData, "notes") || null]
    );
  });
  revalidatePath("/");
  revalidatePath("/center/dashboard");
  revalidatePath("/admin/dashboard");
}

export async function updatePlayerAction(formData: FormData) {
  const adminEdit = formData.has("admin");
  if (adminEdit) await requireAdmin();
  const requiredCenterId = adminEdit ? null : await requireCenterId();
  const playerId = num(formData, "player_id");
  const [targetPlayer] = await query<{ tournament_id: number }>("SELECT tournament_id FROM players WHERE id = $1", [playerId]);
  if (!targetPlayer || !(await ensureTournamentEditable(targetPlayer.tournament_id))) return;
  if (!adminEdit) {
    const owned = await query(
      `SELECT players.id FROM players
       JOIN teams ON teams.id = players.team_id
       WHERE players.id = $1 AND teams.center_id = $2`,
      [playerId, requiredCenterId]
    );
    if (!owned.length) return;
  }
  const name = text(formData, "name");
  await withTransaction(async (client) => {
    const playerResult = await client.query<{ person_id: number | null }>("SELECT person_id FROM players WHERE id = $1", [playerId]);
    await client.query(
      `UPDATE players
       SET name = $1, shirt_size = $2, entry_paid = $3, entry_amount = $4, entry_paid_date = $5,
           entry_payment_method = $6, notes = $7, updated_at = NOW()
       WHERE id = $8`,
      [
        name,
        safeSize(text(formData, "shirt_size")),
        checkbox(formData, "entry_paid"),
        num(formData, "entry_amount"),
        text(formData, "entry_paid_date") || null,
        text(formData, "entry_payment_method") || null,
        text(formData, "notes") || null,
        playerId
      ]
    );
    const personId = playerResult.rows[0]?.person_id;
    if (personId) {
      await client.query("UPDATE people SET name = $1, normalized_name = $2, updated_at = NOW() WHERE id = $3", [
        name,
        normalizePersonName(name),
        personId
      ]);
      await client.query("UPDATE players SET name = $1, updated_at = NOW() WHERE person_id = $2", [name, personId]);
    }
  });
  revalidatePath("/");
  revalidatePath("/center/dashboard");
  revalidatePath("/admin/dashboard");
}

export async function softDeletePlayerAction(formData: FormData) {
  const adminEdit = formData.has("admin");
  if (adminEdit) await requireAdmin();
  const centerId = adminEdit ? null : await requireCenterId();
  const playerId = num(formData, "player_id");
  const [targetPlayer] = await query<{ tournament_id: number }>("SELECT tournament_id FROM players WHERE id = $1", [playerId]);
  if (!targetPlayer || !(await ensureTournamentEditable(targetPlayer.tournament_id))) return;
  if (!adminEdit) {
    const owned = await query("SELECT players.id FROM players JOIN teams ON teams.id = players.team_id WHERE players.id = $1 AND teams.center_id = $2", [
      playerId,
      centerId
    ]);
    if (!owned.length) return;
  }
  await exec("UPDATE players SET deleted_at = NOW() WHERE id = $1", [playerId]);
  revalidatePath("/");
  revalidatePath("/center/dashboard");
  revalidatePath("/admin/dashboard");
}

export async function addShirtOrderAction(formData: FormData) {
  const adminEdit = formData.has("admin");
  if (adminEdit) await requireAdmin();
  const centerId = adminEdit ? null : await requireCenterId();
  const playerId = num(formData, "player_id");
  const [targetPlayer] = await query<{ tournament_id: number }>("SELECT tournament_id FROM players WHERE id = $1", [playerId]);
  if (!targetPlayer || !(await ensureTournamentEditable(targetPlayer.tournament_id))) return;
  if (!adminEdit) {
    const owned = await query("SELECT players.id FROM players JOIN teams ON teams.id = players.team_id WHERE players.id = $1 AND teams.center_id = $2", [
      playerId,
      centerId
    ]);
    if (!owned.length) return;
  }
  await exec(
    `INSERT INTO shirt_orders (player_id, size, quantity, paid, amount, paid_date, payment_method, notes)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [
      playerId,
      safeSize(text(formData, "size")),
      Math.max(1, num(formData, "quantity", 1)),
      checkbox(formData, "paid"),
      num(formData, "amount"),
      text(formData, "paid_date") || null,
      text(formData, "payment_method") || null,
      text(formData, "notes") || null
    ]
  );
  revalidatePath("/center/dashboard");
  revalidatePath("/admin/dashboard");
}

export async function setCenterPasscodeAction(formData: FormData) {
  await requireAdmin();
  const passcode = text(formData, "passcode");
  if (passcode) {
    await exec("UPDATE centers SET passcode_hash = $1 WHERE id = $2", [hashSecret(passcode), num(formData, "center_id")]);
  }
  revalidatePath("/admin/dashboard");
}

export async function setScorekeeperPasscodeAction(formData: FormData) {
  await requireAdmin();
  const tournamentId = await currentTournamentId(text(formData, "tournament_id") || null);
  const passcode = text(formData, "passcode");
  if (passcode) {
    await exec("UPDATE tournament_settings SET scorekeeper_passcode_hash = $1, updated_at = NOW() WHERE tournament_id = $2", [
      hashSecret(passcode),
      tournamentId
    ]);
  }
  revalidatePath("/admin/dashboard");
}

export async function updateAnnouncementAction(formData: FormData) {
  await requireAdmin();
  const tournamentId = await currentTournamentId(text(formData, "tournament_id") || null);
  await exec("UPDATE tournament_settings SET announcement = $1, updated_at = NOW() WHERE tournament_id = $2", [
    text(formData, "announcement") || null,
    tournamentId
  ]);
  revalidatePath("/");
  revalidatePath("/schedule");
  revalidatePath("/brackets");
}

export async function submitBlockerRequestAction(formData: FormData) {
  const teamId = num(formData, "team_id");
  const startsAt = text(formData, "starts_at");
  const endsAt = text(formData, "ends_at");
  const startMs = dateTimeMs(startsAt);
  const endMs = dateTimeMs(endsAt);
  if (!teamId || !startsAt || !endsAt || Number.isNaN(startMs) || Number.isNaN(endMs) || endMs <= startMs) redirect("/requests?error=1");
  const [team] = await query<{ tournament_id: number }>("SELECT tournament_id FROM teams WHERE id = $1", [teamId]);
  if (!team) redirect("/requests?error=1");
  await exec("INSERT INTO blocker_requests (tournament_id, team_id, starts_at, ends_at, reason) VALUES ($1, $2, $3, $4, $5)", [
    team.tournament_id,
    teamId,
    startsAt,
    endsAt,
    text(formData, "reason") || null
  ]);
  redirect("/requests?submitted=1");
}

export async function reviewBlockerRequestAction(formData: FormData) {
  await requireAdmin();
  const requestId = num(formData, "request_id");
  const decision = text(formData, "decision") === "approved" ? "approved" : "rejected";
  const [request] = await query<{ team_id: number; starts_at: string; ends_at: string; reason: string | null }>("SELECT * FROM blocker_requests WHERE id = $1", [
    requestId
  ]);
  if (!request) return;
  await withTransaction(async (client) => {
    await client.query("UPDATE blocker_requests SET status = $1, reviewed_at = NOW() WHERE id = $2", [decision, requestId]);
    if (decision === "approved") {
      await client.query("INSERT INTO team_availability_blocks (team_id, starts_at, ends_at, reason) VALUES ($1, $2, $3, $4)", [
        request.team_id,
        request.starts_at,
        request.ends_at,
        request.reason
      ]);
    }
  });
  revalidatePath("/admin/dashboard");
  revalidatePath("/admin/schedule");
}

export async function snapshotAction(formData: FormData) {
  await requireAdmin();
  const tournamentId = await currentTournamentId(text(formData, "tournament_id") || null);
  await createSnapshot(tournamentId, text(formData, "label") || "Manual snapshot");
  revalidatePath("/admin/dashboard");
}

export async function restoreSnapshotAction(formData: FormData) {
  await requireAdmin();
  const tournamentId = await currentTournamentId(text(formData, "tournament_id") || null);
  await restoreSnapshot(tournamentId, num(formData, "snapshot_id"));
  revalidatePath("/");
  revalidatePath("/admin/dashboard");
}

export async function generateScheduleAction(formData: FormData) {
  await requireAdmin();
  const tournament = await currentTournament(text(formData, "tournament_id") || null);
  if (!(await ensureTournamentEditable(tournament.id))) return;
  const divisions = await listTournamentDivisions(tournament.id);
  if ((await recordedScoreCount(tournament.id)) > 0) redirect(`/admin/schedule?tournament=${tournament.slug}&locked=scores`);
  const targetGamesPerTeam = Math.max(scheduleDefaults.targetGamesPerTeam, num(formData, "target_games_per_team", scheduleDefaults.targetGamesPerTeam));
  const scheduleInput = {
    tournamentId: tournament.id,
    divisions: divisions.map((division) => division.name),
    exhibitionDivision: divisions.find((division) => division.is_exhibition)?.name || null,
    startDate: text(formData, "start_date") || scheduleDefaults.startDate,
    endDate: text(formData, "end_date") || scheduleDefaults.endDate,
    dayStart: text(formData, "day_start") || scheduleDefaults.dayStart,
    earlyDayStart: text(formData, "early_day_start") || scheduleDefaults.earlyDayStart,
    dayEnd: text(formData, "day_end") || scheduleDefaults.dayEnd,
    courts: Math.max(1, num(formData, "courts", scheduleDefaults.courts)),
    seedingMinutes: Math.max(10, num(formData, "seeding_minutes", scheduleDefaults.seedingMinutes)),
    tournamentMinutes: Math.max(10, num(formData, "tournament_minutes", scheduleDefaults.tournamentMinutes)),
    tournamentDayStart: text(formData, "tournament_day_start") || text(formData, "day_start") || scheduleDefaults.tournamentDayStart,
    tournamentDayEnd: text(formData, "tournament_day_end") || scheduleDefaults.tournamentDayEnd,
    finalDayEnd: text(formData, "final_day_end") || scheduleDefaults.finalDayEnd,
    roundsPerPair: Math.max(1, num(formData, "rounds_per_pair", scheduleDefaults.roundsPerPair)),
    seedingMode: (text(formData, "seeding_mode") === "round_robin" ? "round_robin" : "balanced") as "round_robin" | "balanced",
    targetGamesPerTeam,
    divisionTargetGames: text(formData, "division_target_games"),
    includeTuesday: true,
    blockOrder: text(formData, "block_order") || scheduleDefaults.blockOrder,
    blockRows: Math.max(1, num(formData, "block_rows", scheduleDefaults.blockRows)),
    preTournamentCutoff: text(formData, "pre_tournament_cutoff") || scheduleDefaults.preTournamentCutoff,
    unlimitedGameStart: text(formData, "unlimited_game_start") || scheduleDefaults.unlimitedGameStart,
    unlimitedCourt: Math.max(1, num(formData, "unlimited_court", scheduleDefaults.unlimitedCourt)),
    morningRestRows: Math.max(0, num(formData, "morning_rest_rows", scheduleDefaults.morningRestRows)),
    lateNightRows: Math.max(0, num(formData, "late_night_rows", scheduleDefaults.lateNightRows))
  };
  const result = await generateSchedule(scheduleInput);
  await exec("UPDATE tournament_settings SET schedule_settings_json = $1::jsonb, updated_at = NOW() WHERE tournament_id = $2", [
    JSON.stringify(scheduleInput),
    tournament.id
  ]);
  await withTransaction(async (client) => {
    await client.query("DELETE FROM brackets WHERE tournament_id = $1", [tournament.id]);
    await client.query("DELETE FROM games WHERE tournament_id = $1", [tournament.id]);
    await client.query("DELETE FROM court_streams WHERE tournament_id = $1", [tournament.id]);
    for (const game of result.games) {
      await client.query(
        `INSERT INTO games (tournament_id, phase, division, court, starts_at, team_1_id, team_2_id, ref_team_id, label)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [tournament.id, game.phase, game.division, game.court, game.startsAt, game.team1Id, game.team2Id, game.refTeamId, game.label]
      );
    }
  });
  await syncActiveBracketsToSchedule(tournament.id);
  revalidatePath("/admin/schedule");
  revalidatePath("/schedule");
  redirect(
    `/admin/schedule?tournament=${tournament.slug}&generated=${result.games.length}&seeding_scheduled=${result.scheduledSeedingGames}&seeding_target=${result.targetSeedingGames}&unscheduled=${result.unscheduledSeedingGames}&unscheduled_tournament=${result.unscheduledTournamentGames}&target_games=${targetGamesPerTeam}`
  );
}

export async function moveScheduleGameAction(input: { gameId: number; startsAt: string; court: number }) {
  await requireAdmin();
  const gameId = Number(input.gameId);
  const targetCourt = Number(input.court);
  const targetStartsAt = String(input.startsAt || "");
  if (!Number.isInteger(gameId) || gameId <= 0 || !targetStartsAt || !Number.isInteger(targetCourt) || targetCourt < 1) return;

  const [source] = await query<{
    id: number;
    tournament_id: number;
    starts_at: string;
    court: number;
    team_1_score: number | null;
    team_2_score: number | null;
    result_type: string | null;
    stream_id: number | null;
    actual_started_at: string | null;
  }>(
    `SELECT id, tournament_id, starts_at, court, team_1_score, team_2_score, result_type,
            stream_id, actual_started_at
     FROM games
     WHERE id = $1`,
    [gameId]
  );
  if (!source) return;
  if (!(await ensureTournamentEditable(source.tournament_id))) return;
  if (source.team_1_score !== null || source.team_2_score !== null || source.result_type === "forfeit") return;
  if (source.stream_id !== null || source.actual_started_at !== null) return;
  if (source.starts_at === targetStartsAt && source.court === targetCourt) return;

  const [target] = await query<{
    id: number;
    team_1_score: number | null;
    team_2_score: number | null;
    result_type: string | null;
    stream_id: number | null;
    actual_started_at: string | null;
  }>(
    `SELECT id, team_1_score, team_2_score, result_type, stream_id, actual_started_at
     FROM games
     WHERE tournament_id = $1 AND starts_at = $2 AND court = $3 AND id <> $4
     ORDER BY id
     LIMIT 1`,
    [source.tournament_id, targetStartsAt, targetCourt, gameId]
  );
  if (target && (target.team_1_score !== null || target.team_2_score !== null || target.result_type === "forfeit")) return;
  if (target && (target.stream_id !== null || target.actual_started_at !== null)) return;

  await withTransaction(async (client) => {
    if (target) {
      await client.query("UPDATE games SET starts_at = $1, court = $2 WHERE id = $3", [source.starts_at, source.court, target.id]);
    }
    await client.query("UPDATE games SET starts_at = $1, court = $2 WHERE id = $3", [targetStartsAt, targetCourt, gameId]);
  });

  revalidatePath("/admin/schedule");
  revalidatePath("/schedule");
}

export async function saveCourtStreamAction(formData: FormData) {
  const tournamentId = await currentTournamentId(text(formData, "tournament_id") || null);
  if (!(await ensureTournamentEditable(tournamentId))) return;
  await requireScorekeeperOrAdmin(tournamentId);
  const court = num(formData, "court");
  const streamDate = text(formData, "stream_date");
  const youtubeUrl = text(formData, "youtube_url");
  if (
    !Number.isInteger(court) ||
    court < 1 ||
    !/^\d{4}-\d{2}-\d{2}$/.test(streamDate) ||
    !youtubeVideoId(youtubeUrl)
  ) {
    redirect("/score?stream_error=1");
  }
  const streamId = await saveCourtStream({ tournamentId, court, streamDate, youtubeUrl });
  if (!streamId) redirect("/score?stream_error=1");
  revalidatePath("/");
  revalidatePath("/score");
  revalidatePath("/schedule");
  redirect("/score?stream_saved=1");
}

export async function submitGameScoreAction(formData: FormData) {
  const gameId = num(formData, "game_id");
  const team1Score = num(formData, "team_1_score");
  const team2Score = num(formData, "team_2_score");
  if (!validScore(team1Score) || !validScore(team2Score)) return;
  const [game] = await query<{
    tournament_id: number;
    phase: string;
    division: string;
    team_1_id: number | null;
    team_2_id: number | null;
    team_1_score: number | null;
    team_2_score: number | null;
    result_type: string | null;
  }>(
    "SELECT * FROM games WHERE id = $1",
    [gameId]
  );
  if (!game || game.team_1_id === null || game.team_2_id === null) return;
  if (!(await ensureTournamentEditable(game.tournament_id))) return;
  await requireScorekeeperOrAdmin(game.tournament_id);
  if (game.phase === "tournament") return;
  if (game.phase === "seeding" && (await activeBracketExistsForDivision(game.tournament_id, game.division))) return;
  const winnerId = team1Score === team2Score ? null : team1Score > team2Score ? game.team_1_id : game.team_2_id;
  const loserId = winnerId === null ? null : winnerId === game.team_1_id ? game.team_2_id : game.team_1_id;
  const wasComplete = (game.team_1_score !== null && game.team_2_score !== null) || game.result_type === "forfeit";
  await exec(
    `UPDATE games
     SET team_1_score = $1, team_2_score = $2, winner_team_id = $3, loser_team_id = $4,
         result_type = 'score', forfeit_team_id = NULL, scored_by = 'scorekeeper', scored_at = NOW()
     WHERE id = $5`,
    [team1Score, team2Score, winnerId, loserId, gameId]
  );
  if (!wasComplete) await completeAndAdvanceCourtGame(gameId);
  revalidatePath("/");
  revalidatePath("/score");
  revalidatePath("/schedule");
  revalidatePath("/standings");
  revalidatePath("/brackets");
}

export async function resetGameScoreAction(formData: FormData) {
  const gameId = num(formData, "game_id");
  const [game] = await query<{ tournament_id: number; phase: string; division: string }>(
    "SELECT tournament_id, phase, division FROM games WHERE id = $1",
    [gameId]
  );
  if (!game) return;
  if (!(await ensureTournamentEditable(game.tournament_id))) return;
  await requireScorekeeperOrAdmin(game.tournament_id);
  if (game?.phase === "tournament") return;
  if (game?.phase === "seeding" && (await activeBracketExistsForDivision(game.tournament_id, game.division))) return;
  await exec(
    `UPDATE games
     SET team_1_score = NULL, team_2_score = NULL, winner_team_id = NULL, loser_team_id = NULL,
         result_type = NULL, forfeit_team_id = NULL, scored_by = NULL, scored_at = NULL
     WHERE id = $1`,
    [gameId]
  );
  if (game?.phase === "seeding") {
    await exec(
      "UPDATE brackets SET status = 'archived', updated_at = NOW() WHERE tournament_id = $1 AND division = $2 AND status = 'active'",
      [game.tournament_id, game.division]
    );
  }
  revalidatePath("/score");
  revalidatePath("/schedule");
  revalidatePath("/standings");
  revalidatePath("/brackets");
}

export async function submitGameForfeitAction(formData: FormData) {
  const gameId = num(formData, "game_id");
  const forfeitingTeamId = num(formData, "forfeit_team_id");
  const [game] = await query<{
    tournament_id: number;
    phase: string;
    division: string;
    team_1_id: number | null;
    team_2_id: number | null;
    team_1_score: number | null;
    team_2_score: number | null;
    result_type: string | null;
  }>(
    "SELECT * FROM games WHERE id = $1",
    [gameId]
  );
  if (!game || game.team_1_id === null || game.team_2_id === null) return;
  if (!(await ensureTournamentEditable(game.tournament_id))) return;
  await requireScorekeeperOrAdmin(game.tournament_id);
  if (game.phase === "tournament") return;
  if (game.phase === "seeding" && (await activeBracketExistsForDivision(game.tournament_id, game.division))) return;
  if (forfeitingTeamId !== game.team_1_id && forfeitingTeamId !== game.team_2_id) return;
  const winnerId = forfeitingTeamId === game.team_1_id ? game.team_2_id : game.team_1_id;
  const wasComplete = (game.team_1_score !== null && game.team_2_score !== null) || game.result_type === "forfeit";
  await exec(
    `UPDATE games
     SET team_1_score = NULL, team_2_score = NULL, winner_team_id = $1, loser_team_id = $2,
         result_type = 'forfeit', forfeit_team_id = $2, scored_by = 'scorekeeper', scored_at = NOW()
     WHERE id = $3`,
    [winnerId, forfeitingTeamId, gameId]
  );
  if (!wasComplete) await completeAndAdvanceCourtGame(gameId);
  revalidatePath("/");
  revalidatePath("/score");
  revalidatePath("/schedule");
  revalidatePath("/standings");
  revalidatePath("/brackets");
}

export async function generateBracketAction(formData: FormData) {
  const tournamentId = await currentTournamentId(text(formData, "tournament_id") || null);
  if (!(await ensureTournamentEditable(tournamentId))) return;
  await requireScorekeeperOrAdmin(tournamentId);
  const [remaining] = await query<{ count: string }>(
    `SELECT COUNT(*) as count
     FROM games
     WHERE tournament_id = $1
       AND phase = 'seeding'
       AND division <> 'Unlimited'
       AND team_1_id IS NOT NULL
       AND team_2_id IS NOT NULL
       AND result_type IS DISTINCT FROM 'forfeit'
       AND (team_1_score IS NULL OR team_2_score IS NULL)`,
    [tournamentId]
  );
  if (Number(remaining?.count || 0) > 0) return;

  const divisions = await query<{ division: string }>(
    `SELECT DISTINCT division
     FROM games
     WHERE tournament_id = $1
       AND phase = 'seeding'
       AND division <> 'Unlimited'
       AND team_1_id IS NOT NULL
       AND team_2_id IS NOT NULL
     ORDER BY division`,
    [tournamentId]
  );
  for (const { division } of divisions) await rebuildBracketForDivision(tournamentId, division);
  await syncActiveBracketsToSchedule(tournamentId);
  revalidatePath("/score");
  revalidatePath("/brackets");
  revalidatePath("/schedule");
}

export async function syncScheduleFromBracketsAction(formData: FormData) {
  const tournamentId = await currentTournamentId(text(formData, "tournament_id") || null);
  if (!(await ensureTournamentEditable(tournamentId))) return;
  await requireScorekeeperOrAdmin(tournamentId);
  await syncActiveBracketsToSchedule(tournamentId);
  revalidatePath("/score");
  revalidatePath("/brackets");
  revalidatePath("/schedule");
}

export async function submitBracketScoreAction(formData: FormData) {
  const bracketGameId = num(formData, "bracket_game_id");
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
    [bracketGameId]
  );
  if (!game) return;
  if (!(await ensureTournamentEditable(game.tournament_id))) return;
  await requireScorekeeperOrAdmin(game.tournament_id);
  const scheduleSlot = (await getActiveBracketScheduleSlots(game.tournament_id)).get(bracketGameId);
  const wasComplete = (game.team_1_score !== null && game.team_2_score !== null) || game.result_type === "forfeit";
  await scoreBracketGame(bracketGameId, num(formData, "team_1_score"), num(formData, "team_2_score"));
  const [updated] = await query<{ team_1_score: number | null; team_2_score: number | null; result_type: string | null }>(
    "SELECT team_1_score, team_2_score, result_type FROM bracket_games WHERE id = $1",
    [bracketGameId]
  );
  const isComplete = Boolean(
    updated && ((updated.team_1_score !== null && updated.team_2_score !== null) || updated.result_type === "forfeit")
  );
  if (!wasComplete && isComplete && scheduleSlot?.schedule_game_id) {
    await completeAndAdvanceCourtGame(scheduleSlot.schedule_game_id);
  }
  revalidatePath("/");
  revalidatePath("/score");
  revalidatePath("/brackets");
  revalidatePath("/schedule");
}

export async function submitBracketForfeitAction(formData: FormData) {
  const bracketGameId = num(formData, "bracket_game_id");
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
    [bracketGameId]
  );
  if (!game) return;
  if (!(await ensureTournamentEditable(game.tournament_id))) return;
  await requireScorekeeperOrAdmin(game.tournament_id);
  const scheduleSlot = (await getActiveBracketScheduleSlots(game.tournament_id)).get(bracketGameId);
  const wasComplete = (game.team_1_score !== null && game.team_2_score !== null) || game.result_type === "forfeit";
  await forfeitBracketGame(bracketGameId, num(formData, "forfeit_team_id"));
  const [updated] = await query<{ team_1_score: number | null; team_2_score: number | null; result_type: string | null }>(
    "SELECT team_1_score, team_2_score, result_type FROM bracket_games WHERE id = $1",
    [bracketGameId]
  );
  const isComplete = Boolean(
    updated && ((updated.team_1_score !== null && updated.team_2_score !== null) || updated.result_type === "forfeit")
  );
  if (!wasComplete && isComplete && scheduleSlot?.schedule_game_id) {
    await completeAndAdvanceCourtGame(scheduleSlot.schedule_game_id);
  }
  revalidatePath("/");
  revalidatePath("/score");
  revalidatePath("/brackets");
  revalidatePath("/schedule");
}

export async function resetBracketScoreAction(formData: FormData) {
  const bracketGameId = num(formData, "bracket_game_id");
  const [game] = await query<{ tournament_id: number }>(
    "SELECT brackets.tournament_id FROM bracket_games JOIN brackets ON brackets.id = bracket_games.bracket_id WHERE bracket_games.id = $1",
    [bracketGameId]
  );
  if (!game) return;
  if (!(await ensureTournamentEditable(game.tournament_id))) return;
  await requireScorekeeperOrAdmin(game.tournament_id);
  await resetBracketGameScore(bracketGameId);
  revalidatePath("/score");
  revalidatePath("/brackets");
  revalidatePath("/schedule");
}

export async function rebuildBracketAction(formData: FormData) {
  await requireAdmin();
  const tournamentId = await currentTournamentId(text(formData, "tournament_id") || null);
  if (!(await ensureTournamentEditable(tournamentId))) return;
  const division = await safeDivision(tournamentId, text(formData, "division"));
  const divisionRows = await listTournamentDivisions(tournamentId);
  if (divisionRows.find((row) => row.name === division)?.is_exhibition) return;
  if ((await scoredTournamentResultCountForDivision(tournamentId, division)) > 0) return;
  await rebuildBracketForDivision(tournamentId, division);
  await syncActiveBracketsToSchedule(tournamentId);
  revalidatePath("/brackets");
  revalidatePath("/score");
  revalidatePath("/schedule");
}

function slugValue(value: string) {
  return value
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

async function ensureTournamentEditable(tournamentId: number) {
  const [tournament] = await query<{ editing_locked: boolean }>("SELECT editing_locked FROM tournaments WHERE id = $1", [tournamentId]);
  return Boolean(tournament && !tournament.editing_locked);
}

export async function createTournamentAction(formData: FormData) {
  await requireAdmin();
  const name = text(formData, "name");
  const slug = slugValue(text(formData, "slug") || name);
  const tournamentType = text(formData, "tournament_type") === "draft" ? "draft" : "nationals";
  const startsOn = text(formData, "starts_on");
  const endsOn = text(formData, "ends_on");
  if (!name || !slug || !startsOn || !endsOn || endsOn < startsOn) redirect("/admin/tournaments?error=invalid");
  const cloneId = num(formData, "clone_tournament_id");
  const draftDivisions = text(formData, "divisions")
    .split(",")
    .map((division) => division.trim())
    .filter(Boolean);
  const divisionNames = tournamentType === "nationals" ? ["A", "B", "C", "D", "Unlimited"] : draftDivisions.length ? draftDivisions : ["Upper", "Mid", "Lower"];

  let tournamentId = 0;
  try {
    tournamentId = await withTransaction(async (client) => {
      const result = await client.query<{ id: number }>(
        `INSERT INTO tournaments (
           name, slug, tournament_type, status, location, timezone,
           starts_on, ends_on, registration_deadline, featured
         )
         VALUES ($1, $2, $3, 'upcoming', $4, $5, $6, $7, $8, FALSE)
         RETURNING id`,
        [
          name,
          slug,
          tournamentType,
          text(formData, "location") || null,
          text(formData, "timezone") || "America/Detroit",
          startsOn,
          endsOn,
          text(formData, "registration_deadline") || null
        ]
      );
      const id = result.rows[0].id;
      for (const [index, division] of divisionNames.entries()) {
        await client.query(
          `INSERT INTO tournament_divisions (tournament_id, name, display_order, is_exhibition, public_label_hidden)
           VALUES ($1, $2, $3, $4, $5)`,
          [
            id,
            division,
            index,
            tournamentType === "nationals" && division === "Unlimited",
            tournamentType === "draft" && divisionNames.length === 1 && checkbox(formData, "hide_single_division")
          ]
        );
      }
      const sourceSettings = cloneId
        ? await client.query<{ scorekeeper_passcode_hash: string; schedule_settings_json: unknown }>(
            "SELECT scorekeeper_passcode_hash, schedule_settings_json FROM tournament_settings WHERE tournament_id = $1",
            [cloneId]
          )
        : await client.query<{ scorekeeper_passcode_hash: string; schedule_settings_json: unknown }>(
            "SELECT scorekeeper_passcode_hash, schedule_settings_json FROM tournament_settings ORDER BY updated_at DESC LIMIT 1"
          );
      await client.query(
        `INSERT INTO tournament_settings (tournament_id, scorekeeper_passcode_hash, schedule_settings_json)
         VALUES ($1, $2, $3::jsonb)`,
        [
          id,
          sourceSettings.rows[0]?.scorekeeper_passcode_hash || hashSecret("scorekeeper"),
          sourceSettings.rows[0]?.schedule_settings_json ? JSON.stringify(sourceSettings.rows[0].schedule_settings_json) : null
        ]
      );
      return id;
    });
  } catch {
    redirect("/admin/tournaments?error=slug");
  }
  revalidatePath("/admin/tournaments");
  redirect(`/admin/dashboard?tournament=${tournamentId}`);
}

export async function updateTournamentAction(formData: FormData) {
  await requireAdmin();
  const tournamentId = num(formData, "tournament_id");
  const name = text(formData, "name");
  const slug = slugValue(text(formData, "slug"));
  const startsOn = text(formData, "starts_on");
  const endsOn = text(formData, "ends_on");
  if (!tournamentId || !name || !slug || !startsOn || !endsOn || endsOn < startsOn) return;
  await exec(
    `UPDATE tournaments
     SET name = $1, slug = $2, location = $3, timezone = $4, starts_on = $5, ends_on = $6,
         registration_deadline = $7, updated_at = NOW()
     WHERE id = $8`,
    [
      name,
      slug,
      text(formData, "location") || null,
      text(formData, "timezone") || "America/Detroit",
      startsOn,
      endsOn,
      text(formData, "registration_deadline") || null,
      tournamentId
    ]
  );
  revalidatePath("/");
  revalidatePath("/admin/tournaments");
}

export async function activateTournamentAction(formData: FormData) {
  await requireAdmin();
  const tournamentId = num(formData, "tournament_id");
  await withTransaction(async (client) => {
    await client.query(
      "UPDATE tournaments SET status = 'past', featured = FALSE, editing_locked = TRUE, updated_at = NOW() WHERE status = 'active' AND id <> $1",
      [tournamentId]
    );
    await client.query(
      "UPDATE tournaments SET status = 'active', featured = TRUE, editing_locked = FALSE, updated_at = NOW() WHERE id = $1",
      [tournamentId]
    );
  });
  revalidatePath("/");
  revalidatePath("/admin/tournaments");
  redirect("/admin/dashboard");
}

export async function toggleTournamentEditingAction(formData: FormData) {
  await requireAdmin();
  await exec("UPDATE tournaments SET editing_locked = NOT editing_locked, updated_at = NOW() WHERE id = $1", [num(formData, "tournament_id")]);
  revalidatePath("/admin/tournaments");
}

export async function toggleDraftLockAction(formData: FormData) {
  await requireAdmin();
  const tournamentId = num(formData, "tournament_id");
  await exec(
    `UPDATE tournaments
     SET draft_locked = NOT draft_locked, updated_at = NOW()
     WHERE id = $1 AND tournament_type = 'draft'`,
    [tournamentId]
  );
  revalidatePath("/admin/draft");
  revalidatePath("/admin/tournaments");
}

export async function submitRegistrationRequestAction(formData: FormData) {
  const tournament = await currentTournament(text(formData, "tournament_id") || null);
  const registrationPath = tournamentPath(tournament, "/register");
  const centerId = num(formData, "center_id");
  const requestType = tournament.tournament_type === "draft" ? "individual" : text(formData, "request_type") === "team" ? "team" : "individual";
  const players = Array.from({ length: requestType === "team" ? 5 : 1 }, (_, index) => ({
    name: text(formData, `player_name_${index + 1}`),
    shirtSize: text(formData, `shirt_size_${index + 1}`) || null
  })).filter((player) => player.name);
  if (
    !centerId ||
    players.length === 0 ||
    tournament.status === "past" ||
    tournament.editing_locked ||
    tournament.draft_locked ||
    (tournament.registration_deadline && Date.now() > Date.parse(tournament.registration_deadline))
  ) {
    redirect(`${registrationPath}?error=closed`);
  }
  const submitterName = players[0].name;
  const [pending] = await query<{ id: number }>(
    `SELECT registration_requests.id
     FROM registration_requests
     JOIN registration_request_players ON registration_request_players.request_id = registration_requests.id
     WHERE registration_requests.tournament_id = $1
       AND registration_requests.center_id = $2
       AND registration_requests.status = 'pending'
       AND registration_request_players.is_submitter = TRUE
       AND LOWER(REGEXP_REPLACE(TRIM(registration_request_players.name), '\\s+', ' ', 'g')) = $3
     LIMIT 1`,
    [tournament.id, centerId, normalizePersonName(submitterName)]
  );
  if (pending) redirect(`${registrationPath}?error=pending`);

  await withTransaction(async (client) => {
    const requestResult = await client.query<{ id: number }>(
      `INSERT INTO registration_requests (
         tournament_id, center_id, request_type, proposed_team_name, requested_team_id,
         requested_division, submitted_by_name, notes
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING id`,
      [
        tournament.id,
        centerId,
        requestType,
        text(formData, "proposed_team_name") || null,
        num(formData, "requested_team_id") || null,
        text(formData, "requested_division") || null,
        submitterName,
        text(formData, "notes") || null
      ]
    );
    for (const [index, player] of players.entries()) {
      await client.query(
        `INSERT INTO registration_request_players (request_id, name, shirt_size, is_submitter)
         VALUES ($1, $2, $3, $4)`,
        [requestResult.rows[0].id, player.name, player.shirtSize, index === 0]
      );
    }
  });
  revalidatePath("/center/dashboard");
  redirect(`${registrationPath}?submitted=1`);
}

export async function reviewRegistrationRequestAction(formData: FormData) {
  const centerId = await requireCenterId();
  const requestId = num(formData, "request_id");
  const decision = text(formData, "decision") === "approved" ? "approved" : "rejected";
  const [request] = await query<{
    tournament_id: number;
    center_id: number;
    request_type: "individual" | "team";
    proposed_team_name: string | null;
    requested_team_id: number | null;
    requested_division: string | null;
  }>("SELECT * FROM registration_requests WHERE id = $1 AND center_id = $2 AND status = 'pending'", [requestId, centerId]);
  if (!request || !(await ensureTournamentEditable(request.tournament_id))) return;
  if (decision === "rejected") {
    await exec("UPDATE registration_requests SET status = 'rejected', reviewed_at = NOW() WHERE id = $1", [requestId]);
    revalidatePath("/center/dashboard");
    return;
  }

  const [tournament] = await query<{ tournament_type: "nationals" | "draft"; draft_locked: boolean }>(
    "SELECT tournament_type, draft_locked FROM tournaments WHERE id = $1",
    [request.tournament_id]
  );
  if (!tournament || tournament.draft_locked) return;
  const requestPlayers = await query<{ name: string; shirt_size: string | null }>(
    "SELECT name, shirt_size FROM registration_request_players WHERE request_id = $1 ORDER BY id",
    [requestId]
  );
  await withTransaction(async (client) => {
    let teamId: number | null = null;
    if (tournament.tournament_type === "nationals") {
      teamId = num(formData, "team_id") || request.requested_team_id;
      if (teamId) {
        const validTeam = await client.query(
          "SELECT id FROM teams WHERE id = $1 AND tournament_id = $2 AND center_id = $3 AND deleted_at IS NULL",
          [teamId, request.tournament_id, centerId]
        );
        if (!validTeam.rowCount) teamId = null;
      }
      if (!teamId) {
        const teamName = text(formData, "team_name") || request.proposed_team_name || `${requestPlayers[0]?.name || "New"} Team`;
        const division = await safeDivision(request.tournament_id, text(formData, "division") || request.requested_division || "");
        const teamResult = await client.query<{ id: number }>(
          `INSERT INTO teams (tournament_id, center_id, division, name)
           VALUES ($1, $2, $3, $4)
           ON CONFLICT DO NOTHING
           RETURNING id`,
          [request.tournament_id, centerId, division, teamName]
        );
        teamId = teamResult.rows[0]?.id || null;
        if (!teamId) {
          const existing = await client.query<{ id: number }>(
            "SELECT id FROM teams WHERE tournament_id = $1 AND center_id = $2 AND division = $3 AND name = $4",
            [request.tournament_id, centerId, division, teamName]
          );
          teamId = existing.rows[0]?.id || null;
        }
      }
      if (!teamId) return;
      const rosterCount = await client.query<{ count: string }>("SELECT COUNT(*) as count FROM players WHERE team_id = $1 AND deleted_at IS NULL", [teamId]);
      if (Number(rosterCount.rows[0]?.count || 0) + requestPlayers.length > 5) return;
    }

    for (const player of requestPlayers) {
      const personResult = await client.query<{ id: number }>(
        `INSERT INTO people (center_id, name, normalized_name)
         VALUES ($1, $2, $3)
         ON CONFLICT (center_id, normalized_name)
         DO UPDATE SET name = EXCLUDED.name, updated_at = NOW()
         RETURNING id`,
        [centerId, player.name, normalizePersonName(player.name)]
      );
      if (tournament.tournament_type === "draft") {
        const existing = await client.query(
          "SELECT id FROM players WHERE tournament_id = $1 AND person_id = $2 AND deleted_at IS NULL LIMIT 1",
          [request.tournament_id, personResult.rows[0].id]
        );
        if (existing.rowCount) continue;
      }
      await client.query(
        `INSERT INTO players (
           tournament_id, person_id, team_id, name, shirt_size, registration_status, assigned_level
         )
         VALUES ($1, $2, $3, $4, $5, 'approved', $6)`,
        [
          request.tournament_id,
          personResult.rows[0].id,
          teamId,
          player.name,
          player.shirt_size || "L",
          tournament.tournament_type === "draft" ? text(formData, "recommended_level") || request.requested_division || null : null
        ]
      );
    }
    await client.query("UPDATE registration_requests SET status = 'approved', reviewed_at = NOW() WHERE id = $1", [requestId]);
  });
  revalidatePath("/");
  revalidatePath("/center/dashboard");
  revalidatePath("/admin/draft");
}

export async function createDraftTeamAction(formData: FormData) {
  await requireAdmin();
  const tournamentId = num(formData, "tournament_id");
  const [tournament] = await query<{ tournament_type: string; draft_locked: boolean }>(
    "SELECT tournament_type, draft_locked FROM tournaments WHERE id = $1",
    [tournamentId]
  );
  if (!tournament || tournament.tournament_type !== "draft" || tournament.draft_locked || !(await ensureTournamentEditable(tournamentId))) return;
  const division = await safeDivision(tournamentId, text(formData, "division"));
  const [count] = await query<{ count: string }>(
    "SELECT COUNT(*) as count FROM teams WHERE tournament_id = $1 AND division = $2 AND deleted_at IS NULL",
    [tournamentId, division]
  );
  const name = text(formData, "name") || `${division} Team ${Number(count?.count || 0) + 1}`;
  await exec("INSERT INTO teams (tournament_id, center_id, division, name) VALUES ($1, NULL, $2, $3) ON CONFLICT DO NOTHING", [
    tournamentId,
    division,
    name
  ]);
  revalidatePath("/admin/draft");
}

export async function updateDraftTeamAction(formData: FormData) {
  await requireAdmin();
  const teamId = num(formData, "team_id");
  const [team] = await query<{ tournament_id: number }>(
    "SELECT tournament_id FROM teams WHERE id = $1 AND center_id IS NULL AND deleted_at IS NULL",
    [teamId]
  );
  if (!team) return;
  const [tournament] = await query<{ draft_locked: boolean }>("SELECT draft_locked FROM tournaments WHERE id = $1", [team.tournament_id]);
  if (!tournament || tournament.draft_locked || !(await ensureTournamentEditable(team.tournament_id))) return;
  const name = text(formData, "name");
  if (!name) return;
  await exec("UPDATE teams SET name = $1, updated_at = NOW() WHERE id = $2", [name, teamId]);
  revalidatePath("/admin/draft");
  revalidatePath("/");
}

export async function assignDraftPlayerAction(formData: FormData) {
  await requireAdmin();
  const playerId = num(formData, "player_id");
  const teamId = num(formData, "team_id") || null;
  const [player] = await query<{ tournament_id: number; assigned_level: string | null }>(
    "SELECT tournament_id, assigned_level FROM players WHERE id = $1 AND deleted_at IS NULL",
    [playerId]
  );
  if (!player) return;
  const [tournament] = await query<{ draft_locked: boolean }>("SELECT draft_locked FROM tournaments WHERE id = $1", [player.tournament_id]);
  if (!tournament || tournament.draft_locked || !(await ensureTournamentEditable(player.tournament_id))) return;
  if (teamId) {
    const [team] = await query<{ division: string; count: string }>(
      `SELECT teams.division, COUNT(players.id) as count
       FROM teams
       LEFT JOIN players ON players.team_id = teams.id AND players.deleted_at IS NULL
       WHERE teams.id = $1 AND teams.tournament_id = $2
       GROUP BY teams.id`,
      [teamId, player.tournament_id]
    );
    if (!team || Number(team.count) >= 5 || (player.assigned_level && team.division !== player.assigned_level)) return;
  }
  await exec("UPDATE players SET team_id = $1, updated_at = NOW() WHERE id = $2", [teamId, playerId]);
  revalidatePath("/admin/draft");
  revalidatePath("/");
}

export async function setDraftPlayerLevelAction(formData: FormData) {
  await requireAdmin();
  const playerId = num(formData, "player_id");
  const [player] = await query<{ tournament_id: number }>("SELECT tournament_id FROM players WHERE id = $1", [playerId]);
  if (!player) return;
  const [tournament] = await query<{ draft_locked: boolean }>("SELECT draft_locked FROM tournaments WHERE id = $1", [player.tournament_id]);
  if (!tournament || tournament.draft_locked || !(await ensureTournamentEditable(player.tournament_id))) return;
  const level = await safeDivision(player.tournament_id, text(formData, "assigned_level"));
  await exec("UPDATE players SET assigned_level = $1, team_id = NULL, updated_at = NOW() WHERE id = $2", [level, playerId]);
  revalidatePath("/admin/draft");
}
