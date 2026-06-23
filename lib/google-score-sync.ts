import { JWT } from "google-auth-library";
import { query, withTransaction } from "./db";
import { scoreCourtGameFromSync } from "./score-sync";
import { estimateUnfilledStreamGameStarts, linkGamesToExistingCourtStreams } from "./streams";

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
  startsAt: string;
  court: number;
  team1Name: string;
  team2Name: string;
  refTeamName: string | null;
  team1Score: number | null;
  team2Score: number | null;
};

type ParsedSheetGame = ParsedSheetScore;

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

type TeamMatch = {
  id: number;
  division: string;
  name: string;
  normalized_name: string;
};

type DbGameRow = {
  id: number;
  phase: string;
  division: string;
  team_1_id: number | null;
  team_2_id: number | null;
  ref_team_id: number | null;
  label: string | null;
  team_1_score: number | null;
  team_2_score: number | null;
  winner_team_id: number | null;
  loser_team_id: number | null;
  result_type: string | null;
  forfeit_team_id: number | null;
  scored_at: Date | null;
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

export type GoogleScheduleSyncSummary = {
  enabled: boolean;
  sheetName: string;
  parsedRows: number;
  gamesInserted: number;
  gamesUpdated: number;
  gamesUnchanged: number;
  refsUpdated: number;
  refsUnchanged: number;
  streamsLinked: number;
  estimatedStarts: number;
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

export async function syncGoogleSheetSchedule(tournamentId: number): Promise<GoogleScheduleSyncSummary> {
  const spreadsheetId = process.env.GOOGLE_SCORES_SPREADSHEET_ID || defaultSpreadsheetId;
  const sheetName = process.env.GOOGLE_SCHEDULE_SYNC_SHEET_NAME || process.env.GOOGLE_SCORES_SHEET_NAME || defaultSheetName;
  const range = process.env.GOOGLE_SCHEDULE_SYNC_RANGE || process.env.GOOGLE_SCORES_RANGE || defaultRange;
  const values = await readGoogleSheetValues(spreadsheetId, sheetName, range);
  const games = await loadScheduleGameMatches(tournamentId);
  const dateByDayName = buildDateByDayName(games);
  const parsedRows = parseScheduleSheetScores(values, sheetName, dateByDayName);

  return withTransaction(async (client) => {
    const teamRows = await client.query<TeamMatch>(
      `SELECT id, division, name, name AS normalized_name
         FROM teams
        WHERE tournament_id = $1
          AND deleted_at IS NULL`,
      [tournamentId]
    );
    const teamsByName = new Map(teamRows.rows.map((team) => [normalizeTeamName(team.name), team]));
    const summary: GoogleScheduleSyncSummary = {
      enabled: true,
      sheetName,
      parsedRows: parsedRows.length,
      gamesInserted: 0,
      gamesUpdated: 0,
      gamesUnchanged: 0,
      refsUpdated: 0,
      refsUnchanged: 0,
      streamsLinked: 0,
      estimatedStarts: 0,
      skipped: []
    };

    const skip = (row: ParsedSheetGame, reason: string) => {
      summary.skipped.push({
        rowNumber: row.rowNumber,
        court: row.court,
        timeLabel: row.timeLabel,
        team1Name: row.team1Name,
        team2Name: row.team2Name,
        reason
      });
    };

    for (const row of parsedRows) {
      const team1 = teamsByName.get(row.team1Name);
      const team2 = teamsByName.get(row.team2Name);
      if (!team1 || !team2) {
        skip(row, "Unknown team name");
        continue;
      }
      if (team1.division !== team2.division || !["A", "B", "C", "D"].includes(team1.division)) {
        skip(row, "Teams are not in the same syncable division");
        continue;
      }

      let refTeam: TeamMatch | null = null;
      let shouldUpdateRef = false;
      if (row.refTeamName) {
        refTeam = teamsByName.get(row.refTeamName) || null;
        if (!refTeam) {
          skip(row, "Unknown ref team name");
        } else if (refTeam.division === team1.division) {
          skip(row, "Ref team is in the same division as the game");
        } else {
          shouldUpdateRef = true;
        }
      }

      const existingResult = await client.query<DbGameRow>(
        `SELECT id, phase, division, team_1_id, team_2_id, ref_team_id, label,
                team_1_score, team_2_score, winner_team_id, loser_team_id,
                result_type, forfeit_team_id, scored_at
           FROM games
          WHERE tournament_id = $1
            AND court = $2
            AND starts_at = $3::timestamptz
          ORDER BY id`,
        [tournamentId, row.court, row.startsAt]
      );
      const existingRows = existingResult.rows;
      const sameExisting = existingRows.find((game) => sameGame(game, team1.division, team1.id, team2.id));
      const primary = sameExisting || existingRows.find((game) => !isScored(game)) || existingRows[0];

      if (!primary) {
        const insertResult = await client.query<{ id: number }>(
          `INSERT INTO games (tournament_id, phase, division, court, starts_at, team_1_id, team_2_id, ref_team_id, label)
           VALUES ($1, 'seeding', $2, $3, $4::timestamptz, $5, $6, $7, NULL)
           RETURNING id`,
          [tournamentId, team1.division, row.court, row.startsAt, team1.id, team2.id, shouldUpdateRef ? refTeam?.id || null : null]
        );
        summary.gamesInserted += 1;
        if (shouldUpdateRef && insertResult.rows[0]) summary.refsUpdated += 1;
        continue;
      }

      if (isScored(primary) && !sameGame(primary, team1.division, team1.id, team2.id)) {
        skip(row, "Refusing to overwrite a scored game");
        continue;
      }

      const targetRefId = shouldUpdateRef ? refTeam?.id || null : primary.ref_team_id;
      const gameAlreadySame =
        sameGame(primary, team1.division, team1.id, team2.id) &&
        primary.phase === "seeding" &&
        primary.label === null;
      const refAlreadySame = primary.ref_team_id === targetRefId;

      if (gameAlreadySame && refAlreadySame) {
        summary.gamesUnchanged += 1;
        if (shouldUpdateRef) summary.refsUnchanged += 1;
        continue;
      }

      await client.query(
        `UPDATE games
            SET phase = 'seeding',
                division = $2,
                team_1_id = $3,
                team_2_id = $4,
                ref_team_id = $5,
                label = NULL,
                team_1_score = CASE WHEN $6::boolean THEN team_1_score ELSE NULL END,
                team_2_score = CASE WHEN $6::boolean THEN team_2_score ELSE NULL END,
                winner_team_id = CASE WHEN $6::boolean THEN winner_team_id ELSE NULL END,
                loser_team_id = CASE WHEN $6::boolean THEN loser_team_id ELSE NULL END,
                result_type = CASE WHEN $6::boolean THEN result_type ELSE NULL END,
                forfeit_team_id = CASE WHEN $6::boolean THEN forfeit_team_id ELSE NULL END,
                scored_by = CASE WHEN $6::boolean THEN scored_by ELSE NULL END,
                scored_at = CASE WHEN $6::boolean THEN scored_at ELSE NULL END
          WHERE id = $1`,
        [primary.id, team1.division, team1.id, team2.id, targetRefId, isScored(primary)]
      );
      if (gameAlreadySame) summary.gamesUnchanged += 1;
      else summary.gamesUpdated += 1;
      if (shouldUpdateRef) {
        if (refAlreadySame) summary.refsUnchanged += 1;
        else summary.refsUpdated += 1;
      }
    }

    summary.streamsLinked = await linkGamesToExistingCourtStreams(client, tournamentId);
    summary.estimatedStarts = await estimateUnfilledStreamGameStarts(client, tournamentId);
    return summary;
  });
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
  let currentDayMinute = 7 * 60;

  values.forEach((row, index) => {
    const headerDay = findDayName(row);
    if (headerDay) {
      currentDayName = headerDay;
      currentDayMinute = headerDay === "TUESDAY" ? 13 * 60 : 7 * 60;
    }
    if (!currentDayName) return;
    const localDate = dateByDayName.get(currentDayName);
    if (!localDate) return;
    const sharedRefTeamName = sharedRefTeamNameFromRow(row);

    for (const court of [1, 2]) {
      const parsed = parseCourtRow(row, court, sharedRefTeamName);
      if (!parsed) continue;
      const localMinute = nextLocalMinute(parsed.timeLabel, currentDayMinute);
      currentDayMinute = Math.max(currentDayMinute, localMinute);
      rows.push({
        sheetName,
        rowNumber: index + 1,
        localDate,
        dayName: currentDayName,
        startsAt: startsAtWithDetroitOffset(localDate, localMinute),
        court,
        ...parsed
      });
    }
  });

  return rows;
}

function parseCourtRow(row: string[], court: number, sharedRefTeamName: string | null) {
  const offset = court === 1 ? 2 : 8;
  const timeLabel = cellText(row[offset]);
  const team1Name = teamNameFromSheetCell(row[offset + 1]);
  const team2Name = teamNameFromSheetCell(row[offset + 5]);
  if (!isTimeLabel(timeLabel) || !team1Name || !team2Name) return null;

  return {
    timeLabel,
    team1Name,
    team2Name,
    refTeamName: sharedRefTeamName || refTeamNameFromSheetCell(row[court === 1 ? 0 : 14]) || null,
    team1Score: parseScore(row[offset + 2]),
    team2Score: parseScore(row[offset + 4])
  };
}

function sharedRefTeamNameFromRow(row: string[]) {
  const left = refTeamNameFromSheetCell(row[0]);
  const right = refTeamNameFromSheetCell(row[14]) || refTeamNameFromSheetCell(row[15]);
  if (left && right && left !== right) return null;
  return left || right || null;
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

function refTeamNameFromSheetCell(value: unknown) {
  const text = cellText(value).replace(/\s+/g, " ");
  if (!text || /^ref name$/i.test(text)) return "";
  return teamNameFromSheetCell(text);
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

function nextLocalMinute(timeLabel: string, currentMinute: number) {
  const [hourRaw, minuteRaw] = timeLabel.split(":");
  const hour = Number(hourRaw);
  const minute = Number(minuteRaw);
  if (!Number.isFinite(hour) || !Number.isFinite(minute)) return currentMinute;
  const candidates = [hour * 60 + minute];
  if (hour >= 1 && hour <= 11) candidates.push((hour + 12) * 60 + minute);
  return candidates.find((candidate) => candidate >= currentMinute) || candidates[candidates.length - 1];
}

function startsAtWithDetroitOffset(localDate: string, localMinute: number) {
  const hour = Math.floor(localMinute / 60);
  const minute = localMinute % 60;
  return `${localDate}T${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}:00-04:00`;
}

function sameGame(game: Pick<DbGameRow, "division" | "team_1_id" | "team_2_id">, division: string, team1Id: number, team2Id: number) {
  return game.division === division && game.team_1_id === team1Id && game.team_2_id === team2Id;
}

function isScored(game: Pick<DbGameRow, "team_1_score" | "team_2_score" | "winner_team_id" | "loser_team_id" | "result_type" | "forfeit_team_id" | "scored_at">) {
  return (
    game.team_1_score !== null ||
    game.team_2_score !== null ||
    game.winner_team_id !== null ||
    game.loser_team_id !== null ||
    game.result_type !== null ||
    game.forfeit_team_id !== null ||
    game.scored_at !== null
  );
}
