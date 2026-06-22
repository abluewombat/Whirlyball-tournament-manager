import fs from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { buildScheduleRulesReport } from "../lib/schedule-rules.ts";

const defaultTournamentSlug = "novi-2026";
const defaultSyncStart = "2026-06-23T00:00:00-04:00";
const defaultSyncEnd = "2026-06-28T00:00:00-04:00";

const defaultTeamDefinitions = {
  "ATL A": { division: "A", names: ["Not In The Realm"] },
  "ATL B": { division: "B", names: ["The Remnants"] },
  "CHI A": { division: "A", names: ["Lake Effect"] },
  "CHI B1": { division: "B", names: ["Goal-A-Dinga"] },
  "CHI B2": { division: "B", names: ["Dead Horse"] },
  "CHI C1": { division: "C", names: ["Mean Whirls"] },
  "CHI C2": { division: "C", names: ["Maximum Effort"] },
  "CHI C3": { division: "C", names: ["Squad Goals"] },
  "CHI D": { division: "D", names: ["SWATTY BALLZ"] },
  "CLEV A": { division: "A", names: ["WhirlyHausen"] },
  "CLEV C1": { division: "C", names: ["Whirld of Hurt"] },
  "CLEV C2": { division: "C", names: ["The BWC", "The BWC (Buckeye Whirly Club)"] },
  "CLEV C3": { division: "C", names: ["Two Fams & a Weatherman"] },
  "CLEV D": { division: "D", names: ["The Goon Squad"] },
  "MICH A1": { division: "A", names: ["Hey You Guys"] },
  "MICH A2": { division: "A", names: ["Goal Diggers"] },
  "MICH A3": { division: "A", names: ["Shots Fired"] },
  "MICH C": { division: "C", names: ["MixT Up"] },
  "MICH D1": { division: "D", names: ["Motown Motion"] },
  "MICH D2": { division: "D", names: ["Designated Drunk Drivers"] },
  "MINN B": { division: "B", names: ["Whirly Sirs"] },
  "MINN C": { division: "C", names: ["Whirly Blue Balls"] },
  "MINN D": { division: "D", names: ["4 Lefts 1 Wrong"] },
  "SEA A1": { division: "A", names: ["A-Rex"] },
  "SEA A2": { division: "A", names: ["Brick City"] },
  "SEA A3": { division: "A", names: ["Goat Herders"] },
  "SEA B1": { division: "B", names: ["Whirlocks"] },
  "SEA B2": { division: "B", names: ["Gooey Ducks"] },
  "SEA C1": { division: "C", names: ["Seattle Sea Devils"] },
  "SEA C2": { division: "C", names: ["Whirld War C"] },
  "SEA C3": { division: "C", names: ["Whirled Not Stirred"] },
  "SEA C4": { division: "C", names: ["Cherry Peckers"] },
  "SEA D": { division: "D", names: ["Hollaback Whirl"] },
  "TEX A1": { division: "A", names: ["SouthBound & Down"] },
  "TEX A2": { division: "A", names: ["Los Guapos"] },
  "TEX B1": { division: "B", names: ["Team USA"] },
  "TEX C": { division: "C", names: ["First Weld Problems"] },
  "TEX D1": { division: "D", names: ["The 30%ers"] },
  "TEX D2": { division: "D", names: ["I Don't Remember"] }
};

function usage() {
  return `Usage:
  npm run admin:import-schedule -- --input schedule.json --apply
  npm run admin:import-schedule -- --input schedule.csv --apply
  npm run admin:import-schedule -- --pdf schedule.pdf --apply

Options:
  --input <path>             JSON or CSV import file.
  --pdf <path>               PDF schedule. Requires pdftotext in PATH.
  --text <path>              Text extracted from a PDF.
  --apply                    Write changes. Omit for dry-run validation.
  --delete-missing           Delete import-window seeding games not present in the file.
  --allow-scored-overwrite   Allow updating/deleting scored rows. Default refuses.
  --tournament <slug>        Tournament slug. Default: ${defaultTournamentSlug}
  --sync-start <iso>         Delete-missing window start. Default: ${defaultSyncStart}
  --sync-end <iso>           Delete-missing window end. Default: ${defaultSyncEnd}
  --teams <path>             Optional team code JSON override/extension.
  --out-json <path>          Write normalized games JSON and exit unless --apply is set.
  --help                     Show this help.

Accepted JSON shape:
  { "games": [{ "starts_at": "2026-06-23T19:00:00-04:00", "court": 1,
    "division": "A", "team_1_code": "MICH A1", "team_2_code": "SEA A1",
    "ref_team_code": "CHI B1" }] }

Accepted CSV headers:
  starts_at,court,division,team_1_code,team_2_code,ref_team_code
`;
}

