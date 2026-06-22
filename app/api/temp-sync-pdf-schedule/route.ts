import { NextResponse } from "next/server";
import { withTransaction } from "@/lib/db";
import { estimateUnfilledStreamGameStarts, linkGamesToExistingCourtStreams } from "@/lib/streams";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type IncomingGame = {
  starts_at: string;
  court: number;
  division: string;
  team_1_code: string;
  team_2_code: string;
  ref_team_code?: string | null;
};

type DbTeam = {
  id: number;
  division: string;
  name: string;
};

type DbGame = {
  id: number;
  phase: string;
  division: string;
  court: number;
  starts_at: Date;
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

const tournamentSlug = "novi-2026";
const syncStart = "2026-06-23T00:00:00-04:00";
const syncEnd = "2026-06-28T00:00:00-04:00";

const teamDefinitions: Record<string, { division: string; names: string[] }> = {
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

export async function POST(request: Request) {
  const seedTokenMatches = Boolean(process.env.TEMP_SEED_TOKEN && request.headers.get("x-seed-token") === process.env.TEMP_SEED_TOKEN);
  const adminPasswordMatches = Boolean(process.env.ADMIN_PASSWORD && request.headers.get("x-admin-password") === process.env.ADMIN_PASSWORD);
  if (!seedTokenMatches && !adminPasswordMatches) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const payload = (await request.json()) as { games?: IncomingGame[]; deleteMissing?: boolean };
  if (!Array.isArray(payload.games)) {
    return NextResponse.json({ error: "Expected games array" }, { status: 400 });
  }

  const validationError = validateIncomingGames(payload.games);
  if (validationError) return NextResponse.json({ error: validationError }, { status: 400 });

  try {
    const result = await withTransaction(async (client) => {
      const tournamentResult = await client.query<{ id: number }>("SELECT id FROM tournaments WHERE slug = $1", [tournamentSlug]);
      const tournamentId = tournamentResult.rows[0]?.id;
      if (!tournamentId) throw new Error(`Tournament not found: ${tournamentSlug}`);

      const teamResult = await client.query<DbTeam>(
        "SELECT id, division, name FROM teams WHERE tournament_id = $1 AND deleted_at IS NULL",
        [tournamentId]
      );
      const teamByCode = buildTeamLookup(teamResult.rows);

      const missingTeams = Object.entries(teamByCode)
        .filter(([, team]) => !team)
        .map(([code]) => code);
      if (missingTeams.length) throw new Error(`Missing teams: ${missingTeams.join(", ")}`);

      let inserted = 0;
      let updated = 0;
      let unchanged = 0;
      let duplicateRowsDeleted = 0;
      const incomingSlots = new Set<string>();

      for (const game of payload.games || []) {
        const team1 = teamByCode[game.team_1_code];
        const team2 = teamByCode[game.team_2_code];
        if (!team1 || !team2) throw new Error(`Unknown team code in game: ${game.team_1_code} vs ${game.team_2_code}`);
        const hasRefTeamCode = Object.hasOwn(game, "ref_team_code");
        const refTeam = game.ref_team_code ? teamByCode[game.ref_team_code] : null;
        if (game.ref_team_code && !refTeam) throw new Error(`Unknown ref team code in game: ${game.ref_team_code}`);

        incomingSlots.add(slotKey(game.starts_at, game.court));
        const existingResult = await client.query<DbGame>(
          `SELECT *
           FROM games
           WHERE tournament_id = $1 AND court = $2 AND starts_at = $3::timestamptz
           ORDER BY id`,
          [tournamentId, game.court, game.starts_at]
        );
        const existingRows = existingResult.rows;
        const sameExisting = existingRows.find((row) => sameGame(row, game.division, team1.id, team2.id));
        const primary = sameExisting || existingRows.find((row) => !isScored(row)) || existingRows[0];

        if (!primary) {
          await client.query(
            `INSERT INTO games (tournament_id, phase, division, court, starts_at, team_1_id, team_2_id, ref_team_id, label)
             VALUES ($1, 'seeding', $2, $3, $4::timestamptz, $5, $6, NULL, NULL)`,
            [tournamentId, game.division, game.court, game.starts_at, team1.id, team2.id]
          );
          if (hasRefTeamCode) {
            await client.query(
              "UPDATE games SET ref_team_id = $1 WHERE tournament_id = $2 AND court = $3 AND starts_at = $4::timestamptz",
              [refTeam?.id || null, tournamentId, game.court, game.starts_at]
            );
          }
          inserted += 1;
          continue;
        }

        if (isScored(primary) && !sameGame(primary, game.division, team1.id, team2.id)) {
          throw new Error(`Refusing to overwrite scored game at ${game.starts_at} court ${game.court}`);
        }

        for (const duplicate of existingRows.filter((row) => row.id !== primary.id)) {
          if (isScored(duplicate)) {
            throw new Error(`Refusing to delete scored duplicate at ${game.starts_at} court ${game.court}`);
          }
          await client.query("DELETE FROM games WHERE id = $1", [duplicate.id]);
          duplicateRowsDeleted += 1;
        }

        const alreadySame =
          sameGame(primary, game.division, team1.id, team2.id) &&
          primary.phase === "seeding" &&
          (!hasRefTeamCode || primary.ref_team_id === (refTeam?.id || null)) &&
          !primary.label;
        await client.query(
          `UPDATE games
           SET phase = 'seeding',
               division = $2,
               team_1_id = $3,
               team_2_id = $4,
               ref_team_id = CASE WHEN $6::boolean THEN $7 ELSE ref_team_id END,
               label = NULL,
               team_1_score = CASE WHEN $5::boolean THEN team_1_score ELSE NULL END,
               team_2_score = CASE WHEN $5::boolean THEN team_2_score ELSE NULL END,
               winner_team_id = CASE WHEN $5::boolean THEN winner_team_id ELSE NULL END,
               loser_team_id = CASE WHEN $5::boolean THEN loser_team_id ELSE NULL END,
               result_type = CASE WHEN $5::boolean THEN result_type ELSE NULL END,
               forfeit_team_id = CASE WHEN $5::boolean THEN forfeit_team_id ELSE NULL END,
               scored_by = CASE WHEN $5::boolean THEN scored_by ELSE NULL END,
               scored_at = CASE WHEN $5::boolean THEN scored_at ELSE NULL END
           WHERE id = $1`,
          [primary.id, game.division, team1.id, team2.id, isScored(primary), hasRefTeamCode, refTeam?.id || null]
        );
        if (alreadySame) unchanged += 1;
        else updated += 1;
      }

      let removed = 0;
      if (payload.deleteMissing) {
        const existingResult = await client.query<DbGame>(
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
        for (const row of existingResult.rows) {
          if (incomingSlots.has(slotKey(row.starts_at, row.court))) continue;
          if (isScored(row)) throw new Error(`Refusing to delete scored game id ${row.id}`);
          await client.query("DELETE FROM games WHERE id = $1", [row.id]);
          removed += 1;
        }
      }

      const streamsLinked = await linkGamesToExistingCourtStreams(client, tournamentId);
      const estimatedStarts = await estimateUnfilledStreamGameStarts(client, tournamentId);

      return {
        received: payload.games?.length || 0,
        inserted,
        updated,
        unchanged,
        removed,
        duplicateRowsDeleted,
        streamsLinked,
        estimatedStarts
      };
    });

    return NextResponse.json(result);
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 500 });
  }
}

function validateIncomingGames(games: IncomingGame[]) {
  const seen = new Set<string>();
  for (const [index, game] of games.entries()) {
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:00-04:00$/.test(game.starts_at)) return `Invalid starts_at at index ${index}: ${game.starts_at}`;
    if (Number.isNaN(new Date(game.starts_at).getTime())) return `Unparseable starts_at at index ${index}: ${game.starts_at}`;
    if (![1, 2].includes(game.court)) return `Invalid court at index ${index}: ${game.court}`;
    if (!["A", "B", "C", "D"].includes(game.division)) return `Invalid division at index ${index}: ${game.division}`;
    if (!teamDefinitions[game.team_1_code]) return `Unknown team_1_code at index ${index}: ${game.team_1_code}`;
    if (!teamDefinitions[game.team_2_code]) return `Unknown team_2_code at index ${index}: ${game.team_2_code}`;
    if (game.ref_team_code && !teamDefinitions[game.ref_team_code]) return `Unknown ref_team_code at index ${index}: ${game.ref_team_code}`;
    if (teamDefinitions[game.team_1_code].division !== game.division) return `Division mismatch at index ${index}: ${game.team_1_code}`;
    if (teamDefinitions[game.team_2_code].division !== game.division) return `Division mismatch at index ${index}: ${game.team_2_code}`;
    const key = slotKey(game.starts_at, game.court);
    if (seen.has(key)) return `Duplicate incoming slot at index ${index}: ${game.starts_at} court ${game.court}`;
    seen.add(key);
  }
  return null;
}

function buildTeamLookup(teams: DbTeam[]) {
  const byCode: Record<string, DbTeam | null> = {};
  for (const [code, definition] of Object.entries(teamDefinitions)) {
    const aliases = new Set(definition.names.map(normalizeName));
    const matches = teams.filter((team) => team.division === definition.division && aliases.has(normalizeName(team.name)));
    if (matches.length > 1) throw new Error(`Ambiguous team definition for ${code}: ${matches.map((team) => team.name).join(", ")}`);
    byCode[code] = matches[0] || null;
  }
  return byCode;
}

function normalizeName(value: string) {
  return value.toLowerCase().replace(/[’]/g, "'").replace(/\s+/g, " ").trim();
}

function isScored(game: DbGame) {
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

function sameGame(game: DbGame, division: string, team1Id: number, team2Id: number) {
  return game.division === division && game.team_1_id === team1Id && game.team_2_id === team2Id;
}

function slotKey(startsAt: string | Date, court: number) {
  return `${new Date(startsAt).toISOString()}|${court}`;
}
