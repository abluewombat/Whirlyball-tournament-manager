"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { createSnapshot, DIVISIONS, exec, query, restoreSnapshot, SHIRT_SIZES, withTransaction } from "@/lib/db";
import { loginAdmin, loginCenter, logoutAdmin, logoutCenter, requireAdmin, requireCenterId } from "@/lib/auth";
import { hashSecret } from "@/lib/security";
import { generateSchedule } from "@/lib/schedule";
import { scheduleDefaults } from "@/lib/schedule-defaults";

function text(formData: FormData, key: string) {
  return String(formData.get(key) || "").trim();
}

function num(formData: FormData, key: string, fallback = 0) {
  const value = Number(formData.get(key));
  return Number.isFinite(value) ? value : fallback;
}

function checkbox(formData: FormData, key: string) {
  return formData.get(key) === "on";
}

function dateTimeMs(value: string) {
  return Date.parse(`${value.length === 16 ? `${value}:00` : value}Z`);
}

function safeDivision(value: string) {
  return DIVISIONS.includes(value as never) ? value : "D";
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
  const centerId = formData.has("center_id") ? num(formData, "center_id") : await requireCenterId();
  if (formData.has("center_id")) await requireAdmin();
  const name = text(formData, "name");
  if (!name) return;
  await exec(
    `INSERT INTO teams (center_id, division, name, early_available)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (center_id, division, name) DO NOTHING`,
    [centerId, safeDivision(text(formData, "division")), name, checkbox(formData, "early_available")]
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
  await exec(
    `UPDATE teams
     SET name = $1, division = $2, early_available = $3, updated_at = NOW()
     WHERE id = $4 ${adminEdit ? "" : "AND center_id = $5"}`,
    adminEdit
      ? [text(formData, "name"), safeDivision(text(formData, "division")), checkbox(formData, "early_available"), teamId]
      : [text(formData, "name"), safeDivision(text(formData, "division")), checkbox(formData, "early_available"), teamId, centerId]
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
  await exec("UPDATE teams SET deleted_at = NULL WHERE id = $1", [num(formData, "team_id")]);
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
  const [existing] = await query<{ count: string }>("SELECT COUNT(*) as count FROM players WHERE team_id = $1 AND deleted_at IS NULL", [teamId]);
  if (Number(existing?.count || 0) >= 5) return;
  await exec("INSERT INTO players (team_id, name, shirt_size, notes) VALUES ($1, $2, $3, $4)", [
    teamId,
    text(formData, "name"),
    safeSize(text(formData, "shirt_size")),
    text(formData, "notes") || null
  ]);
  revalidatePath("/");
  revalidatePath("/center/dashboard");
  revalidatePath("/admin/dashboard");
}

export async function updatePlayerAction(formData: FormData) {
  const adminEdit = formData.has("admin");
  if (adminEdit) await requireAdmin();
  const requiredCenterId = adminEdit ? null : await requireCenterId();
  const playerId = num(formData, "player_id");
  if (!adminEdit) {
    const owned = await query(
      `SELECT players.id FROM players
       JOIN teams ON teams.id = players.team_id
       WHERE players.id = $1 AND teams.center_id = $2`,
      [playerId, requiredCenterId]
    );
    if (!owned.length) return;
  }
  await exec(
    `UPDATE players
     SET name = $1, shirt_size = $2, entry_paid = $3, entry_amount = $4, entry_paid_date = $5,
         entry_payment_method = $6, notes = $7, updated_at = NOW()
     WHERE id = $8`,
    [
      text(formData, "name"),
      safeSize(text(formData, "shirt_size")),
      checkbox(formData, "entry_paid"),
      num(formData, "entry_amount"),
      text(formData, "entry_paid_date") || null,
      text(formData, "entry_payment_method") || null,
      text(formData, "notes") || null,
      playerId
    ]
  );
  revalidatePath("/");
  revalidatePath("/center/dashboard");
  revalidatePath("/admin/dashboard");
}

export async function softDeletePlayerAction(formData: FormData) {
  const adminEdit = formData.has("admin");
  if (adminEdit) await requireAdmin();
  const centerId = adminEdit ? null : await requireCenterId();
  const playerId = num(formData, "player_id");
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

export async function snapshotAction(formData: FormData) {
  await requireAdmin();
  await createSnapshot(text(formData, "label") || "Manual snapshot");
  revalidatePath("/admin/dashboard");
}

export async function restoreSnapshotAction(formData: FormData) {
  await requireAdmin();
  await restoreSnapshot(num(formData, "snapshot_id"));
  revalidatePath("/");
  revalidatePath("/admin/dashboard");
}

export async function generateScheduleAction(formData: FormData) {
  await requireAdmin();
  const result = await generateSchedule({
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
    seedingMode: text(formData, "seeding_mode") === "round_robin" ? "round_robin" : "balanced",
    targetGamesPerTeam: Math.max(1, num(formData, "target_games_per_team", scheduleDefaults.targetGamesPerTeam)),
    divisionTargetGames: text(formData, "division_target_games"),
    includeTuesday: true,
    blockOrder: text(formData, "block_order") || scheduleDefaults.blockOrder,
    blockRows: Math.max(1, num(formData, "block_rows", scheduleDefaults.blockRows)),
    preTournamentCutoff: text(formData, "pre_tournament_cutoff") || scheduleDefaults.preTournamentCutoff,
    morningRestRows: Math.max(0, num(formData, "morning_rest_rows", scheduleDefaults.morningRestRows)),
    lateNightRows: Math.max(0, num(formData, "late_night_rows", scheduleDefaults.lateNightRows))
  });
  await withTransaction(async (client) => {
    await client.query("DELETE FROM games");
    for (const game of result.games) {
      await client.query(
        `INSERT INTO games (phase, division, court, starts_at, team_1_id, team_2_id, ref_team_id, label)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [game.phase, game.division, game.court, game.startsAt, game.team1Id, game.team2Id, game.refTeamId, game.label]
      );
    }
  });
  revalidatePath("/admin/schedule");
  redirect(
    `/admin/schedule?generated=${result.games.length}&unscheduled=${result.unscheduledSeedingGames}&unscheduled_tournament=${result.unscheduledTournamentGames}`
  );
}

export async function moveScheduleGameAction(input: { gameId: number; startsAt: string; court: number }) {
  await requireAdmin();
  const gameId = Number(input.gameId);
  const targetCourt = Number(input.court);
  const targetStartsAt = String(input.startsAt || "");
  if (!Number.isInteger(gameId) || gameId <= 0 || !targetStartsAt || !Number.isInteger(targetCourt) || targetCourt < 1) return;

  const [source] = await query<{ id: number; starts_at: string; court: number }>("SELECT id, starts_at, court FROM games WHERE id = $1", [gameId]);
  if (!source) return;
  if (source.starts_at === targetStartsAt && source.court === targetCourt) return;

  const [target] = await query<{ id: number }>("SELECT id FROM games WHERE starts_at = $1 AND court = $2 AND id <> $3 ORDER BY id LIMIT 1", [
    targetStartsAt,
    targetCourt,
    gameId
  ]);

  await withTransaction(async (client) => {
    if (target) {
      await client.query("UPDATE games SET starts_at = $1, court = $2 WHERE id = $3", [source.starts_at, source.court, target.id]);
    }
    await client.query("UPDATE games SET starts_at = $1, court = $2 WHERE id = $3", [targetStartsAt, targetCourt, gameId]);
  });

  revalidatePath("/admin/schedule");
  revalidatePath("/schedule");
}