const args = parseArgs(process.argv.slice(2));
if (args.help) {
  console.log(usage());
  process.exit(0);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});

async function main() {
  const inputGames = await loadInputGames(args);
  const games = normalizeGames(inputGames);
  validateGames(games);

  if (args.outJson) {
    await fs.writeFile(args.outJson, `${JSON.stringify({ games }, null, 2)}\n`);
  }

  if (!args.apply && !args.outJson) {
    console.log(JSON.stringify({ dryRun: true, games: games.length, message: "No --apply passed; database was not changed." }, null, 2));
    return;
  }

  if (!args.apply) {
    console.log(JSON.stringify({ dryRun: true, games: games.length, wrote: args.outJson, message: "No --apply passed; database was not changed." }, null, 2));
    return;
  }

  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error("DATABASE_URL is required. Use --env-file-if-exists=.env.local or export DATABASE_URL.");

  const { default: pg } = await import("pg");
  const { Pool } = pg;
  const pool = new Pool({
    connectionString: databaseUrl,
    ssl: databaseUrl.includes("localhost") || databaseUrl.includes("127.0.0.1") ? false : { rejectUnauthorized: false },
    max: 3
  });

  try {
    const result = await withClientTransaction(pool, async (client) => {
      const tournamentSlug = args.tournament || defaultTournamentSlug;
      const tournament = await one(client, "SELECT id, slug FROM tournaments WHERE slug = $1", [tournamentSlug]);
      if (!tournament) throw new Error(`Tournament not found: ${tournamentSlug}`);

      const teams = await query(
        client,
        `SELECT teams.id, teams.division, teams.name, teams.early_available, COALESCE(centers.name, 'Draft') as center_name
         FROM teams LEFT JOIN centers ON centers.id = teams.center_id
         WHERE teams.tournament_id = $1 AND teams.deleted_at IS NULL
         ORDER BY teams.division, center_name, teams.name`,
        [tournament.id]
      );
      const teamDefinitions = await loadTeamDefinitions(args.teams);
      const teamByCode = buildTeamLookup(teams, teamDefinitions);
      assertAllImportTeamsExist(games, teamByCode);

      await createSnapshot(client, tournament.id, `Pre schedule import ${new Date().toISOString()}`);
      const importResult = await upsertGames(client, {
        tournamentId: tournament.id,
        games,
        teamByCode,
        deleteMissing: Boolean(args.deleteMissing),
        allowScoredOverwrite: Boolean(args.allowScoredOverwrite),
        syncStart: args.syncStart || defaultSyncStart,
        syncEnd: args.syncEnd || defaultSyncEnd
      });
      const rulesReport = await buildRulesReport(client, tournament.id);
      await client.query(
        "UPDATE tournament_settings SET schedule_rules_report_json = $1::jsonb, updated_at = NOW() WHERE tournament_id = $2",
        [JSON.stringify(rulesReport), tournament.id]
      );

      return {
        tournament: tournament.slug,
        ...importResult,
        scheduleRuleStatus: rulesReport.status,
        scheduleRuleIssues: rulesReport.issueCount,
        ownDivisionRefIssues: rulesReport.rules.find((rule) => rule.id === "ref-division-eligibility")?.issueCount || 0
      };
    });
    console.log(JSON.stringify(result, null, 2));
  } finally {
    await pool.end();
  }
}

function parseArgs(argv) {
  const parsed = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith("--")) throw new Error(`Unexpected argument: ${arg}`);
    const key = arg.slice(2).replace(/-([a-z])/g, (_, char) => char.toUpperCase());
    if (["apply", "deleteMissing", "allowScoredOverwrite", "help"].includes(key)) {
      parsed[key] = true;
      continue;
    }
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`Missing value for ${arg}`);
    parsed[key] = value;
    index += 1;
  }
  return parsed;
}

