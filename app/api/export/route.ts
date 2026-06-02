import { cookies } from "next/headers";
import ExcelJS from "exceljs";
import { query } from "@/lib/db";
import { unsign } from "@/lib/security";

export const dynamic = "force-dynamic";

type GameExportRow = {
  division: string;
  court: number;
  starts_at: string;
  team_1: string | null;
  team_2: string | null;
  ref_team: string | null;
  label: string | null;
};

const divisionColors: Record<string, string> = {
  A: "F4B183",
  B: "9DC3E6",
  C: "A9D18E",
  D: "FFD966",
  Unlimited: "C9B6E4"
};

export async function GET() {
  if (unsign((await cookies()).get("admin_session")?.value) !== "admin") {
    return new Response("Unauthorized", { status: 401 });
  }

  const teams = await query(
    `SELECT centers.name as center, teams.division, teams.name, teams.early_available, teams.deleted_at
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
  const availabilityBlocks = await query(
    `SELECT centers.name as center, teams.division, teams.name as team,
            team_availability_blocks.starts_at, team_availability_blocks.ends_at, team_availability_blocks.reason
     FROM team_availability_blocks
     JOIN teams ON teams.id = team_availability_blocks.team_id
     JOIN centers ON centers.id = teams.center_id
     ORDER BY team_availability_blocks.starts_at, center, team`
  );
  const games = await query<GameExportRow>(
    `SELECT games.division, games.court, games.starts_at,
            t1.name as team_1, t2.name as team_2, tr.name as ref_team, games.label
     FROM games
     LEFT JOIN teams t1 ON t1.id = games.team_1_id
     LEFT JOIN teams t2 ON t2.id = games.team_2_id
     LEFT JOIN teams tr ON tr.id = games.ref_team_id
     ORDER BY games.starts_at, games.court`
  );

  const workbook = new ExcelJS.Workbook();
  workbook.creator = "Whirlyball Manager";
  workbook.created = new Date();

  addScheduleGridSheet(workbook, games);
  addScheduleDetailSheet(workbook, games);
  addObjectSheet(workbook, "Teams", teams);
  addObjectSheet(workbook, "Players", players);
  addObjectSheet(workbook, "Extra Shirts", shirts);
  addObjectSheet(workbook, "Time Blockers", availabilityBlocks);

  const buffer = await workbook.xlsx.writeBuffer();
  return new Response(new Uint8Array(buffer), {
    headers: {
      "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": 'attachment; filename="whirlyball-export.xlsx"'
    }
  });
}

function addScheduleGridSheet(workbook: ExcelJS.Workbook, games: GameExportRow[]) {
  const sheet = workbook.addWorksheet("Schedule Grid", {
    views: [{ state: "frozen", ySplit: 2 }]
  });
  sheet.columns = [
    { header: "Day", key: "day", width: 14 },
    { header: "Time", key: "time", width: 10 },
    { header: "Ref Court 1", key: "court1Ref", width: 18 },
    { header: "Court 1", key: "court1Game", width: 48 },
    { header: "Court 2", key: "court2Game", width: 48 },
    { header: "Ref Court 2", key: "court2Ref", width: 18 }
  ];

  sheet.spliceRows(1, 0, ["Whirlyball Schedule"]);
  sheet.mergeCells("A1:F1");
  sheet.getCell("A1").font = { bold: true, size: 16, color: { argb: "FFFFFFFF" } };
  sheet.getCell("A1").fill = solidFill("202124");
  sheet.getCell("A1").alignment = { horizontal: "center" };

  const header = sheet.getRow(2);
  header.values = ["Day", "Time", "Ref Court 1", "Court 1", "Court 2", "Ref Court 2"];
  header.font = { bold: true, color: { argb: "FFFFFFFF" } };
  header.alignment = { horizontal: "center" };
  header.eachCell((cell) => {
    cell.fill = solidFill("176B87");
    cell.border = thinBorder();
  });

  const gridRows = buildScheduleGrid(games);
  for (const row of gridRows) {
    const excelRow = sheet.addRow([row.day, row.time, row.court1Ref, row.court1Game, row.court2Game, row.court2Ref]);
    excelRow.height = 30;
    excelRow.eachCell((cell) => {
      cell.border = thinBorder();
      cell.alignment = { vertical: "middle", wrapText: true };
    });
    colorGameCell(excelRow.getCell(4), row.court1Division);
    colorGameCell(excelRow.getCell(5), row.court2Division);
    excelRow.getCell(1).font = { bold: true };
    excelRow.getCell(2).font = { bold: true };
    excelRow.getCell(3).fill = solidFill("E7ECE7");
    excelRow.getCell(6).fill = solidFill("E7ECE7");
  }
}

function addScheduleDetailSheet(workbook: ExcelJS.Workbook, games: GameExportRow[]) {
  const sheet = workbook.addWorksheet("Schedule Detail", {
    views: [{ state: "frozen", ySplit: 1 }]
  });
  sheet.columns = [
    { header: "Day", key: "day", width: 14 },
    { header: "Time", key: "time", width: 10 },
    { header: "Court", key: "court", width: 8 },
    { header: "Division", key: "division", width: 10 },
    { header: "Game", key: "game", width: 52 },
    { header: "Ref", key: "ref", width: 20 }
  ];
  styleHeader(sheet.getRow(1));
  for (const game of games) {
    const row = sheet.addRow({
      day: formatDay(game.starts_at),
      time: formatTime(game.starts_at),
      court: game.court,
      division: game.division,
      game: game.team_1 && game.team_2 ? `${game.team_1} vs. ${game.team_2}` : game.label || `${game.division} game`,
      ref: game.ref_team || ""
    });
    colorGameCell(row.getCell("game"), game.division);
  }
  styleBody(sheet);
}

function addObjectSheet(workbook: ExcelJS.Workbook, name: string, rows: Record<string, unknown>[]) {
  const sheet = workbook.addWorksheet(name, {
    views: [{ state: "frozen", ySplit: 1 }]
  });
  if (!rows.length) return;
  const headers = Object.keys(rows[0]);
  sheet.columns = headers.map((header) => ({ header: titleCase(header), key: header, width: Math.min(32, Math.max(12, header.length + 4)) }));
  styleHeader(sheet.getRow(1));
  for (const row of rows) {
    sheet.addRow(Object.fromEntries(Object.entries(row).map(([key, value]) => [key, formatValue(value)])));
  }
  styleBody(sheet);
}

function buildScheduleGrid(games: GameExportRow[]) {
  const rows = new Map<
    string,
    {
      day: string;
      time: string;
      court1Ref: string;
      court1Game: string;
      court1Division: string;
      court2Game: string;
      court2Division: string;
      court2Ref: string;
    }
  >();

  for (const game of games) {
    const key = `${game.starts_at}`;
    const row =
      rows.get(key) ||
      {
        day: formatDay(game.starts_at),
        time: formatTime(game.starts_at),
        court1Ref: "",
        court1Game: "",
        court1Division: "",
        court2Game: "",
        court2Division: "",
        court2Ref: ""
      };
    const gameText = game.team_1 && game.team_2 ? `${game.division}: ${game.team_1} vs. ${game.team_2}` : `${game.division}: ${game.label || "Game"}`;
    if (game.court === 1) {
      row.court1Ref = game.ref_team || "";
      row.court1Game = gameText;
      row.court1Division = game.division;
    } else if (game.court === 2) {
      row.court2Game = gameText;
      row.court2Division = game.division;
      row.court2Ref = game.ref_team || "";
    }
    rows.set(key, row);
  }

  return [...rows.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([, row]) => row);
}

function formatDay(value: string) {
  const literal = literalDateTimeParts(value);
  if (literal) return literal.day;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value.slice(0, 10);
  return date.toLocaleDateString("en-US", { weekday: "short", month: "numeric", day: "numeric" });
}

function formatTime(value: string) {
  const literal = literalDateTimeParts(value);
  if (literal) return literal.time;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value.slice(11, 16);
  return date.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
}

function literalDateTimeParts(value: string) {
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/);
  if (!match) return null;
  const [, year, month, day, hour, minute] = match;
  const date = new Date(Number(year), Number(month) - 1, Number(day));
  if (Number.isNaN(date.getTime())) return null;
  return {
    day: date.toLocaleDateString("en-US", { weekday: "short", month: "numeric", day: "numeric" }),
    time: formatClock(Number(hour), minute)
  };
}

function formatClock(hour: number, minute: string) {
  const suffix = hour >= 12 ? "PM" : "AM";
  const displayHour = hour % 12 || 12;
  return `${displayHour}:${minute} ${suffix}`;
}

function formatValue(value: unknown) {
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}T/.test(value)) return `${formatDay(value)} ${formatTime(value)}`;
  return value ?? "";
}

function titleCase(value: string) {
  return value.replace(/_/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function colorGameCell(cell: ExcelJS.Cell, division: string) {
  cell.fill = solidFill(divisionColors[division] || "FFFFFF");
  cell.font = { bold: true };
  cell.alignment = { vertical: "middle", wrapText: true };
}

function styleHeader(row: ExcelJS.Row) {
  row.font = { bold: true, color: { argb: "FFFFFFFF" } };
  row.eachCell((cell) => {
    cell.fill = solidFill("176B87");
    cell.border = thinBorder();
    cell.alignment = { horizontal: "center" };
  });
}

function styleBody(sheet: ExcelJS.Worksheet) {
  sheet.eachRow((row, rowNumber) => {
    if (rowNumber === 1) return;
    row.eachCell((cell) => {
      cell.border = thinBorder();
      cell.alignment = { vertical: "middle", wrapText: true };
    });
  });
}

function solidFill(color: string): ExcelJS.Fill {
  return { type: "pattern", pattern: "solid", fgColor: { argb: `FF${color}` } };
}

function thinBorder(): Partial<ExcelJS.Borders> {
  return {
    top: { style: "thin", color: { argb: "FFD9DDD6" } },
    left: { style: "thin", color: { argb: "FFD9DDD6" } },
    bottom: { style: "thin", color: { argb: "FFD9DDD6" } },
    right: { style: "thin", color: { argb: "FFD9DDD6" } }
  };
}
