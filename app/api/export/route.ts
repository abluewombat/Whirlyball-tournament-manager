import { cookies } from "next/headers";
import * as XLSX from "xlsx";
import { query } from "@/lib/db";
import { unsign } from "@/lib/security";

export const dynamic = "force-dynamic";

export async function GET() {
  if (unsign((await cookies()).get("admin_session")?.value) !== "admin") {
    return new Response("Unauthorized", { status: 401 });
  }

  const teams = await query(
    `SELECT teams.id, centers.name as center, teams.division, teams.name, teams.early_available, teams.deleted_at
     FROM teams JOIN centers ON centers.id = teams.center_id ORDER BY teams.division, center, teams.name`
  );
  const players = await query(
    `SELECT centers.name as center, teams.division, teams.name as team, players.name, players.shirt_size,
            players.entry_paid, players.entry_amount, players.entry_paid_date, players.entry_payment_method, players.notes
     FROM players JOIN teams ON teams.id = players.team_id JOIN centers ON centers.id = teams.center_id
     WHERE players.deleted_at IS NULL ORDER BY teams.division, center, team, players.id`
  );
  const shirts = await query(
    `SELECT centers.name as center, teams.division, teams.name as team, players.name as player,
            shirt_orders.size, shirt_orders.quantity, shirt_orders.paid, shirt_orders.amount, shirt_orders.paid_date, shirt_orders.payment_method
     FROM shirt_orders
     JOIN players ON players.id = shirt_orders.player_id
     JOIN teams ON teams.id = players.team_id
     JOIN centers ON centers.id = teams.center_id
     WHERE shirt_orders.deleted_at IS NULL ORDER BY center, team, player`
  );
  const games = await query(
    `SELECT games.phase, games.division, games.court, games.starts_at,
            t1.name as team_1, t2.name as team_2, tr.name as ref_team, games.label
     FROM games
     LEFT JOIN teams t1 ON t1.id = games.team_1_id
     LEFT JOIN teams t2 ON t2.id = games.team_2_id
     LEFT JOIN teams tr ON tr.id = games.ref_team_id
     ORDER BY games.starts_at, games.court`
  );
  const scheduleGrid = buildScheduleGrid(
    games as Array<{
      phase: string;
      division: string;
      court: number;
      starts_at: string;
      team_1: string | null;
      team_2: string | null;
      ref_team: string | null;
      label: string | null;
    }>
  );

  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(teams), "Teams");
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(players), "Players");
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(shirts), "Extra Shirts");
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(scheduleGrid), "Schedule Grid");
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(games), "Schedule");
  const buffer = XLSX.write(workbook, { type: "buffer", bookType: "xlsx" }) as Buffer;

  return new Response(new Uint8Array(buffer), {
    headers: {
      "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": 'attachment; filename="whirlyball-export.xlsx"'
    }
  });
}

function buildScheduleGrid(
  games: Array<{
    phase: string;
    division: string;
    court: number;
    starts_at: string;
    team_1: string | null;
    team_2: string | null;
    ref_team: string | null;
    label: string | null;
  }>
) {
  const rows = new Map<string, Record<string, string>>();
  const courts = [...new Set(games.map((game) => game.court))].sort((a, b) => a - b);

  for (const game of games) {
    const date = new Date(game.starts_at);
    const day = Number.isNaN(date.getTime()) ? game.starts_at.slice(0, 10) : date.toLocaleDateString();
    const time = Number.isNaN(date.getTime()) ? game.starts_at.slice(11, 16) : date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
    const key = `${game.starts_at}`;
    const row = rows.get(key) || { Day: day, Time: time };
    const prefix = `Court ${game.court}`;
    row[`${prefix} Division`] = game.division;
    row[`${prefix} Game`] =
      game.team_1 && game.team_2 ? `${game.team_1} vs. ${game.team_2}` : game.label || `${game.division} ${game.phase}`;
    row[`${prefix} Ref`] = game.ref_team || "";
    rows.set(key, row);
  }

  return [...rows.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([, row]) => {
      for (const court of courts) {
        row[`Court ${court} Division`] ||= "";
        row[`Court ${court} Game`] ||= "";
        row[`Court ${court} Ref`] ||= "";
      }
      return row;
    });
}
