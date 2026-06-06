import ExcelJS from "exceljs";
import { hasAdminAccess } from "@/lib/auth";
import { query } from "@/lib/db";
import { currentTournament } from "@/lib/tournaments";

export const dynamic = "force-dynamic";

type GameExportRow = {
  phase: string;
  division: string;
  court: number;
  starts_at: string;
  team_1_id: number | null;
  team_2_id: number | null;
  team_1: string | null;
  team_1_center: string | null;
  team_2: string | null;
  team_2_center: string | null;
  ref_team: string | null;
  ref_team_division: string | null;
  label: string | null;
};

type TeamExportRow = {
  id: number;
  center: string;
  division: string;
  name: string;
  early_available: boolean;
  deleted_at: string | null;
};

type ScheduleTeamStats = {
  team: TeamExportRow;
  seedingGames: number;
  opponents: Map<number, number>;
  courts: Map<number, number>;
  firstSeeding: string | null;
  lastSeeding: string | null;
};

const divisionColors: Record<string, string> = {
  A: "C65911",
  B: "2F75B5",
  C: "548235",
  D: "BF9000",
  Unlimited: "8064A2"
};

const refDivisionColors: Record<string, string> = {
  A: "FCE4D6",
  B: "DDEBF7",
  C: "E2F0D9",
  D: "FFF2CC",
  Unlimited: "EADCF8"
};

