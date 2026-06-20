import pg from "pg";
import { buildScheduleRulesReport } from "../lib/schedule-rules.ts";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required. Run with `node --env-file=.env.local scripts/audit-prod-schedule.mjs` locally.");

const pool = new pg.Pool({
  connectionString: databaseUrl,
  ssl: databaseUrl.includes("localhost") || databaseUrl.includes("127.0.0.1") ? false : { rejectUnauthorized: false },
  max: 3
});

try {
  const tournament = await resolveTournament();
  const settings = await loadScheduleSettings(tournament.id);
  const [games, teams, blocks] = await Promise.all([loadGames(tournament.id), loadTeams(tournament.id), loadBlocks(tournament.id)]);
  const rulesReport = buildScheduleRulesReport({
    games,
    teams,
    availabilityBlocks: blocks,
    settings
  });
  const ruleById = new Map(rulesReport.rules.map((rule) => [rule.id, rule]));
  const report = {
    tournament: {
      id: tournament.id,
      name: tournament.name,
      slug: tournament.slug
    },
    games: games.length,
    teams: teams.length,
    blockers: blocks.length,
    status: rulesReport.status,
    issueCount: rulesReport.issueCount,
    blockedRefAssignments: ruleById.get("blocked-ref-assignments")?.issueCount || 0,
    blockedRefExamples: ruleById.get("blocked-ref-assignments")?.issues.slice(0, 30) || [],
    firstLastDivisionConflicts: ruleById.get("first-last-division")?.issueCount || 0,
    firstLastDivisionExamples: ruleById.get("first-last-division")?.issues.slice(0, 30) || [],
    concurrentCourtConflicts: ruleById.get("cross-court-buffer")?.issueCount || 0,
    concurrentCourtExamples: ruleById.get("cross-court-buffer")?.issues.slice(0, 30) || []
  };

  console.log(JSON.stringify(report, null, 2));
  if (rulesReport.issueCount) process.exitCode = 1;
} finally {
  await pool.end();
}

async function resolveTournament() {
  if (process.env.TOURNAMENT_ID) {
    const result = await pool.query("SELECT * FROM tournaments WHERE id = $1", [Number(process.env.TOURNAMENT_ID)]);
    if (!result.rows[0]) throw new Error(`Tournament not found: ${process.env.TOURNAMENT_ID}`);
    return result.rows[0];
  }
  if (process.env.TOURNAMENT_SLUG) {
    const result = await pool.query("SELECT * FROM tournaments WHERE slug = $1", [process.env.TOURNAMENT_SLUG]);
    if (!result.rows[0]) throw new Error(`Tournament not found: ${process.env.TOURNAMENT_SLUG}`);
    return result.rows[0];
  }
  const result = await pool.query(`
    SELECT *
    FROM tournaments
    ORDER BY
      CASE WHEN status = 'active' THEN 0 WHEN status = 'upcoming' THEN 1 ELSE 2 END,
      featured DESC,
      CASE WHEN status = 'past' THEN starts_on END DESC,
      CASE WHEN status <> 'past' THEN starts_on END ASC,
      id DESC
    LIMIT 1
  `);
  if (!result.rows[0]) throw new Error("No tournament found.");
  return result.rows[0];
}

async function loadScheduleSettings(tournamentId) {
  const result = await pool.query("SELECT schedule_settings_json FROM tournament_settings WHERE tournament_id = $1", [tournamentId]);
  return result.rows[0]?.schedule_settings_json || {};
}

async function loadGames(tournamentId) {
  const result = await pool.query(
    `SELECT id, tournament_id, phase, division, court, starts_at,
            team_1_id, team_2_id, ref_team_id, label
     FROM games
     WHERE tournament_id = $1
     ORDER BY starts_at, court, id`,
    [tournamentId]
  );
  return result.rows;
}

async function loadTeams(tournamentId) {
  const result = await pool.query(
    `SELECT teams.id, teams.tournament_id, teams.name, teams.division, COALESCE(centers.name, 'Draft') as center
     FROM teams
     LEFT JOIN centers ON centers.id = teams.center_id
     WHERE teams.tournament_id = $1 AND teams.deleted_at IS NULL
     ORDER BY teams.division, centers.name, teams.name`,
    [tournamentId]
  );
  return result.rows;
}

async function loadBlocks(tournamentId) {
  const result = await pool.query(
    `SELECT team_availability_blocks.id, team_availability_blocks.team_id,
            team_availability_blocks.starts_at, team_availability_blocks.ends_at,
            team_availability_blocks.reason
     FROM team_availability_blocks
     JOIN teams ON teams.id = team_availability_blocks.team_id
     WHERE teams.tournament_id = $1 AND teams.deleted_at IS NULL
     ORDER BY team_availability_blocks.starts_at, team_availability_blocks.id`,
    [tournamentId]
  );
  return result.rows;
}