async function loadInputGames(options) {
  const sources = [options.input, options.pdf, options.text].filter(Boolean);
  if (sources.length !== 1) throw new Error("Pass exactly one of --input, --pdf, or --text.");
  if (options.input) {
    const raw = await fs.readFile(options.input, "utf8");
    if (options.input.toLowerCase().endsWith(".csv")) return parseCsvGames(raw);
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : parsed.games;
  }
  const text = options.pdf ? extractPdfText(options.pdf) : await fs.readFile(options.text, "utf8");
  return parseTextGames(text);
}

function extractPdfText(path) {
  const result = spawnSync("pdftotext", ["-layout", path, "-"], { encoding: "utf8" });
  if (result.error?.code === "ENOENT") {
    throw new Error("Direct PDF import requires pdftotext. Install Poppler (`brew install poppler`) or pass --text/--input JSON.");
  }
  if (result.status !== 0) throw new Error(`pdftotext failed: ${result.stderr || result.stdout}`);
  return result.stdout;
}

function parseTextGames(text) {
  const games = [];
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(/\s+/g, " ").trim();
    if (!line) continue;
    const startsAt = parseLineDateTime(line);
    const court = parseLineCourt(line);
    const codes = [...line.matchAll(/\b(ATL|CHI|CLEV|MICH|MINN|SEA|TEX)\s+(?:A|B|C|D)\d?\b/g)].map((match) => normalizeCode(match[0]));
    const division = parseLineDivision(line, codes);
    if (!startsAt || !court || !division || codes.length < 2) continue;
    games.push({
      starts_at: startsAt,
      court,
      division,
      team_1_code: codes[0],
      team_2_code: codes[1],
      ref_team_code: codes[2] || null
    });
  }
  if (!games.length) {
    throw new Error("No games were parsed from text. Use --out-json with a manually prepared JSON file for this PDF layout.");
  }
  return games;
}

function parseLineDateTime(line) {
  const iso = line.match(/\b(2026-\d{2}-\d{2})[ T](\d{1,2}):(\d{2})(?::\d{2})?(?:\s*(-04:00))?\b/);
  if (iso) return `${iso[1]}T${iso[2].padStart(2, "0")}:${iso[3]}:00${iso[4] || "-04:00"}`;
  const us = line.match(/\b(\d{1,2})[/-](\d{1,2})(?:[/-](\d{2,4}))?\s+(\d{1,2}):(\d{2})\s*(AM|PM)?\b/i);
  if (!us) return null;
  const year = us[3] ? normalizeYear(us[3]) : "2026";
  let hour = Number(us[4]);
  const minute = us[5];
  const meridiem = us[6]?.toUpperCase();
  if (meridiem === "PM" && hour < 12) hour += 12;
  if (meridiem === "AM" && hour === 12) hour = 0;
  return `${year}-${us[1].padStart(2, "0")}-${us[2].padStart(2, "0")}T${String(hour).padStart(2, "0")}:${minute}:00-04:00`;
}

function parseLineCourt(line) {
  const match = line.match(/\b(?:court|ct|c)\s*([12])\b/i);
  if (match) return Number(match[1]);
  const leading = line.match(/^\s*([12])\s+/);
  return leading ? Number(leading[1]) : null;
}

function parseLineDivision(line, codes) {
  const explicit = line.match(/\b(?:division|div)\s*([ABCD])\b/i) || line.match(/\b([ABCD])\s+(?:R\d+|Seed|Seeding|Game)\b/i);
  if (explicit) return explicit[1].toUpperCase();
  const divisions = [...new Set(codes.map((code) => code.match(/\s+([ABCD])/)?.[1]).filter(Boolean))];
  return divisions.length === 1 ? divisions[0] : null;
}

function normalizeYear(value) {
  return value.length === 2 ? `20${value}` : value;
}

function normalizeGames(games) {
  if (!Array.isArray(games)) throw new Error("Expected games array.");
  return games.map((game, index) => ({
    starts_at: normalizeStartsAt(game.starts_at || game.startsAt, index),
    court: Number(game.court),
    division: String(game.division || "").trim(),
    team_1_code: normalizeCode(game.team_1_code || game.team1Code || game.team_1 || game.team1),
    team_2_code: normalizeCode(game.team_2_code || game.team2Code || game.team_2 || game.team2),
    ref_team_code: game.ref_team_code || game.refTeamCode || game.ref ? normalizeCode(game.ref_team_code || game.refTeamCode || game.ref) : null
  }));
}