export async function GET() {
  if (!(await hasAdminAccess())) {
    return new Response("Unauthorized", { status: 401 });
  }
  const tournament = await currentTournament();

  const teams = await query<TeamExportRow>(
    `SELECT teams.id, COALESCE(centers.name, 'Draft') as center, teams.division, teams.name, teams.early_available, teams.deleted_at
     FROM teams LEFT JOIN centers ON centers.id = teams.center_id
     WHERE teams.tournament_id = $1
     ORDER BY teams.division, center, teams.name`,
    [tournament.id]
  );
  const players = await query(
    `SELECT COALESCE(centers.name, home_centers.name) as center, teams.division, teams.name as team, players.name, players.shirt_size,
            players.entry_paid, players.entry_amount, players.entry_paid_date, players.entry_payment_method, players.notes
     FROM players
     JOIN teams ON teams.id = players.team_id
     LEFT JOIN centers ON centers.id = teams.center_id
     LEFT JOIN people ON people.id = players.person_id
     LEFT JOIN centers home_centers ON home_centers.id = people.center_id
     WHERE players.tournament_id = $1 AND players.deleted_at IS NULL ORDER BY teams.division, center, team, players.id`,
    [tournament.id]
  );
  const shirts = await query(
    `SELECT COALESCE(centers.name, home_centers.name) as center, teams.division, teams.name as team, players.name as player,
            shirt_orders.size, shirt_orders.quantity, shirt_orders.paid, shirt_orders.amount, shirt_orders.paid_date, shirt_orders.payment_method
     FROM shirt_orders
     JOIN players ON players.id = shirt_orders.player_id
     JOIN teams ON teams.id = players.team_id
     LEFT JOIN centers ON centers.id = teams.center_id
     LEFT JOIN people ON people.id = players.person_id
     LEFT JOIN centers home_centers ON home_centers.id = people.center_id
     WHERE players.tournament_id = $1 AND shirt_orders.deleted_at IS NULL ORDER BY center, team, player`,
    [tournament.id]
  );
  const availabilityBlocks = await query(
    `SELECT centers.name as center, teams.division, teams.name as team,
            team_availability_blocks.starts_at, team_availability_blocks.ends_at, team_availability_blocks.reason
     FROM team_availability_blocks
     JOIN teams ON teams.id = team_availability_blocks.team_id
     JOIN centers ON centers.id = teams.center_id
     WHERE teams.tournament_id = $1
     ORDER BY team_availability_blocks.starts_at, center, team`,
    [tournament.id]
  );
  const games = await query<GameExportRow>(
    `SELECT games.phase, games.division, games.court, games.starts_at,
            games.team_1_id, games.team_2_id,
            t1.name as team_1, c1.name as team_1_center,
            t2.name as team_2, c2.name as team_2_center,
            tr.name as ref_team, tr.division as ref_team_division, games.label
     FROM games
     LEFT JOIN teams t1 ON t1.id = games.team_1_id
     LEFT JOIN centers c1 ON c1.id = t1.center_id
     LEFT JOIN teams t2 ON t2.id = games.team_2_id
     LEFT JOIN centers c2 ON c2.id = t2.center_id
     LEFT JOIN teams tr ON tr.id = games.ref_team_id
     WHERE games.tournament_id = $1
     ORDER BY games.starts_at, games.court`,
    [tournament.id]
  );

  const workbook = new ExcelJS.Workbook();
  workbook.creator = "Whirlyball Manager";
  workbook.created = new Date();

  addScheduleGridSheet(workbook, games);
  addScheduleSummarySheet(workbook, teams, games);
  addOpponentMatrixSheet(workbook, teams, games);
  addScheduleDetailSheet(workbook, games);
  addObjectSheet(workbook, "Teams", teams);
  addObjectSheet(workbook, "Players", players);
  addObjectSheet(workbook, "Extra Shirts", shirts);
  addObjectSheet(workbook, "Time Blockers", availabilityBlocks);

  const buffer = await workbook.xlsx.writeBuffer();
  return new Response(new Uint8Array(buffer), {
    headers: {
      "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": `attachment; filename="${tournament.slug}-export.xlsx"`
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
    colorRefCell(excelRow.getCell(3), row.court1RefDivision);
    colorRefCell(excelRow.getCell(6), row.court2RefDivision);
    excelRow.getCell(1).font = { bold: true };
    excelRow.getCell(2).font = { bold: true };
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
    colorRefCell(row.getCell("ref"), game.ref_team_division || "");
  }
  styleBody(sheet);
}

function addScheduleSummarySheet(workbook: ExcelJS.Workbook, teams: TeamExportRow[], games: GameExportRow[]) {
  const { statsByTeamId, teams: activeTeams, teamById } = buildScheduleQuality(teams, games);
  const divisionAverages = buildDivisionAverages(statsByTeamId);
  const sheet = workbook.addWorksheet("Schedule Summary", {
    views: [{ state: "frozen", ySplit: 1 }]
  });

  sheet.columns = [
    { header: "Division", key: "division", width: 10 },
    { header: "Center", key: "center", width: 14 },
    { header: "Team", key: "team", width: 26 },
    { header: "Seeding Games", key: "seedingGames", width: 15 },
    { header: "Unique Opponents", key: "uniqueOpponents", width: 17 },
    { header: "Max Repeat", key: "maxRepeat", width: 12 },
    { header: "Most Repeated Opponent", key: "mostRepeatedOpponent", width: 30 },
    { header: "Court 1", key: "court1", width: 10 },
    { header: "Court 2", key: "court2", width: 10 },
    { header: "Court Balance", key: "courtBalance", width: 18 },
    { header: "First Seeding", key: "firstSeeding", width: 18 },
    { header: "Last Seeding", key: "lastSeeding", width: 18 }
  ];
  sheet.autoFilter = "A1:L1";
  styleHeader(sheet.getRow(1));

  for (const team of activeTeams) {
    const stats = statsByTeamId.get(team.id);
    if (!stats) continue;
    const court1 = stats.courts.get(1) || 0;
    const court2 = stats.courts.get(2) || 0;
    const maxRepeat = maxOpponentRepeat(stats);
    const divisionAverage = divisionAverages.get(team.division) || 0;
    const row = sheet.addRow({
      division: team.division,
      center: team.center,
      team: team.name,
      seedingGames: stats.seedingGames,
      uniqueOpponents: stats.opponents.size,
      maxRepeat,
      mostRepeatedOpponent: mostRepeatedOpponent(stats, teamById),
      court1,
      court2,
      courtBalance: formatCourtBalance(court1, court2),
      firstSeeding: formatDateTime(stats.firstSeeding),
      lastSeeding: formatDateTime(stats.lastSeeding)
    });

    colorGameCell(row.getCell("division"), team.division);
    colorSummaryCells(row, stats.seedingGames, divisionAverage, maxRepeat, Math.abs(court1 - court2));
  }

  styleBody(sheet);
}

function addOpponentMatrixSheet(workbook: ExcelJS.Workbook, teams: TeamExportRow[], games: GameExportRow[]) {
  const { pairCounts, teams: activeTeams } = buildScheduleQuality(teams, games);
  const sheet = workbook.addWorksheet("Opponent Matrix", {
    views: [{ state: "frozen", xSplit: 1, ySplit: 1 }]
  });

  sheet.columns = [
    { header: "Team", key: "team", width: 38 },
    ...activeTeams.map((team) => ({ header: matrixTeamLabel(team), key: matrixTeamKey(team), width: 8 }))
  ];
  styleHeader(sheet.getRow(1));
  sheet.getRow(1).height = 88;
  sheet.getRow(1).eachCell((cell, columnNumber) => {
    cell.alignment = {
      horizontal: columnNumber === 1 ? "left" : "center",
      vertical: columnNumber === 1 ? "middle" : "bottom",
      textRotation: columnNumber === 1 ? 0 : 90,
      wrapText: true
    };
  });

  for (const rowTeam of activeTeams) {
    const values: Record<string, string | number> = { team: teamLabel(rowTeam) };
    for (const columnTeam of activeTeams) {
      values[matrixTeamKey(columnTeam)] = matrixCellValue(rowTeam, columnTeam, pairCounts);
    }

    const row = sheet.addRow(values);
    row.height = 24;
    row.getCell(1).font = { bold: true, color: { argb: "FFFFFFFF" } };
    row.getCell(1).fill = solidFill(divisionColors[rowTeam.division] || "FFFFFF");
    row.getCell(1).alignment = { vertical: "middle", wrapText: true };
    row.getCell(1).border = thinBorder();

    activeTeams.forEach((columnTeam, index) => {
      const cell = row.getCell(index + 2);
      styleMatrixCell(cell, rowTeam, columnTeam, pairCounts);
    });
  }
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
      court1RefDivision: string;
      court1Game: string;
      court1Division: string;
      court2Game: string;
      court2Division: string;
      court2Ref: string;
      court2RefDivision: string;
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
        court1RefDivision: "",
        court1Game: "",
        court1Division: "",
        court2Game: "",
        court2Division: "",
        court2Ref: "",
        court2RefDivision: ""
      };
    const gameText = game.team_1 && game.team_2 ? `${game.division}: ${game.team_1} vs. ${game.team_2}` : `${game.division}: ${game.label || "Game"}`;
    if (game.court === 1) {
      row.court1Ref = game.ref_team || "";
      row.court1RefDivision = game.ref_team_division || "";
      row.court1Game = gameText;
      row.court1Division = game.division;
    } else if (game.court === 2) {
      row.court2Game = gameText;
      row.court2Division = game.division;
      row.court2Ref = game.ref_team || "";
      row.court2RefDivision = game.ref_team_division || "";
    }
    rows.set(key, row);
  }

  return [...rows.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([, row]) => row);
}

