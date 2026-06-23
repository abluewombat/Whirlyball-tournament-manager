import { JWT } from "google-auth-library";
import { query } from "./db";
import { scoreCourtGameFromSync } from "./score-sync";

type GoogleSheetValuesResponse = {
  range?: string;
  values?: string[][];
};

type ParsedSheetScore = {
  sheetName: string;
  rowNumber: number;
  localDate: string;
  dayName: string;
  timeLabel: string;
  court: number;
  team1Name: string;
  team2Name: string;
  team1Score: number | null;
  team2Score: number | null;
};

type ScheduleGameMatch = {
  id: number;
  phase: string;
  division: string;
  court: number;
  local_date: string;
  local_time: string;
  team_1: string | null;
  team_2: string | null;
  team_1_score: number | null;
  team_2_score: number | null;
};

export type GoogleScoreSyncSummary = {
  sheetName: string;
  parsedRows: number;
  scoredRows: number;
  updated: number;
  unchanged: number;
  skipped: Array<{
    rowNumber: number;
    court: number;
    timeLabel: string;
    team1Name: string;
    team2Name: string;
    reason: string;
  }>;
};

const defaultSpreadsheetId = "1Ja6ff8IbAWm3_eGWCWlRhWoKRyQELQxA";
const defaultSheetName = "2026 Schedule Final wcolor no R";
const defaultRange = "A1:Q1000";
const dayNames = ["SUNDAY", "MONDAY", "TUESDAY", "WEDNESDAY", "THURSDAY", "FRIDAY", "SATURDAY"];

export async function syncGoogleSheetScores(tournamentId: number): Promise<GoogleScoreSyncSummary> {
  const spreadsheetId = process.env.GOOGLE_SCORES_SPREADSHEET_ID || defaultSpreadsheetId;
  const sheetName = process.env.GOOGLE_SCORES_SHEET_NAME || defaultSheetName;
  const range = process.env.GOOGLE_SCORES_RANGE || defaultRange;
  const values = await readGoogleSheetValues(spreadsheetId, sheetName, range);
  const games = await loadScheduleGameMatches(tournamentId);
  const dateByDayName = buildDateByDayName(games);
  const parsedRows = parseScheduleSheetScores(values, sheetName, dateByDayName);
  const summary: GoogleScoreSyncSummary = {
    sheetName,
    parsedRows: parsedRows.length,
    scoredRows: 0,
    updated: 0,
    unchanged: 0,
    skipped: []
  };

  for (const row of parsedRows) {
    const skip = (reason: string) => {
      summary.skipped.push({
        rowNumber: row.rowNumber,
        court: row.court,
        timeLabel: row.timeLabel,
        team1Name: row.team1Name,
        team2Name: row.team2Name,
        reason
      });
    };

    if (row.team1Score === null && row.team2Score === null) continue;
    if (row.team1Score === null || row.team2Score === null) {
      skip("Only one score cell is filled");
      continue;
    }
    summary.scoredRows += 1;

    const match = matchScheduleGame(games, row);
    if (!match) {
      skip("No matching game found");
      continue;
    }

    const result = await scoreCourtGameFromSync({
      gameId: match.id,
      team1Score: row.team1Score,
      team2Score: row.team2Score,
      scoredBy: "google-sheet-sync"
    });
    if (!result.ok) {
      skip(result.reason);
      continue;
    }
    if (result.changed) summary.updated += 1;
    else summary.unchanged += 1;
  }

  return summary;
}

async function readGoogleSheetValues(spreadsheetId: string, sheetName: string, range: string) {
  const client = googleJwtClient();
  const accessToken = await client.getAccessToken();
  const token = typeof accessToken === "string" ? accessToken : accessToken?.token;
  if (!token) throw new Error("Unable to obtain a Google access token.");

  const params = new URLSearchParams();
  params.set("majorDimension", "ROWS");
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}/values/${encodeURIComponent(
    `'${sheetName}'!${range}`
  )}?${params.toString()}`;
  const response = await fetch(url, {
    headers: { authorization: `Bearer ${token}` },
    cache: "no-store"
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Google Sheets read failed (${response.status}): ${body.slice(0, 500)}`);
  }
  const data = (await response.json()) as GoogleSheetValuesResponse;
  return data.values || [];
}

function googleJwtClient() {
  const rawJson = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (!rawJson) throw new Error("GOOGLE_SERVICE_ACCOUNT_JSON is required.");

  const credentials = JSON.parse(rawJson) as {
    client_email?: string;
    private_key?: string;
  };
  if (!credentials.client_email || !credentials.private_key) {
    throw new Error("GOOGLE_SERVICE_ACCOUNT_JSON must include client_email and private_key.");
  }

  return new JWT({
    email: credentials.client_email,
    key: credentials.private_key.replace(/\\n/g, "\n"),
    scopes: ["https://www.googleapis.com/auth/spreadsheets.readonly"]
  });
}

