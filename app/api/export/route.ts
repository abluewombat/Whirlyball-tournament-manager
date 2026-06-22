import ExcelJS from "exceljs";
import { appVersion } from "@/lib/app-version";
import { hasAdminAccess } from "@/lib/auth";
import { query } from "@/lib/db";
import {
  buildDivisionAverages,
  buildScheduleQuality,
  formatCourtBalance,
  matrixCellValue,
  maxOpponentRepeat,
  mostRepeatedOpponent,
  pairKey
} from "@/lib/schedule-quality";
import { buildScheduleRulesReport, type ScheduleRuleAvailabilityBlock, type ScheduleRulesReport } from "@/lib/schedule-rules";
import { currentTournament } from "@/lib/tournaments";

export const dynamic = "force-dynamic";

type GameExportRow = {
  id: number;
  phase: string;
  division: string;
  court: number;
  starts_at: string;
  team_1_id: number | null;
  team_2_id: number | null;
  ref_team_id: number | null;
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

type TournamentScheduleSettingsRow = {
  schedule_settings_json: Record<string, unknown> | null;
  schedule_rules_report_json: ScheduleRulesReport | null;
};

const divisionColors: Record<string, string> = {
  A: "FFFF00",
  B: "FFC000",
  C: "00B0F0",
  D: "92D050",
  Unlimited: "F4CCCC"
};

const divisionTextColors: Record<string, string> = {
  A: "FF202124",
  B: "FF202124",
  C: "FF202124",
  D: "FF202124",
  Unlimited: "FF202124"
};

const refDivisionColors: Record<string, string> = {
  A: "FFF9B0",
  B: "FFE699",
  C: "C9F0FF",
  D: "D9EAD3",
  Unlimited: "FCE4EC"
};

const teamCodeByName: Record<string, string> = {
  [normalizeTeamName("Not In The Realm")]: "ATL A",
  [normalizeTeamName("The Remnants")]: "ATL B",
  [normalizeTeamName("Lake Effect")]: "CHI A",
  [normalizeTeamName("Goal-A-Dinga")]: "CHI B1",
  [normalizeTeamName("Dead Horse")]: "CHI B2",
  [normalizeTeamName("Mean Whirls")]: "CHI C1",
  [normalizeTeamName("Maximum Effort")]: "CHI C2",
  [normalizeTeamName("Squad Goals")]: "CHI C3",
  [normalizeTeamName("SWATTY BALLZ")]: "CHI D",
  [normalizeTeamName("WhirlyHausen")]: "CLEV A",
  [normalizeTeamName("Whirld of Hurt")]: "CLEV C1",
  [normalizeTeamName("The BWC")]: "CLEV C2",
  [normalizeTeamName("The BWC (Buckeye Whirly Club)")]: "CLEV C2",
  [normalizeTeamName("Two Fams & a Weatherman")]: "CLEV C3",
  [normalizeTeamName("The Goon Squad")]: "CLEV D",
  [normalizeTeamName("Hey You Guys")]: "MICH A1",
  [normalizeTeamName("Goal Diggers")]: "MICH A2",
  [normalizeTeamName("Shots Fired")]: "MICH A3",
  [normalizeTeamName("MixT Up")]: "MICH C",
  [normalizeTeamName("Motown Motion")]: "MICH D1",
  [normalizeTeamName("Designated Drunk Drivers")]: "MICH D2",
  [normalizeTeamName("Whirly Sirs")]: "MINN B",
  [normalizeTeamName("Whirly Blue Balls")]: "MINN C",
  [normalizeTeamName("4 Lefts 1 Wrong")]: "MINN D",
  [normalizeTeamName("A-Rex")]: "SEA A1",
  [normalizeTeamName("Brick City")]: "SEA A2",
  [normalizeTeamName("Goat Herders")]: "SEA A3",
  [normalizeTeamName("Whirlocks")]: "SEA B1",
  [normalizeTeamName("Gooey Ducks")]: "SEA B2",
  [normalizeTeamName("Seattle Sea Devils")]: "SEA C1",
  [normalizeTeamName("Whirld War C")]: "SEA C2",
  [normalizeTeamName("Whirled Not Stirred")]: "SEA C3",
  [normalizeTeamName("Cherry Peckers")]: "SEA C4",
  [normalizeTeamName("Hollaback Whirl")]: "SEA D",
  [normalizeTeamName("SouthBound & Down")]: "TEX A1",
  [normalizeTeamName("Los Guapos")]: "TEX A2",
  [normalizeTeamName("Team USA")]: "TEX B1",
  [normalizeTeamName("First Weld Problems")]: "TEX C",
  [normalizeTeamName("The 30%ers")]: "TEX D1",
  [normalizeTeamName("I Don't Remember")]: "TEX D2"
};

const centerCodes: Record<string, string> = {
  atlanta: "ATL",
  chicago: "CHI",
  cleveland: "CLEV",
  michigan: "MICH",
  minnesota: "MINN",
  seattle: "SEA",
  texas: "TEX"
};

const defaultTournamentTimeZone = "America/Detroit";

export async function GET() {
  if (!(await hasAdminAccess())) {
    return new Response("Unauthorized", { status: 401 });
  }
  const tournament = await currentTournament();
  const games = await query<GameExportRow>(
    `SELECT games.id, games.phase, games.division, games.court, games.starts_at,
            games.team_1_id, games.team_2_id, games.ref_team_id,
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

  const timeZone = tournament.timezone || defaultTournamentTimeZone;
  addScheduleGridSheet(workbook, games, timeZone);
  addScheduleDetailSheet(workbook, games, timeZone);

  const buffer = await workbook.xlsx.writeBuffer();
  return new Response(new Uint8Array(buffer), {
    headers: {
      "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": `attachment; filename="${tournament.slug}-export.xlsx"`
    }
  });
}

function addRulesCheckSheet(workbook: ExcelJS.Workbook, report: ScheduleRulesReport) {
  const sheet = workbook.addWorksheet("Rules Check", {
    views: [{ state: "frozen", ySplit: 5 }]
  });
  sheet.columns = [
    { header: "Rule", key: "rule", width: 42 },
    { header: "Status", key: "status", width: 12 },
    { header: "Severity", key: "severity", width: 12 },
    { header: "Issues", key: "issues", width: 10 },
    { header: "Team", key: "team", width: 32 },
    { header: "Time", key: "time", width: 20 },
    { header: "Message", key: "message", width: 56 },
    { header: "Details", key: "details", width: 64 }
  ];

  sheet.spliceRows(1, 0, ["Schedule Rules Check"]);
  sheet.mergeCells("A1:H1");
  sheet.getCell("A1").font = { bold: true, size: 16, color: { argb: "FFFFFFFF" } };
  sheet.getCell("A1").fill = solidFill(report.status === "pass" ? "38761D" : "B00020");
  sheet.getCell("A1").alignment = { horizontal: "center" };

  sheet.addRow(["Overall", report.status === "pass" ? "Clean" : "Issues Found", "", report.issueCount, "", formatValue(report.generatedAt), "", ""]);
  const summaryRow = sheet.getRow(2);
  summaryRow.font = { bold: true };
  summaryRow.eachCell((cell) => {
    cell.border = thinBorder();
    cell.alignment = { vertical: "middle", wrapText: true };
  });
  summaryRow.getCell(2).fill = solidFill(report.status === "pass" ? "D9EAD3" : "F4CCCC");

  sheet.addRow([]);
  const header = sheet.addRow(["Rule", "Status", "Severity", "Issues", "Team", "Time", "Message", "Details"]);
  styleHeader(header);

  for (const rule of report.rules) {
    const row = sheet.addRow({
      rule: rule.name,
      status: rule.status === "pass" ? "Pass" : "Fail",
      severity: titleCase(rule.severity),
      issues: rule.issueCount,
      team: "",
      time: "",
      message: rule.status === "pass" ? "No issues" : `${rule.issueCount} issue${rule.issueCount === 1 ? "" : "s"}`,
      details: rule.id
    });
    styleRulesCheckRow(row, rule.status === "pass");

    for (const issue of rule.issues) {
      const issueRow = sheet.addRow({
        rule: rule.name,
        status: "Issue",
        severity: titleCase(issue.severity),
        issues: "",
        team: issue.team || "",
        time: issue.startsAt ? formatDateTime(issue.startsAt) : "",
        message: issue.message,
        details: issue.details ? formatRuleDetails(issue.details) : ""
      });
      styleRulesCheckRow(issueRow, false);
      issueRow.getCell("rule").alignment = { vertical: "middle", wrapText: true, indent: 1 };
    }
  }
}

function styleRulesCheckRow(row: ExcelJS.Row, pass: boolean) {
  row.eachCell((cell) => {
    cell.border = thinBorder();
    cell.alignment = { vertical: "middle", wrapText: true };
  });
  row.getCell("status").fill = solidFill(pass ? "D9EAD3" : "F4CCCC");
  row.getCell("status").font = { bold: true, color: { argb: "FF202124" } };
}

function formatRuleDetails(details: Record<string, string | number | null | string[]>) {
  return Object.entries(details)
    .map(([key, value]) => `${titleCase(key)}: ${Array.isArray(value) ? value.join(", ") : value ?? ""}`)
    .join("; ");
}

type ReferenceScheduleDay = {
  key: string;
  label: string;
  rows: ReferenceScheduleRow[];
};

type ReferenceScheduleRow = {
  key: string;
  startsAt: string;
  court1: GameExportRow | null;
  court2: GameExportRow | null;
};

function addScheduleGridSheet(workbook: ExcelJS.Workbook, games: GameExportRow[], timeZone: string) {
  const sheet = workbook.addWorksheet("Schedule", {
    views: [{ showGridLines: false }]
  });
  sheet.properties.defaultRowHeight = 18;
  sheet.columns = [
    { width: 16 },
    { width: 3 },
    { width: 8 },
    { width: 34 },
    { width: 4 },
    { width: 5 },
    { width: 4 },
    { width: 34 },
    { width: 8 },
    { width: 34 },
    { width: 4 },
    { width: 5 },
    { width: 4 },
    { width: 34 },
    { width: 16 }
  ];

  let nextRow = 1;
  for (const section of buildReferenceScheduleDays(games, timeZone)) {
    if (nextRow > 1) nextRow += 2;
    nextRow = addReferenceScheduleDay(sheet, section, nextRow, timeZone);
  }
}

function buildReferenceScheduleDays(games: GameExportRow[], timeZone: string): ReferenceScheduleDay[] {
  const days = new Map<string, ReferenceScheduleDay>();
  const sortedGames = [...games].sort((left, right) => {
    const timeSort = left.starts_at.localeCompare(right.starts_at);
    if (timeSort !== 0) return timeSort;
    return left.court - right.court;
  });

  for (const game of sortedGames) {
    const key = scheduleDateKey(game.starts_at, timeZone);
    let day = days.get(key);
    if (!day) {
      day = {
        key,
        label: scheduleDayHeader(game.starts_at, timeZone),
        rows: []
      };
      days.set(key, day);
    }

    addGameToReferenceScheduleDay(day, game);
  }

  return [...days.values()]
    .map((day) => ({
      ...day,
      rows: day.rows.sort((left, right) => left.key.localeCompare(right.key))
    }))
    .sort((left, right) => left.key.localeCompare(right.key));
}

function addGameToReferenceScheduleDay(day: ReferenceScheduleDay, game: GameExportRow) {
  const key = scheduleSlotKey(game.starts_at);
  const courtKey = game.court === 1 ? "court1" : game.court === 2 ? "court2" : null;
  if (!courtKey) return;

  let row = day.rows.find((candidate) => candidate.key === key && candidate[courtKey] === null);
  if (!row) {
    row = { key, startsAt: game.starts_at, court1: null, court2: null };
    day.rows.push(row);
  }
  row[courtKey] = game;
}

function addReferenceScheduleDay(sheet: ExcelJS.Worksheet, section: ReferenceScheduleDay, startRow: number, timeZone: string) {
  let rowNumber = startRow;
  addMergedScheduleHeader(sheet, rowNumber, 1, 15, "2026 NOVI WHIRLYBALL NATIONAL TOURNAMENT SCHEDULE", 12);
  rowNumber += 1;
  addMergedScheduleHeader(sheet, rowNumber, 1, 7, "SCHEDULE EXPORT", 9);
  addMergedScheduleHeader(sheet, rowNumber, 9, 15, `VERSION ${appVersion}`, 9);
  rowNumber += 1;
  addMergedScheduleHeader(sheet, rowNumber, 1, 15, section.label, 14);
  rowNumber += 1;

  styleScheduleHeaderRow(sheet, rowNumber);
  sheet.getCell(rowNumber, 1).value = "Ref Name";
  addMergedScheduleHeader(sheet, rowNumber, 3, 8, "COURT 1", 10);
  addMergedScheduleHeader(sheet, rowNumber, 9, 14, "COURT 2", 10);
  sheet.getCell(rowNumber, 15).value = "Ref Name";
  rowNumber += 1;

  for (const scheduleRow of section.rows) {
    styleScheduleDataRow(sheet, rowNumber);
    const court1Game = scheduleRow.court1;
    const court2Game = scheduleRow.court2;
    writeReferenceTimeCell(sheet, rowNumber, 3, scheduleRow.startsAt, timeZone);
    writeReferenceTimeCell(sheet, rowNumber, 9, scheduleRow.startsAt, timeZone);

    if (court1Game) {
      writeReferenceCourtGame(sheet, rowNumber, 3, court1Game, timeZone);
      writeReferenceCell(sheet, rowNumber, 1, court1Game.ref_team || "", court1Game.ref_team_division || "", true);
    }
    if (court2Game) {
      writeReferenceCourtGame(sheet, rowNumber, 9, court2Game, timeZone);
      writeReferenceCell(sheet, rowNumber, 15, court2Game.ref_team || "", court2Game.ref_team_division || "", true);
    }
    rowNumber += 1;
  }

  return rowNumber;
}

function writeReferenceTimeCell(sheet: ExcelJS.Worksheet, rowNumber: number, timeCol: number, startsAt: string, timeZone: string) {
  const timeCell = sheet.getCell(rowNumber, timeCol);
  timeCell.value = formatTime(startsAt, timeZone);
  timeCell.font = { bold: true };
  timeCell.alignment = { horizontal: "center", vertical: "middle" };
  timeCell.border = thinBorder();
}

function addMergedScheduleHeader(sheet: ExcelJS.Worksheet, rowNumber: number, startCol: number, endCol: number, value: string, size: number) {
  sheet.mergeCells(`${columnLetter(startCol)}${rowNumber}:${columnLetter(endCol)}${rowNumber}`);
  const cell = sheet.getCell(rowNumber, startCol);
  cell.value = value;
  for (let col = startCol; col <= endCol; col += 1) {
    const headerCell = sheet.getCell(rowNumber, col);
    headerCell.fill = solidFill("000000");
    headerCell.font = { bold: true, size, color: { argb: "FFFFFFFF" } };
    headerCell.alignment = { horizontal: "center", vertical: "middle" };
    headerCell.border = {
      top: { style: "medium", color: { argb: "FFFFFFFF" } },
      left: { style: "medium", color: { argb: "FFFFFFFF" } },
      bottom: { style: "medium", color: { argb: "FFFFFFFF" } },
      right: { style: "medium", color: { argb: "FFFFFFFF" } }
    };
  }
  sheet.getRow(rowNumber).height = size >= 14 ? 22 : 18;
}

function styleScheduleHeaderRow(sheet: ExcelJS.Worksheet, rowNumber: number) {
  const row = sheet.getRow(rowNumber);
  row.height = 18;
  for (let col = 1; col <= 15; col += 1) {
    const cell = row.getCell(col);
    cell.fill = solidFill("000000");
    cell.font = { bold: true, color: { argb: "FFFFFFFF" } };
    cell.border = thinWhiteBorder();
    cell.alignment = { horizontal: "center", vertical: "middle" };
  }
}

function styleScheduleDataRow(sheet: ExcelJS.Worksheet, rowNumber: number) {
  const row = sheet.getRow(rowNumber);
  row.height = 18;
  for (let col = 1; col <= 15; col += 1) {
    const cell = row.getCell(col);
    cell.border = thinBorder();
    cell.alignment = { horizontal: "center", vertical: "middle", wrapText: true };
  }
}

function writeReferenceCourtGame(sheet: ExcelJS.Worksheet, rowNumber: number, timeCol: number, game: GameExportRow, timeZone: string) {
  const timeCell = sheet.getCell(rowNumber, timeCol);
  timeCell.value = formatTime(game.starts_at, timeZone);
  timeCell.font = { bold: true };
  timeCell.alignment = { horizontal: "center", vertical: "middle" };

  const firstTeamCol = timeCol + 1;
  const vsCol = timeCol + 3;
  const secondTeamCol = timeCol + 5;
  styleReferenceGameBlock(sheet, rowNumber, firstTeamCol, secondTeamCol, game.division);

  if (game.team_1 && game.team_2) {
    sheet.getCell(rowNumber, firstTeamCol).value = exportTeamLabel(game.team_1_center, game.division, game.team_1);
    sheet.getCell(rowNumber, vsCol).value = "vs.";
    sheet.getCell(rowNumber, secondTeamCol).value = exportTeamLabel(game.team_2_center, game.division, game.team_2);
  } else {
    sheet.mergeCells(`${columnLetter(firstTeamCol)}${rowNumber}:${columnLetter(secondTeamCol)}${rowNumber}`);
    sheet.getCell(rowNumber, firstTeamCol).value = exportGameText(game, false);
  }
}

function writeReferenceCell(sheet: ExcelJS.Worksheet, rowNumber: number, col: number, value: string, division: string, refCell: boolean) {
  const cell = sheet.getCell(rowNumber, col);
  cell.value = value;
  if (!value) return;
  if (refCell) {
    colorRefCell(cell, division);
  } else {
    colorGameCell(cell, division);
  }
  cell.border = thinBorder();
  cell.alignment = { horizontal: "center", vertical: "middle", wrapText: true };
}

function styleReferenceGameBlock(sheet: ExcelJS.Worksheet, rowNumber: number, startCol: number, endCol: number, division: string) {
  for (let col = startCol; col <= endCol; col += 1) {
    const cell = sheet.getCell(rowNumber, col);
    cell.fill = solidFill(divisionColors[division] || "FFFFFF");
    cell.font = { bold: true, color: { argb: divisionTextColors[division] || "FF202124" } };
    cell.border = thinBorder();
    cell.alignment = { horizontal: "center", vertical: "middle", wrapText: true };
  }
}

function scheduleDateKey(value: string, timeZone = defaultTournamentTimeZone) {
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (match && !hasExplicitTimeZone(value)) return `${match[1]}-${match[2]}-${match[3]}`;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value.slice(0, 10);
  const parts = dateTimeFormatParts(date, timeZone, {
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  });
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function scheduleSlotKey(value: string) {
  const date = new Date(value);
  if (!Number.isNaN(date.getTime())) return date.toISOString();
  return value;
}

function scheduleDayHeader(value: string, timeZone = defaultTournamentTimeZone) {
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (match && !hasExplicitTimeZone(value)) {
    const [, year, month, day] = match;
    const date = new Date(Number(year), Number(month) - 1, Number(day));
    if (!Number.isNaN(date.getTime())) {
      return date.toLocaleDateString("en-US", { weekday: "long" }).toUpperCase();
    }
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return formatDay(value, timeZone).toUpperCase();
  return date.toLocaleDateString("en-US", { weekday: "long", timeZone }).toUpperCase();
}

function addScheduleGridDaySeparator(sheet: ExcelJS.Worksheet, day: string) {
  const row = sheet.addRow([day]);
  row.height = 26;
  const rowNumber = row.number;
  sheet.mergeCells(`A${rowNumber}:F${rowNumber}`);
  const cell = sheet.getCell(`A${rowNumber}`);
  cell.value = day.toUpperCase();
  cell.font = { bold: true, size: 14, color: { argb: "FFFFFFFF" } };
  cell.fill = solidFill("000000");
  cell.alignment = { horizontal: "center", vertical: "middle" };
  cell.border = {
    top: { style: "medium", color: { argb: "FF000000" } },
    left: { style: "medium", color: { argb: "FF000000" } },
    bottom: { style: "medium", color: { argb: "FF000000" } },
    right: { style: "medium", color: { argb: "FF000000" } }
  };
}

function addScheduleDetailSheet(workbook: ExcelJS.Workbook, games: GameExportRow[], timeZone: string) {
  const sheet = workbook.addWorksheet("Schedule Details", {
    views: [{ state: "frozen", ySplit: 1 }]
  });
  sheet.columns = [
    { header: "Day", key: "day", width: 14 },
    { header: "Time", key: "time", width: 10 },
    { header: "Court", key: "court", width: 8 },
    { header: "Division", key: "division", width: 10 },
    { header: "Team 1", key: "team1", width: 36 },
    { header: "Team 2", key: "team2", width: 36 },
    { header: "Game", key: "game", width: 72 },
    { header: "Ref", key: "ref", width: 20 }
  ];
  styleHeader(sheet.getRow(1));
  for (const game of games) {
    const row = sheet.addRow({
      day: formatDay(game.starts_at, timeZone),
      time: formatTime(game.starts_at, timeZone),
      court: game.court,
      division: game.division,
      team1: game.team_1 ? exportTeamLabel(game.team_1_center, game.division, game.team_1) : "",
      team2: game.team_2 ? exportTeamLabel(game.team_2_center, game.division, game.team_2) : "",
      game: exportGameText(game, false),
      ref: game.ref_team || ""
    });
    colorGameCell(row.getCell("division"), game.division);
    colorGameCell(row.getCell("team1"), game.division);
    colorGameCell(row.getCell("team2"), game.division);
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
    const gameText = exportGameText(game, true);
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

function exportGameText(game: GameExportRow, includeDivision: boolean) {
  if (isOpenScheduleSlot(game)) return game.label || "Open schedule slot";
  if (game.team_1 && game.team_2) {
    const team1 = exportTeamLabel(game.team_1_center, game.division, game.team_1);
    const team2 = exportTeamLabel(game.team_2_center, game.division, game.team_2);
    return `${includeDivision ? `${game.division}: ` : ""}${team1} vs. ${team2}`;
  }
  return `${includeDivision ? `${game.division}: ` : ""}${game.label || "Game"}`;
}

function isOpenScheduleSlot(game: GameExportRow) {
  return game.division === "Open" && game.label === "Open schedule slot" && game.team_1_id === null && game.team_2_id === null && game.ref_team_id === null;
}

function exportTeamLabel(center: string | null, division: string, name: string) {
  const code = teamCodeByName[normalizeTeamName(name)] || fallbackTeamCode(center, division);
  return code ? `${code} - ${name}` : name;
}

function fallbackTeamCode(center: string | null, division: string) {
  const code = center ? centerCodes[normalizeTeamName(center)] || center.slice(0, 4).toUpperCase() : "";
  return [code, division].filter(Boolean).join(" ");
}

function normalizeTeamName(value: string) {
  return value.replace(/[\u2018\u2019]/g, "'").replace(/\s+/g, " ").trim().toLowerCase();
}

function columnLetter(columnNumber: number) {
  let column = columnNumber;
  let result = "";
  while (column > 0) {
    const modulo = (column - 1) % 26;
    result = String.fromCharCode(65 + modulo) + result;
    column = Math.floor((column - modulo) / 26);
  }
  return result;
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

function formatDateTime(value: string | null, timeZone = defaultTournamentTimeZone) {
  return value ? `${formatDay(value, timeZone)} ${formatTime(value, timeZone)}` : "";
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

function formatDay(value: string, timeZone = defaultTournamentTimeZone) {
  const literal = literalDateTimeParts(value);
  if (literal) return literal.day;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value.slice(0, 10);
  return date.toLocaleDateString("en-US", { weekday: "short", month: "numeric", day: "numeric", timeZone });
}

function formatTime(value: string, timeZone = defaultTournamentTimeZone) {
  const literal = literalDateTimeParts(value);
  if (literal) return literal.time;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value.slice(11, 16);
  return date.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone });
}

function literalDateTimeParts(value: string) {
  if (hasExplicitTimeZone(value)) return null;
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

function hasExplicitTimeZone(value: string) {
  return /(?:Z|[+-]\d{2}:?\d{2})$/i.test(value);
}

function dateTimeFormatParts(date: Date, timeZone: string, options: Intl.DateTimeFormatOptions) {
  return Object.fromEntries(
    new Intl.DateTimeFormat("en-US", { timeZone, ...options })
      .formatToParts(date)
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, part.value])
  ) as Record<string, string>;
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
  cell.font = { bold: true, color: { argb: divisionColors[division] ? divisionTextColors[division] || "FF202124" : "FF202124" } };
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

function thinWhiteBorder(): Partial<ExcelJS.Borders> {
  return {
    top: { style: "thin", color: { argb: "FFFFFFFF" } },
    left: { style: "thin", color: { argb: "FFFFFFFF" } },
    bottom: { style: "thin", color: { argb: "FFFFFFFF" } },
    right: { style: "thin", color: { argb: "FFFFFFFF" } }
  };
}
