import { NextResponse } from "next/server";
import {
  createSnapshot,
  query,
  restoreSnapshot,
  withTransaction
} from "@/lib/db";
import {
  rebuildBracketForDivision,
  syncActiveBracketsToSchedule
} from "@/lib/brackets";
import { recalculateBracketOddsForTournament } from "@/lib/bracket-odds";
import { clearGoogleSheetSyncPause, setGoogleSheetSyncPause } from "@/lib/sync-status";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const tournamentSlug = "novi-2026";

type MockRequest = {
  action?: "apply" | "reset";
  snapshotId?: number;
};

type SeedingGame = {
  id: number;
  division: string;
  starts_at: string;
  team_1_id: number;
  team_2_id: number;
  team_1_seed: number;
  team_2_seed: number;
};

export async function POST(request: Request) {
  if (!process.env.ADMIN_PASSWORD || request.headers.get("x-admin-password") !== process.env.ADMIN_PASSWORD) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const payload = (await request.json().catch(() => ({}))) as MockRequest;
  try {
    const tournament = await tournamentBySlug();
    if (payload.action === "reset") {
      if (!Number.isInteger(payload.snapshotId) || Number(payload.snapshotId) <= 0) {
        return NextResponse.json({ error: "snapshotId is required for reset" }, { status: 400 });
      }
      await restoreSnapshot(tournament.id, Number(payload.snapshotId));
      await clearGoogleSheetSyncPause(tournament.id);
      return NextResponse.json({ ok: true, action: "reset", snapshotId: Number(payload.snapshotId), cronPaused: false });
    }

    const snapshotLabel = `Pre bracket odds mock ${new Date().toISOString()}`;
    await setGoogleSheetSyncPause(tournament.id, "Google Sheet sync paused for bracket odds mock", {
      snapshotLabel,
      endpoint: "/api/temp-bracket-odds-mock"
    });
    const snapshotResult = await createSnapshot(tournament.id, snapshotLabel);
    const snapshotId = Number(snapshotResult.rows[0]?.id);
    if (!Number.isInteger(snapshotId) || snapshotId <= 0) throw new Error("Snapshot was created without a returned id.");

    const scored = await fakeScoreSeedingGames(tournament.id);
    const divisions = await query<{ division: string }>(
      `SELECT DISTINCT division
       FROM games
       WHERE tournament_id = $1
         AND phase = 'seeding'
         AND division <> 'Unlimited'
         AND team_1_id IS NOT NULL
         AND team_2_id IS NOT NULL
       ORDER BY division`,
      [tournament.id]
    );

    const bracketResults = [];
    for (const { division } of divisions) {
      const bracketId = await rebuildBracketForDivision(tournament.id, division);
      bracketResults.push({ division, bracketId });
    }
    await syncActiveBracketsToSchedule(tournament.id);
    const oddsResults = await recalculateBracketOddsForTournament(tournament.id);

    return NextResponse.json({
      ok: true,
      action: "apply",
      snapshotId,
      snapshotLabel,
      fakeScoresApplied: scored.updated,
      cronPaused: true,
      divisions: divisions.map((row) => row.division),
      brackets: bracketResults,
      odds: oddsResults,
      reset: {
        adminDashboard: "Admin Dashboard > Overview > Snapshots",
        endpoint: "/api/temp-bracket-odds-mock",
        body: { action: "reset", snapshotId }
      }
    });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 500 });
  }
}

async function tournamentBySlug() {
  const [tournament] = await query<{ id: number; slug: string }>("SELECT id, slug FROM tournaments WHERE slug = $1", [tournamentSlug]);
  if (!tournament) throw new Error(`Tournament not found: ${tournamentSlug}`);
  return tournament;
}

async function fakeScoreSeedingGames(tournamentId: number) {
  return withTransaction(async (client) => {
    const games = await client.query<SeedingGame>(
      `WITH seeds AS (
         SELECT teams.id,
                ROW_NUMBER() OVER (
                  PARTITION BY teams.division
                  ORDER BY teams.division, COALESCE(centers.name, ''), teams.name, teams.id
                ) as seed
         FROM teams
         LEFT JOIN centers ON centers.id = teams.center_id
         WHERE teams.tournament_id = $1 AND teams.deleted_at IS NULL
       )
       SELECT games.id, games.division, games.starts_at,
              games.team_1_id, games.team_2_id,
              COALESCE(s1.seed, 99) as team_1_seed,
              COALESCE(s2.seed, 99) as team_2_seed
       FROM games
       LEFT JOIN seeds s1 ON s1.id = games.team_1_id
       LEFT JOIN seeds s2 ON s2.id = games.team_2_id
       WHERE games.tournament_id = $1
         AND games.phase = 'seeding'
         AND games.division <> 'Unlimited'
         AND games.team_1_id IS NOT NULL
         AND games.team_2_id IS NOT NULL
       ORDER BY games.starts_at, games.court, games.id`,
      [tournamentId]
    );

    let updated = 0;
    for (const game of games.rows) {
      const result = mockResult(game);
      await client.query(
        `UPDATE games
         SET team_1_score = $1,
             team_2_score = $2,
             winner_team_id = $3,
             loser_team_id = $4,
             result_type = 'score',
             forfeit_team_id = NULL,
             scored_by = 'mock-bracket-odds',
             scored_at = NOW()
         WHERE id = $5`,
        [result.team1Score, result.team2Score, result.winnerId, result.loserId, game.id]
      );
      updated++;
    }
    return { updated };
  });
}

function mockResult(game: SeedingGame) {
  const hash = seededNumber(`${game.id}:${game.starts_at}:${game.team_1_id}:${game.team_2_id}`);
  const seedEdge = game.team_2_seed - game.team_1_seed;
  const team1Favored = seedEdge > 0 ? hash > 0.18 : seedEdge < 0 ? hash > 0.78 : hash >= 0.5;
  const baseWinnerScore = 8 + Math.floor(hash * 6);
  const margin = 1 + Math.floor(seededNumber(`margin:${game.id}`) * 5);
  const winnerScore = baseWinnerScore;
  const loserScore = Math.max(0, winnerScore - margin);

  if (team1Favored) {
    return {
      team1Score: winnerScore,
      team2Score: loserScore,
      winnerId: game.team_1_id,
      loserId: game.team_2_id
    };
  }
  return {
    team1Score: loserScore,
    team2Score: winnerScore,
    winnerId: game.team_2_id,
    loserId: game.team_1_id
  };
}

function seededNumber(seed: string) {
  let state = 2166136261;
  for (let index = 0; index < seed.length; index++) {
    state ^= seed.charCodeAt(index);
    state = Math.imul(state, 16777619);
  }
  state += 0x6d2b79f5;
  let value = state;
  value = Math.imul(value ^ (value >>> 15), value | 1);
  value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
  return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
}