function parseScheduleSheetScores(values: string[][], sheetName: string, dateByDayName: Map<string, string>) {
  const rows: ParsedSheetScore[] = [];
  let currentDayName: string | null = null;

  values.forEach((row, index) => {
    const headerDay = findDayName(row);
    if (headerDay) currentDayName = headerDay;
    if (!currentDayName) return;
    const localDate = dateByDayName.get(currentDayName);
    if (!localDate) return;

    for (const court of [1, 2]) {
      const parsed = parseCourtRow(row, court);
      if (!parsed) continue;
      rows.push({
        sheetName,
        rowNumber: index + 1,
        localDate,
        dayName: currentDayName,
        court,
        ...parsed
      });
    }
  });

  return rows;
}

function parseCourtRow(row: string[], court: number) {
  const offset = court === 1 ? 2 : 8;
  const timeLabel = cellText(row[offset]);
  const team1Name = teamNameFromSheetCell(row[offset + 1]);
  const team2Name = teamNameFromSheetCell(row[offset + 5]);
  if (!isTimeLabel(timeLabel) || !team1Name || !team2Name) return null;

  return {
    timeLabel,
    team1Name,
    team2Name,
    team1Score: parseScore(row[offset + 2]),
    team2Score: parseScore(row[offset + 4])
  };
}

function findDayName(row: string[]) {
  for (const value of row) {
    const upper = cellText(value).toUpperCase();
    const dayName = dayNames.find((candidate) => upper === candidate);
    if (dayName) return dayName;
  }
  return null;
}

function parseScore(value: unknown) {
  const text = cellText(value);
  if (!text) return null;
  if (!/^\d+$/.test(text)) return null;
  return Number(text);
}

function isTimeLabel(value: string) {
  return /^\d{1,2}:\d{2}$/.test(value.trim());
}

function cellText(value: unknown) {
  return String(value ?? "").trim();
}

function teamNameFromSheetCell(value: unknown) {
  const text = cellText(value).replace(/\s+/g, " ");
  if (!text || /^open play$/i.test(text)) return "";
  const parts = text.split(/\s+-\s+/);
  return normalizeTeamName(parts.length > 1 ? parts.slice(1).join(" - ") : text);
}

function normalizeTeamName(value: string) {
  return value
    .trim()
    .replace(/\s+/g, " ")
    .replace(/[’]/g, "'")
    .toLowerCase();
}

async function loadScheduleGameMatches(tournamentId: number) {
  return query<ScheduleGameMatch>(
    `SELECT games.id,
            games.phase,
            games.division,
            games.court,
            to_char(games.starts_at AT TIME ZONE tournaments.timezone, 'YYYY-MM-DD') AS local_date,
            to_char(games.starts_at AT TIME ZONE tournaments.timezone, 'HH24:MI') AS local_time,
            t1.name AS team_1,
            t2.name AS team_2,
            games.team_1_score,
            games.team_2_score
       FROM games
       JOIN tournaments ON tournaments.id = games.tournament_id
       LEFT JOIN teams t1 ON t1.id = games.team_1_id
       LEFT JOIN teams t2 ON t2.id = games.team_2_id
      WHERE games.tournament_id = $1
        AND games.team_1_id IS NOT NULL
        AND games.team_2_id IS NOT NULL
      ORDER BY games.starts_at, games.court`,
    [tournamentId]
  );
}

function buildDateByDayName(games: ScheduleGameMatch[]) {
  const dates = new Map<string, string>();
  for (const game of games) {
    const dayName = dayNames[new Date(`${game.local_date}T12:00:00`).getDay()];
    if (!dates.has(dayName)) dates.set(dayName, game.local_date);
  }
  return dates;
}

function matchScheduleGame(games: ScheduleGameMatch[], row: ParsedSheetScore) {
  const candidates = games.filter(
    (game) =>
      game.local_date === row.localDate &&
      game.court === row.court &&
      normalizeTeamName(game.team_1 || "") === row.team1Name &&
      normalizeTeamName(game.team_2 || "") === row.team2Name
  );
  return candidates.find((game) => possibleTwentyFourHourTimes(row.timeLabel).includes(game.local_time)) || null;
}

function possibleTwentyFourHourTimes(timeLabel: string) {
  const [hourRaw, minuteRaw] = timeLabel.split(":");
  const hour = Number(hourRaw);
  const minute = Number(minuteRaw);
  if (!Number.isFinite(hour) || !Number.isFinite(minute)) return [timeLabel];
  const candidates = new Set<string>();
  candidates.add(`${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`);
  if (hour >= 1 && hour <= 11) candidates.add(`${String(hour + 12).padStart(2, "0")}:${String(minute).padStart(2, "0")}`);
  return [...candidates];
}