function normalizeStartsAt(value, index) {
  const text = String(value || "").trim();
  if (!text) throw new Error(`Missing starts_at at index ${index}`);
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(text)) return `${text}:00-04:00`;
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:00$/.test(text)) return `${text}-04:00`;
  return text;
}

function normalizeCode(value) {
  return String(value || "").toUpperCase().replace(/\s+/g, " ").trim();
}

function validateGames(games) {
  const seen = new Set();
  for (const [index, game] of games.entries()) {
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:00(?:Z|[+-]\d{2}:\d{2})$/.test(game.starts_at)) throw new Error(`Invalid starts_at at index ${index}: ${game.starts_at}`);
    if (Number.isNaN(new Date(game.starts_at).getTime())) throw new Error(`Unparseable starts_at at index ${index}: ${game.starts_at}`);
    if (![1, 2].includes(game.court)) throw new Error(`Invalid court at index ${index}: ${game.court}`);
    if (!["A", "B", "C", "D"].includes(game.division)) throw new Error(`Invalid division at index ${index}: ${game.division}`);
    if (!game.team_1_code || !game.team_2_code) throw new Error(`Missing team code at index ${index}`);
    const key = slotKey(game.starts_at, game.court);
    if (seen.has(key)) throw new Error(`Duplicate incoming slot at index ${index}: ${game.starts_at} court ${game.court}`);
    seen.add(key);
  }
}

function parseCsvGames(raw) {
  const [headerLine, ...lines] = raw.split(/\r?\n/).filter((line) => line.trim());
  const headers = parseCsvLine(headerLine).map((header) => header.trim());
  return lines.map((line) => {
    const values = parseCsvLine(line);
    return Object.fromEntries(headers.map((header, index) => [header, values[index] || ""]));
  });
}

function parseCsvLine(line) {
  const values = [];
  let current = "";
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (char === '"' && line[index + 1] === '"') {
      current += '"';
      index += 1;
    } else if (char === '"') {
      quoted = !quoted;
    } else if (char === "," && !quoted) {
      values.push(current);
      current = "";
    } else {
      current += char;
    }
  }
  values.push(current);
  return values;
}

async function loadTeamDefinitions(path) {
  if (!path) return defaultTeamDefinitions;
  const parsed = JSON.parse(await fs.readFile(path, "utf8"));
  return { ...defaultTeamDefinitions, ...parsed };
}

function buildTeamLookup(teams, definitions) {
  const byCode = {};
  for (const [code, definition] of Object.entries(definitions)) {
    const aliases = new Set(definition.names.map(normalizeName));
    const matches = teams.filter((team) => team.division === definition.division && aliases.has(normalizeName(team.name)));
    if (matches.length > 1) throw new Error(`Ambiguous team definition for ${code}: ${matches.map((team) => team.name).join(", ")}`);
    byCode[code] = matches[0] || null;
  }
  return byCode;
}

function assertAllImportTeamsExist(games, teamByCode) {
  const missing = new Set();
  for (const game of games) {
    for (const code of [game.team_1_code, game.team_2_code, game.ref_team_code].filter(Boolean)) {
      if (!teamByCode[code]) missing.add(code);
    }
  }
  if (missing.size) throw new Error(`Missing team code mappings or teams: ${[...missing].sort().join(", ")}`);
}