function buildScheduleQuality(teams: TeamExportRow[], games: GameExportRow[]) {
  const activeTeams = teams.filter((team) => !team.deleted_at).sort(compareTeams);
  const teamById = new Map(activeTeams.map((team) => [team.id, team]));
  const statsByTeamId = new Map<number, ScheduleTeamStats>(
    activeTeams.map((team) => [
      team.id,
      {
        team,
        seedingGames: 0,
        opponents: new Map<number, number>(),
        courts: new Map<number, number>(),
        firstSeeding: null,
        lastSeeding: null
      }
    ])
  );
  const pairCounts = new Map<string, number>();

  for (const game of games) {
    if (game.phase !== "seeding" || game.team_1_id === null || game.team_2_id === null) continue;
    const team1Stats = statsByTeamId.get(game.team_1_id);
    const team2Stats = statsByTeamId.get(game.team_2_id);
    if (!team1Stats || !team2Stats) continue;

    recordSeedingGame(team1Stats, game.team_2_id, game);
    recordSeedingGame(team2Stats, game.team_1_id, game);
    const key = pairKey(game.team_1_id, game.team_2_id);
    pairCounts.set(key, (pairCounts.get(key) || 0) + 1);
  }

  return { pairCounts, statsByTeamId, teamById, teams: activeTeams };
}

function recordSeedingGame(stats: ScheduleTeamStats, opponentId: number, game: GameExportRow) {
  stats.seedingGames += 1;
  stats.opponents.set(opponentId, (stats.opponents.get(opponentId) || 0) + 1);
  stats.courts.set(game.court, (stats.courts.get(game.court) || 0) + 1);
  if (!stats.firstSeeding || game.starts_at.localeCompare(stats.firstSeeding) < 0) stats.firstSeeding = game.starts_at;
  if (!stats.lastSeeding || game.starts_at.localeCompare(stats.lastSeeding) > 0) stats.lastSeeding = game.starts_at;
}

