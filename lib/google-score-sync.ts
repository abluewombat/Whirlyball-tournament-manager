import { JWT } from "google-auth-library";
import * as xlsx from "xlsx";
import { query, withTransaction } from "./db";
import { scoreCourtGameFromSync } from "./score-sync";
import { linkGamesToExistingCourtStreams } from "./streams";

type GoogleSheetValuesResponse = {
  range?: string;
  values?: string[][];
};

type GoogleSheetRows = {
  sheetName: string;
  values: string[][];
};

type GoogleSpreadsheetResponse = {
  sheets?: Array<{
    properties?: {
      title?: string;
      index?: number;
    };
  }>;
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

type SyncDeleteCandidate = DbGameRow & {
  court: number;
  starts_at: string;
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
    refTeamName?: string | null;
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
  gamesDeleted: number;
  scoredGamesRetained: number;
  refsUpdated: number;
  refsRemoved: number;
  refsUnchanged: number;
  streamsLinked: number;
  skipped: Array<{
    rowNumber: number;
    court: number;
    timeLabel: string;
    team1Name: string;
    team2Name: string;
    refTeamName?: string | null;
    reason: string;
  }>;
};

const defaultSpreadsheetId = "1Ja6ff8IbAWm3_eGWCWlRhWoKRyQELQxA";
const defaultRange = "A1:Q1000";
const defaultSheetIndex = 0;
const currentScheduleSheetName = "2026 Schedule Final v1.6";
const staleScheduleSheetNames = new Set([
  "2026 Schedule Final wcolor no R",
  "2026 Schedule Final ver 1.5 w/color no Refs",
  "2026 Schedule Final ver 1.5 wco"
].map(normalizeSheetName));
const dayNames = ["SUNDAY", "MONDAY", "TUESDAY", "WEDNESDAY", "THURSDAY", "FRIDAY", "SATURDAY"];
const teamSyncDefinitions: Record<string, { division: string; names: string[]; codes: string[] }> = {
  atlanta_a: { division: "A", names: ["Not In The Realm"], codes: ["ATLANTA A", "ATL A"] },
  atlanta_b: { division: "B", names: ["The Remnants"], codes: ["ATLANTA B", "ATL B"] },
  chicago_a: { division: "A", names: ["Lake Effect"], codes: ["CHICAGO A", "CHI A"] },
  chicago_b1: { division: "B", names: ["Goal-A-Dinga"], codes: ["CHICAGO B1", "CHI B1"] },
  chicago_b2: { division: "B", names: ["Dead Horse"], codes: ["CHICAGO B2", "CHI B2"] },
  chicago_c1: { division: "C", names: ["Mean Whirls"], codes: ["CHICAGO C1", "CHI C1"] },
  chicago_c2: { division: "C", names: ["Maximum Effort"], codes: ["CHICAGO C2", "CHI C2"] },
  chicago_c3: { division: "C", names: ["Squad Goals"], codes: ["CHICAGO C3", "CHI C3"] },
  chicago_d: { division: "D", names: ["SWATTY BALLZ"], codes: ["CHICAGO D", "CHI D"] },
  cleveland_a: { division: "A", names: ["WhirlyHausen"], codes: ["CLEVELAND A", "CLEV A"] },
  cleveland_c1: { division: "C", names: ["Whirld of Hurt"], codes: ["CLEVELAND C1", "CLEV C1"] },
  cleveland_c2: { division: "C", names: ["The BWC", "The BWC (Buckeye Whirly Club)"], codes: ["CLEVELAND C2", "CLEV C2"] },
  cleveland_c3: { division: "C", names: ["Two Fams & a Weatherman"], codes: ["CLEVELAND C3", "CLEV C3"] },
  cleveland_d: { division: "D", names: ["The Goon Squad"], codes: ["CLEVELAND D", "CLEV D"] },
  michigan_a1: { division: "A", names: ["Hey You Guys"], codes: ["MICHIGAN A1", "MICH A1"] },
  michigan_a2: { division: "A", names: ["Goal Diggers"], codes: ["MICHIGAN A2", "MICH A2"] },
  michigan_a3: { division: "A", names: ["Shots Fired"], codes: ["MICHIGAN A3", "MICH A3"] },
  michigan_c: { division: "C", names: ["MixT Up", "Mixt Up"], codes: ["MICHIGAN C", "MICH C"] },
  michigan_d1: { division: "D", names: ["Motown Motion"], codes: ["MICHIGAN D1", "MICH D1"] },
  michigan_d2: { division: "D", names: ["Designated Drunk Drivers"], codes: ["MICHIGAN D2", "MICH D2"] },
  minnesota_b: { division: "B", names: ["Whirly Sirs"], codes: ["MINNESOTA B", "MINN B"] },
  minnesota_c: { division: "C", names: ["Whirly Blue Balls"], codes: ["MINNESOTA C", "MINN C"] },
  minnesota_d: { division: "D", names: ["4 Lefts 1 Wrong"], codes: ["MINNESOTA D", "MINN D"] },
  seattle_a1: { division: "A", names: ["A-Rex"], codes: ["SEATTLE A1", "SEA A1"] },
  seattle_a2: { division: "A", names: ["Brick City"], codes: ["SEATTLE A2", "SEA A2"] },
  seattle_a3: { division: "A", names: ["Goat Herders"], codes: ["SEATTLE A3", "SEA A3"] },
  seattle_b1: { division: "B", names: ["Whirlocks"], codes: ["SEATTLE B1", "SEA B1"] },
  seattle_b2: { division: "B", names: ["Gooey Ducks"], codes: ["SEATTLE B2", "SEA B2"] },
  seattle_c1: { division: "C", names: ["Seattle Sea Devils"], codes: ["SEATTLE C1", "SEA C1"] },
  seattle_c2: { division: "C", names: ["Whirld War C"], codes: ["SEATTLE C2", "SEA C2"] },
  seattle_c3: { division: "C", names: ["Whirled Not Stirred"], codes: ["SEATTLE C3", "SEA C3"] },
  seattle_c4: { division: "C", names: ["Cherry Peckers"], codes: ["SEATTLE C4", "SEA C4"] },
  seattle_d: { division: "D", names: ["Hollaback Whirl"], codes: ["SEATTLE D", "SEA D"] },
  texas_a1: { division: "A", names: ["SouthBound & Down", "Southbound & Down"], codes: ["TEXAS A1", "TEX A1"] },
  texas_a2: { division: "A", names: ["Los Guapos"], codes: ["TEXAS A2", "TEX A2"] },
  texas_b1: { division: "B", names: ["Team USA"], codes: ["TEXAS B1", "TEX B1"] },
  texas_c: { division: "C", names: ["First Weld Problems"], codes: ["TEXAS C", "TEX C"] },
  texas_d1: { division: "D", names: ["The 30%ers"], codes: ["TEXAS D1", "TEX D1"] },
  texas_d2: { division: "D", names: ["I Don't Remember"], codes: ["TEXAS D2", "TEX D2"] }
};
const refTeamNameAliases: Record<string, string> = {
  "max effor": "Maximum Effort",
  "max effort": "Maximum Effort",
  maximum: "Maximum Effort",
  southbound: "SouthBound & Down",
  "whirly blue": "Whirly Blue Balls",
  "whirld of h": "Whirld of Hurt",
  "the bwc (b": "The BWC (Buckeye Whirly Club)",
  "two fams &": "Two Fams & a Weatherman",
  "cherry peck": "Cherry Peckers",
  "whirled not": "Whirled Not Stirred",
  "hey you": "Hey You Guys",
  "not in the r": "Not In The Realm",
  "first weld p": "First Weld Problems",
  "first weld pr": "First Weld Problems",
  "seat c seattle sea de": "Seattle Sea Devils",
  "seat c whirld war c": "Whirld War C"
};

export async function syncGoogleSheetScores(tournamentId: number): Promise<GoogleScoreSyncSummary> {
  const spreadsheetId = process.env.GOOGLE_SCORES_SPREADSHEET_ID || defaultSpreadsheetId;
  const range = process.env.GOOGLE_SCORES_RANGE || defaultRange;
  const sheet = await readGoogleSheetRows(spreadsheetId, {
    sheetIndex: process.env.GOOGLE_SCORES_SHEET_INDEX,
    sheetName: effectiveGoogleScheduleSheetName(process.env.GOOGLE_SCORES_SHEET_NAME),
    range
  });
  const games = await loadScheduleGameMatches(tournamentId);
  const dateByDayName = buildDateByDayName(games);
  const parsedRows = parseScheduleSheetScores(sheet.values, sheet.sheetName, dateByDayName);
  const summary: GoogleScoreSyncSummary = {
    sheetName: sheet.sheetName,
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
        refTeamName: row.refTeamName,
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
  const range = process.env.GOOGLE_SCHEDULE_SYNC_RANGE || process.env.GOOGLE_SCORES_RANGE || defaultRange;
  const sheet = await readGoogleSheetRows(spreadsheetId, {
    sheetIndex: process.env.GOOGLE_SCHEDULE_SYNC_SHEET_INDEX || process.env.GOOGLE_SCORES_SHEET_INDEX,
    sheetName: effectiveGoogleScheduleSheetName(process.env.GOOGLE_SCHEDULE_SYNC_SHEET_NAME || process.env.GOOGLE_SCORES_SHEET_NAME),
    range
  });
  const games = await loadScheduleGameMatches(tournamentId);
  const dateByDayName = buildDateByDayName(games);
  const parsedRows = parseScheduleSheetScores(sheet.values, sheet.sheetName, dateByDayName);

  return withTransaction(async (client) => {
    const teamRows = await client.query<TeamMatch>(
      `SELECT id, division, name, name AS normalized_name
         FROM teams
        WHERE tournament_id = $1
          AND deleted_at IS NULL`,
      [tournamentId]
    );
    const teamsByName = buildTeamSyncLookup(teamRows.rows);
    const summary: GoogleScheduleSyncSummary = {
      enabled: true,
      sheetName: sheet.sheetName,
      parsedRows: parsedRows.length,
      gamesInserted: 0,
      gamesUpdated: 0,
      gamesUnchanged: 0,
      gamesDeleted: 0,
      scoredGamesRetained: 0,
      refsUpdated: 0,
      refsRemoved: 0,
      refsUnchanged: 0,
      streamsLinked: 0,
      skipped: []
    };
    const sourceGameKeys = new Set<string>();
    const sourceLocalDates = new Set<string>();

    const skip = (row: ParsedSheetGame, reason: string) => {
      summary.skipped.push({
        rowNumber: row.rowNumber,
        court: row.court,
        timeLabel: row.timeLabel,
        team1Name: row.team1Name,
        team2Name: row.team2Name,
        refTeamName: row.refTeamName,
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
      sourceGameKeys.add(syncGameKey(row.startsAt, row.court, team1.division, team1.id, team2.id));
      sourceLocalDates.add(row.localDate);

      let targetRefId: number | null = null;
      if (row.refTeamName) {
        const refTeam = teamsByName.get(row.refTeamName) || null;
        if (!refTeam) {
          skip(row, "Unknown ref team name");
        } else if (refTeam.division === team1.division) {
          skip(row, "Ref team is in the same division as the game");
        } else {
          targetRefId = refTeam.id;
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
          [tournamentId, team1.division, row.court, row.startsAt, team1.id, team2.id, targetRefId]
        );
        summary.gamesInserted += 1;
        if (targetRefId && insertResult.rows[0]) summary.refsUpdated += 1;
        continue;
      }

      if (isScored(primary) && !sameGame(primary, team1.division, team1.id, team2.id)) {
        skip(row, "Refusing to overwrite a scored game");
        continue;
      }

      const gameAlreadySame =
        sameGame(primary, team1.division, team1.id, team2.id) &&
        primary.phase === "seeding" &&
        primary.label === null;
      const refAlreadySame = primary.ref_team_id === targetRefId;
      const refTracked = Boolean(row.refTeamName || primary.ref_team_id);

      if (gameAlreadySame && refAlreadySame) {
        summary.gamesUnchanged += 1;
        if (refTracked) summary.refsUnchanged += 1;
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
      if (refTracked) {
        if (refAlreadySame) summary.refsUnchanged += 1;
        else if (targetRefId === null && primary.ref_team_id !== null) summary.refsRemoved += 1;
        else summary.refsUpdated += 1;
      }
    }

    const deleteSummary = await deleteMissingSheetGames(client, tournamentId, sourceGameKeys, sourceLocalDates);
    summary.gamesDeleted = deleteSummary.deleted;
    summary.scoredGamesRetained = deleteSummary.scoredRetained;

    summary.streamsLinked = await linkGamesToExistingCourtStreams(client, tournamentId);
    return summary;
  });
}

async function deleteMissingSheetGames(
  client: { query: (sql: string, params?: unknown[]) => Promise<{ rows: SyncDeleteCandidate[]; rowCount?: number }> },
  tournamentId: number,
  sourceGameKeys: Set<string>,
  sourceLocalDates: Set<string>
) {
  if (!sourceLocalDates.size) return { deleted: 0, scoredRetained: 0 };

  const candidates = await client.query(
    `SELECT games.id, games.phase, games.division, games.court, games.starts_at,
            games.team_1_id, games.team_2_id, games.ref_team_id, games.label,
            games.team_1_score, games.team_2_score, games.winner_team_id, games.loser_team_id,
            games.result_type, games.forfeit_team_id, games.scored_at
       FROM games
       JOIN tournaments ON tournaments.id = games.tournament_id
      WHERE games.tournament_id = $1
        AND games.phase = 'seeding'
        AND games.division = ANY($2::text[])
        AND games.team_1_id IS NOT NULL
        AND games.team_2_id IS NOT NULL
        AND to_char(games.starts_at AT TIME ZONE tournaments.timezone, 'YYYY-MM-DD') = ANY($3::text[])`,
    [tournamentId, ["A", "B", "C", "D"], [...sourceLocalDates]]
  );

  const deleteIds: number[] = [];
  let scoredRetained = 0;
  for (const game of candidates.rows) {
    if (sourceGameKeys.has(syncGameKey(game.starts_at, game.court, game.division, game.team_1_id || 0, game.team_2_id || 0))) continue;
    if (isScored(game)) {
      scoredRetained += 1;
      continue;
    }
    deleteIds.push(game.id);
  }

  if (!deleteIds.length) return { deleted: 0, scoredRetained };
  const deleted = await client.query("DELETE FROM games WHERE id = ANY($1::int[])", [deleteIds]);
  return { deleted: deleted.rowCount || 0, scoredRetained };
}

async function readGoogleSheetRows(spreadsheetId: string, options: { sheetIndex?: string; sheetName?: string; range: string }): Promise<GoogleSheetRows> {
  try {
    const sheetName = await resolveGoogleSheetName(spreadsheetId, {
      sheetIndex: options.sheetIndex,
      sheetName: options.sheetName
    });
    return {
      sheetName,
      values: await readGoogleSheetValues(spreadsheetId, sheetName, options.range)
    };
  } catch (error) {
    if (!isUnsupportedOfficeFileError(error)) throw error;
    return readGoogleDriveWorkbookRows(spreadsheetId, {
      sheetIndex: options.sheetIndex,
      sheetName: options.sheetName,
      range: options.range
    });
  }
}

async function resolveGoogleSheetName(spreadsheetId: string, options: { sheetIndex?: string; sheetName?: string }) {
  const trimmedIndex = options.sheetIndex?.trim();
  const hasExplicitIndex = trimmedIndex !== undefined && trimmedIndex !== "";
  if (!hasExplicitIndex && options.sheetName?.trim()) {
    const requestedName = options.sheetName.trim();
    const sheetNames = await readGoogleSheetNames(spreadsheetId);
    if (sheetNames.includes(requestedName)) return requestedName;
    const fallbackName = sheetNames[defaultSheetIndex];
    if (fallbackName) return fallbackName;
    throw new Error(`Google Sheet tab "${requestedName}" was not found and no fallback tab exists.`);
  }

  const requestedIndex = trimmedIndex === undefined || trimmedIndex === "" ? defaultSheetIndex : Number(trimmedIndex);
  if (Number.isInteger(requestedIndex) && requestedIndex >= 0) {
    return readGoogleSheetNameByIndex(spreadsheetId, requestedIndex);
  }
  throw new Error(`GOOGLE_SCORES_SHEET_INDEX must be a non-negative integer when set. Received: ${options.sheetIndex}`);
}

async function readGoogleSheetNameByIndex(spreadsheetId: string, sheetIndex: number) {
  const sheets = await readGoogleSheetNames(spreadsheetId);
  const selected = sheets[sheetIndex];
  if (!selected) throw new Error(`Google Sheet tab index ${sheetIndex} was not found.`);
  return selected;
}

async function readGoogleSheetNames(spreadsheetId: string) {
  const client = googleJwtClient();
  const accessToken = await client.getAccessToken();
  const token = typeof accessToken === "string" ? accessToken : accessToken?.token;
  if (!token) throw new Error("Unable to obtain a Google access token.");

  const params = new URLSearchParams();
  params.set("fields", "sheets(properties(title,index))");
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}?${params.toString()}`;
  const response = await fetch(url, {
    headers: { authorization: `Bearer ${token}` },
    cache: "no-store"
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Google Sheets metadata read failed (${response.status}): ${body.slice(0, 500)}`);
  }

  const data = (await response.json()) as GoogleSpreadsheetResponse;
  const sheets = (data.sheets || [])
    .map((sheet) => sheet.properties)
    .filter((sheet): sheet is { title: string; index: number } => typeof sheet?.title === "string" && typeof sheet.index === "number")
    .sort((left, right) => left.index - right.index);
  return sheets.map((sheet) => sheet.title);
}

async function readGoogleDriveWorkbookRows(spreadsheetId: string, options: { sheetIndex?: string; sheetName?: string; range: string }): Promise<GoogleSheetRows> {
  const client = googleJwtClient();
  const accessToken = await client.getAccessToken();
  const token = typeof accessToken === "string" ? accessToken : accessToken?.token;
  if (!token) throw new Error("Unable to obtain a Google access token.");

  const params = new URLSearchParams();
  params.set("alt", "media");
  params.set("supportsAllDrives", "true");
  const url = `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(spreadsheetId)}?${params.toString()}`;
  const response = await fetch(url, {
    headers: { authorization: `Bearer ${token}` },
    cache: "no-store"
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Google Drive workbook download failed (${response.status}): ${body.slice(0, 500)}`);
  }

  const workbook = xlsx.read(Buffer.from(await response.arrayBuffer()), { type: "buffer", cellDates: false });
  const sheetName = selectWorkbookSheetName(workbook.SheetNames, {
    sheetIndex: options.sheetIndex,
    sheetName: options.sheetName
  });
  const worksheet = workbook.Sheets[sheetName];
  if (!worksheet) throw new Error(`Workbook sheet "${sheetName}" was not found.`);
  return {
    sheetName,
    values: workbookRangeValues(worksheet, options.range)
  };
}

function selectWorkbookSheetName(sheetNames: string[], options: { sheetIndex?: string; sheetName?: string }) {
  const trimmedIndex = options.sheetIndex?.trim();
  const hasExplicitIndex = trimmedIndex !== undefined && trimmedIndex !== "";
  if (!hasExplicitIndex && options.sheetName?.trim()) {
    const requestedName = options.sheetName.trim();
    const sheetName = findRequestedWorkbookSheetName(sheetNames, requestedName);
    if (sheetName) return sheetName;
    const fallbackName = sheetNames[defaultSheetIndex];
    if (fallbackName) return fallbackName;
    throw new Error(`Workbook sheet "${requestedName}" was not found and no fallback tab exists.`);
  }

  const requestedIndex = trimmedIndex === undefined || trimmedIndex === "" ? defaultSheetIndex : Number(trimmedIndex);
  if (Number.isInteger(requestedIndex) && requestedIndex >= 0) {
    const sheetName = sheetNames[requestedIndex];
    if (!sheetName) throw new Error(`Workbook sheet index ${requestedIndex} was not found.`);
    return sheetName;
  }
  throw new Error(`GOOGLE_SCORES_SHEET_INDEX must be a non-negative integer when set. Received: ${options.sheetIndex}`);
}

function findRequestedWorkbookSheetName(sheetNames: string[], requestedName: string) {
  const exact = sheetNames.find((candidate) => candidate === requestedName);
  if (exact) return exact;

  const normalizedRequested = normalizeSheetName(requestedName);
  const normalized = sheetNames.find((candidate) => normalizeSheetName(candidate) === normalizedRequested);
  if (normalized) return normalized;

  const excelSafeRequested = excelSafeSheetName(requestedName);
  return sheetNames.find((candidate) => candidate === excelSafeRequested || normalizeSheetName(candidate) === normalizeSheetName(excelSafeRequested));
}

function excelSafeSheetName(value: string) {
  return value.replace(/[:\\/?*[\]]/g, "").slice(0, 31);
}

function normalizeSheetName(value: string) {
  return value.trim().replace(/\s+/g, " ").toLowerCase();
}

function workbookRangeValues(worksheet: xlsx.WorkSheet, range: string) {
  return xlsx.utils
    .sheet_to_json<unknown[]>(worksheet, {
      header: 1,
      defval: "",
      raw: false,
      range
    })
    .map((row) => row.map((cell) => String(cell ?? "").trim()));
}

function isUnsupportedOfficeFileError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes("not supported for this document") || message.includes("must not be an Office file");
}

async function readGoogleSheetValues(spreadsheetId: string, sheetName: string, range: string) {
  const client = googleJwtClient();
  const accessToken = await client.getAccessToken();
  const token = typeof accessToken === "string" ? accessToken : accessToken?.token;
  if (!token) throw new Error("Unable to obtain a Google access token.");

  const params = new URLSearchParams();
  params.set("majorDimension", "ROWS");
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}/values/${encodeURIComponent(a1Range(sheetName, range))}?${params.toString()}`;
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

function a1Range(sheetName: string, range: string) {
  return `'${sheetName.replace(/'/g, "''")}'!${range}`;
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
    scopes: ["https://www.googleapis.com/auth/spreadsheets.readonly", "https://www.googleapis.com/auth/drive.readonly"]
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
  const parts = text.split(/\s+[-\u2013\u2014]\s+/);
  return normalizeTeamName(parts.length > 1 ? parts.slice(1).join(" - ") : text);
}

function refTeamNameFromSheetCell(value: unknown) {
  const text = cellText(value).replace(/\s+/g, " ");
  if (!text || /^ref name$/i.test(text) || text === "?" || /^unlimited ref\b/i.test(text)) return "";
  const normalized = teamNameFromSheetCell(text);
  return normalizeTeamName(refTeamNameAliases[normalized] || normalized);
}

function buildTeamSyncLookup(teams: TeamMatch[]) {
  const lookup = new Map<string, TeamMatch>();
  for (const team of teams) lookup.set(normalizeTeamName(team.name), team);

  for (const definition of Object.values(teamSyncDefinitions)) {
    const aliases = definition.names.map(normalizeTeamName);
    const matches = teams.filter((team) => team.division === definition.division && aliases.includes(normalizeTeamName(team.name)));
    if (matches.length !== 1) continue;
    const team = matches[0];
    for (const alias of [...definition.names, ...definition.codes]) {
      lookup.set(normalizeTeamName(alias), team);
    }
  }
  for (const [alias, canonicalName] of Object.entries(refTeamNameAliases)) {
    const team = lookup.get(normalizeTeamName(canonicalName));
    if (team) lookup.set(normalizeTeamName(alias), team);
  }

  return lookup;
}

function normalizeTeamName(value: string) {
  return value
    .trim()
    .replace(/\s+/g, " ")
    .replace(/[\u2018\u2019]/g, "'")
    .toLowerCase();
}

function effectiveGoogleScheduleSheetName(value: string | undefined) {
  const trimmed = value?.trim();
  if (!trimmed || staleScheduleSheetNames.has(normalizeSheetName(trimmed))) return currentScheduleSheetName;
  return trimmed;
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

function syncGameKey(startsAt: string | Date, court: number, division: string, team1Id: number, team2Id: number) {
  const millis = startsAt instanceof Date ? startsAt.getTime() : Date.parse(startsAt);
  const timeKey = Number.isFinite(millis) ? String(millis) : String(startsAt);
  return [timeKey, court, division, team1Id, team2Id].join("|");
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