async function upsertGames(client, { tournamentId, games, teamByCode, deleteMissing, allowScoredOverwrite, syncStart, syncEnd }) {
  let inserted = 0;
  let updated = 0;
  let unchanged = 0;
  let removed = 0;
  let duplicateRowsDeleted = 0;
  const incomingSlots = new Set();

  for (const game of games) {
    const team1 = teamByCode[game.team_1_code];
    const team2 = teamByCode[game.team_2_code];
    const refTeam = game.ref_team_code ? teamByCode[game.ref_team_code] : null;
    incomingSlots.add(slotKey(game.starts_at, game.court));

    if (team1.division !== game.division) throw new Error(`Division mismatch: ${game.team_1_code} is ${team1.division}, row is ${game.division}`);
    if (team2.division !== game.division) throw new Error(`Division mismatch: ${game.team_2_code} is ${team2.division}, row is ${game.division}`);
    if (refTeam?.division === game.division) throw new Error(`Own-division ref blocked: ${game.ref_team_code} refs ${game.division} at ${game.starts_at} court ${game.court}`);

    const existingRows = await query(
      client,
      `SELECT *
       FROM games
       WHERE tournament_id = $1 AND court = $2 AND starts_at = $3::timestamptz
       ORDER BY id`,
      [tournamentId, game.court, game.starts_at]
    );
    const sameExisting = existingRows.find((row) => sameGame(row, game.division, team1.id, team2.id));
    const primary = sameExisting || existingRows.find((row) => !isScored(row)) || existingRows[0];

    if (!primary) {
      await client.query(
        `INSERT INTO games (tournament_id, phase, division, court, starts_at, team_1_id, team_2_id, ref_team_id, label)
         VALUES ($1, 'seeding', $2, $3, $4::timestamptz, $5, $6, $7, NULL)`,
        [tournamentId, game.division, game.court, game.starts_at, team1.id, team2.id, refTeam?.id || null]
      );
      inserted += 1;
      continue;
    }

    if (isScored(primary) && !allowScoredOverwrite && !sameGame(primary, game.division, team1.id, team2.id)) {
      throw new Error(`Refusing to overwrite scored game at ${game.starts_at} court ${game.court}`);
    }

    for (const duplicate of existingRows.filter((row) => row.id !== primary.id)) {
      if (isScored(duplicate) && !allowScoredOverwrite) throw new Error(`Refusing to delete scored duplicate at ${game.starts_at} court ${game.court}`);
      await client.query("DELETE FROM games WHERE id = $1", [duplicate.id]);
      duplicateRowsDeleted += 1;
    }

    const alreadySame = sameGame(primary, game.division, team1.id, team2.id) && primary.phase === "seeding" && primary.ref_team_id === (refTeam?.id || null) && !primary.label;
    await client.query(
      `UPDATE games
       SET phase = 'seeding',
           division = $2,
           team_1_id = $3,
           team_2_id = $4,
           ref_team_id = $5,
           label = NULL,
           team_1_score = CASE WHEN $6::boolean THEN NULL ELSE team_1_score END,
           team_2_score = CASE WHEN $6::boolean THEN NULL ELSE team_2_score END,
           winner_team_id = CASE WHEN $6::boolean THEN NULL ELSE winner_team_id END,
           loser_team_id = CASE WHEN $6::boolean THEN NULL ELSE loser_team_id END,
           result_type = CASE WHEN $6::boolean THEN NULL ELSE result_type END,
           forfeit_team_id = CASE WHEN $6::boolean THEN NULL ELSE forfeit_team_id END,
           scored_by = CASE WHEN $6::boolean THEN NULL ELSE scored_by END,
           scored_at = CASE WHEN $6::boolean THEN NULL ELSE scored_at END
       WHERE id = $1`,
      [primary.id, game.division, team1.id, team2.id, refTeam?.id || null, Boolean(allowScoredOverwrite)]
    );
    if (alreadySame) unchanged += 1;
    else updated += 1;
  }

  if (deleteMissing) {
    const existingRows = await query(
      client,
      `SELECT *
       FROM games
       WHERE tournament_id = $1
         AND phase = 'seeding'
         AND team_1_id IS NOT NULL
         AND team_2_id IS NOT NULL
         AND starts_at >= $2::timestamptz
         AND starts_at < $3::timestamptz
       ORDER BY starts_at, court, id`,
      [tournamentId, syncStart, syncEnd]
    );
    for (const row of existingRows) {
      if (incomingSlots.has(slotKey(row.starts_at, row.court))) continue;
      if (isScored(row) && !allowScoredOverwrite) throw new Error(`Refusing to delete scored game id ${row.id}`);
      await client.query("DELETE FROM games WHERE id = $1", [row.id]);
      removed += 1;
    }
  }

  return { received: games.length, inserted, updated, unchanged, removed, duplicateRowsDeleted };
}