function buildDivisionAverages(statsByTeamId: Map<number, ScheduleTeamStats>) {
  const totals = new Map<string, { games: number; teams: number }>();
  for (const stats of statsByTeamId.values()) {
    const current = totals.get(stats.team.division) || { games: 0, teams: 0 };
    current.games += stats.seedingGames;
    current.teams += 1;
    totals.set(stats.team.division, current);
  }

  return new Map([...totals.entries()].map(([division, total]) => [division, total.teams ? total.games / total.teams : 0]));
}

function colorSummaryCells(row: ExcelJS.Row, seedingGames: number, divisionAverage: number, maxRepeat: number, courtImbalance: number) {
  if (Math.abs(seedingGames - divisionAverage) > 1) {
    row.getCell("seedingGames").fill = solidFill("FCE4D6");
  }
  if (maxRepeat === 2) {
    row.getCell("maxRepeat").fill = solidFill("E2F0D9");
  } else if (maxRepeat > 2) {
    row.getCell("maxRepeat").fill = solidFill("F8CBAD");
    row.getCell("mostRepeatedOpponent").fill = solidFill("F8CBAD");
  }
  if (courtImbalance > 1) {
    row.getCell("courtBalance").fill = solidFill("FFF2CC");
  }
}

function maxOpponentRepeat(stats: ScheduleTeamStats) {
  return Math.max(0, ...stats.opponents.values());
}

function mostRepeatedOpponent(stats: ScheduleTeamStats, teamById: Map<number, TeamExportRow>) {
  const maxRepeat = maxOpponentRepeat(stats);
  if (maxRepeat <= 1) return "";
  return [...stats.opponents.entries()]
    .filter(([, count]) => count === maxRepeat)
    .map(([teamId]) => {
      const team = teamById.get(teamId);
      return team ? `${team.center} - ${team.name}` : `Team ${teamId}`;
    })
    .join(", ");
}

function matrixCellValue(rowTeam: TeamExportRow, columnTeam: TeamExportRow, pairCounts: Map<string, number>) {
  if (rowTeam.id === columnTeam.id || rowTeam.division !== columnTeam.division) return "";
  return pairCounts.get(pairKey(rowTeam.id, columnTeam.id)) || 0;
}

function styleMatrixCell(cell: ExcelJS.Cell, rowTeam: TeamExportRow, columnTeam: TeamExportRow, pairCounts: Map<string, number>) {
  cell.border = thinBorder();
  cell.alignment = { horizontal: "center", vertical: "middle" };
  if (rowTeam.id === columnTeam.id) {
    cell.fill = solidFill("666666");
    return;
  }
  if (rowTeam.division !== columnTeam.division) {
    cell.fill = solidFill("E7E6E6");
    return;
  }

  const count = pairCounts.get(pairKey(rowTeam.id, columnTeam.id)) || 0;
  if (count === 1) {
    cell.fill = solidFill("DDEBF7");
  } else if (count === 2) {
    cell.fill = solidFill("E2F0D9");
  } else if (count > 2) {
    cell.fill = solidFill("F8CBAD");
  }
}

function formatDateTime(value: string | null) {
  return value ? `${formatDay(value)} ${formatTime(value)}` : "";
}

function formatCourtBalance(court1: number, court2: number) {
  const difference = court1 - court2;
  if (difference === 0) return "Even";
  return `${Math.abs(difference)} more on Court ${difference > 0 ? "1" : "2"}`;
}

function pairKey(leftTeamId: number, rightTeamId: number) {
  return [leftTeamId, rightTeamId].sort((left, right) => left - right).join(":");
}

function teamLabel(team: TeamExportRow) {
  return `${team.division} - ${team.center} - ${team.name}`;
}

function matrixTeamLabel(team: TeamExportRow) {
  return `${team.division} ${team.center} ${team.name}`;
}

function matrixTeamKey(team: TeamExportRow) {
  return `team_${team.id}`;
}

function compareTeams(left: TeamExportRow, right: TeamExportRow) {
  return divisionRank(left.division) - divisionRank(right.division) || left.center.localeCompare(right.center) || left.name.localeCompare(right.name);
}

function divisionRank(division: string) {
  const rank = ["A", "B", "C", "D", "Unlimited"].indexOf(division);
  return rank === -1 ? 99 : rank;
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
  cell.font = { bold: true, color: { argb: divisionColors[division] ? "FFFFFFFF" : "FF202124" } };
  cell.alignment = { vertical: "middle", wrapText: true };
}

function colorRefCell(cell: ExcelJS.Cell, division: string) {
  cell.fill = solidFill(refDivisionColors[division] || "E7ECE7");
  cell.font = { bold: true, color: { argb: "FF202124" } };
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