async function buildRulesReport(client, tournamentId) {
  const [games, teams, availabilityBlocks, settingsRows] = await Promise.all([
    query(
      client,
      `SELECT id, phase, division, court, starts_at, team_1_id, team_2_id, ref_team_id, label
       FROM games
       WHERE tournament_id = $1
       ORDER BY starts_at, court, id`,
      [tournamentId]
    ),
    query(
      client,
      `SELECT teams.id, teams.division, teams.name, teams.early_available, COALESCE(centers.name, 'Draft') as center
       FROM teams LEFT JOIN centers ON centers.id = teams.center_id
       WHERE teams.tournament_id = $1 AND teams.deleted_at IS NULL
       ORDER BY teams.division, center, teams.name`,
      [tournamentId]
    ),
    query(
      client,
      `SELECT team_availability_blocks.id, team_availability_blocks.team_id,
              team_availability_blocks.starts_at, team_availability_blocks.ends_at,
              team_availability_blocks.reason
       FROM team_availability_blocks
       JOIN teams ON teams.id = team_availability_blocks.team_id
       WHERE teams.tournament_id = $1 AND teams.deleted_at IS NULL
       ORDER BY team_availability_blocks.starts_at, team_availability_blocks.id`,
      [tournamentId]
    ),
    query(client, "SELECT schedule_settings_json FROM tournament_settings WHERE tournament_id = $1", [tournamentId])
  ]);
  return buildScheduleRulesReport({
    games,
    teams,
    availabilityBlocks,
    settings: settingsRows[0]?.schedule_settings_json || {}
  });
}

async function createSnapshot(client, tournamentId, label) {
  const [
    teams,
    availabilityBlocks,
    players,
    shirtOrders,
    games,
    blockerRequests,
    brackets,
    bracketGames,
    settings,
    tournamentDivisions,
    people,
    courtStreams
  ] = await Promise.all([
    query(client, "SELECT * FROM teams WHERE tournament_id = $1", [tournamentId]),
    query(client, "SELECT team_availability_blocks.* FROM team_availability_blocks JOIN teams ON teams.id = team_availability_blocks.team_id WHERE teams.tournament_id = $1", [tournamentId]),
    query(client, "SELECT * FROM players WHERE tournament_id = $1", [tournamentId]),
    query(client, "SELECT shirt_orders.* FROM shirt_orders JOIN players ON players.id = shirt_orders.player_id WHERE players.tournament_id = $1", [tournamentId]),
    query(client, "SELECT * FROM games WHERE tournament_id = $1", [tournamentId]),
    query(client, "SELECT * FROM blocker_requests WHERE tournament_id = $1", [tournamentId]),
    query(client, "SELECT * FROM brackets WHERE tournament_id = $1", [tournamentId]),
    query(client, "SELECT bracket_games.* FROM bracket_games JOIN brackets ON brackets.id = bracket_games.bracket_id WHERE brackets.tournament_id = $1", [tournamentId]),
    query(client, "SELECT * FROM tournament_settings WHERE tournament_id = $1", [tournamentId]),
    query(client, "SELECT * FROM tournament_divisions WHERE tournament_id = $1", [tournamentId]),
    query(client, "SELECT DISTINCT people.* FROM people JOIN players ON players.person_id = people.id WHERE players.tournament_id = $1", [tournamentId]),
    query(client, "SELECT * FROM court_streams WHERE tournament_id = $1", [tournamentId])
  ]);
  await client.query("INSERT INTO state_snapshots (tournament_id, label, data_json) VALUES ($1, $2, $3::jsonb)", [
    tournamentId,
    label,
    JSON.stringify({
      people,
      tournament_divisions: tournamentDivisions,
      tournament_settings: settings,
      court_streams: courtStreams,
      teams,
      team_availability_blocks: availabilityBlocks,
      players,
      shirt_orders: shirtOrders,
      games,
      blocker_requests: blockerRequests,
      brackets,
      bracket_games: bracketGames
    })
  ]);
}

async function withClientTransaction(pool, callback) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await callback(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function query(client, sql, params = []) {
  const result = await client.query(sql, params);
  return result.rows;
}

async function one(client, sql, params = []) {
  const rows = await query(client, sql, params);
  return rows[0] || null;
}

function normalizeName(value) {
  return String(value || "").toLowerCase().replace(/[’]/g, "'").replace(/\s+/g, " ").trim();
}

function isScored(game) {
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

function sameGame(game, division, team1Id, team2Id) {
  return game.division === division && game.team_1_id === team1Id && game.team_2_id === team2Id;
}

function slotKey(startsAt, court) {
  return `${new Date(startsAt).toISOString()}|${court}`;
}
