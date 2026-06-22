import { saveCourtStreamAction, scorekeeperLogoutAction } from "@/app/actions";
import { redirect } from "next/navigation";
import { scoreEntryAccess } from "@/lib/auth";
import { query } from "@/lib/db";
import { ScoreEntryTables, type ScoreGame } from "@/app/score/score-entry-tables";
import { currentTournament } from "@/lib/tournaments";
import { courtStreamsForTournament } from "@/lib/streams";

export const dynamic = "force-dynamic";

export default async function ScorePage({
  searchParams
}: {
  searchParams: Promise<{ error?: string; stream_error?: string; stream_saved?: string }>;
}) {
  const params = await searchParams;
  const tournament = await currentTournament();
  const access = await scoreEntryAccess(tournament.id);
  if (!access) {
    redirect("/login?mode=score");
  }

  const games = await query<ScoreGame>(
    `SELECT games.id, games.phase, games.division, games.starts_at, games.court,
            games.team_1_id, games.team_2_id, games.winner_team_id, games.loser_team_id,
            games.team_1_score, games.team_2_score, games.result_type, games.forfeit_team_id, games.label,
            t1.name as team_1, t2.name as team_2
     FROM games
     LEFT JOIN teams t1 ON t1.id = games.team_1_id
     LEFT JOIN teams t2 ON t2.id = games.team_2_id
     WHERE games.tournament_id = $1 AND games.team_1_id IS NOT NULL AND games.team_2_id IS NOT NULL
     ORDER BY games.starts_at, games.court`,
    [tournament.id]
  );
  const activeBracketDivisions = new Set<string>();
  const [streamSlots, courtStreams, currentStreamGames] = await Promise.all([
    query<{ court: number; stream_date: string }>(
      `SELECT DISTINCT court, TO_CHAR(starts_at AT TIME ZONE $2, 'YYYY-MM-DD') as stream_date
       FROM games
       WHERE tournament_id = $1
       ORDER BY stream_date, court`,
      [tournament.id, tournament.timezone]
    ),
    courtStreamsForTournament(tournament.id),
    query<{
      stream_id: number;
      division: string;
      team_1: string;
      team_2: string;
    }>(
      `SELECT DISTINCT ON (games.stream_id)
              games.stream_id, games.division, t1.name as team_1, t2.name as team_2
       FROM games
       JOIN teams t1 ON t1.id = games.team_1_id
       JOIN teams t2 ON t2.id = games.team_2_id
       WHERE games.tournament_id = $1
         AND games.stream_id IS NOT NULL
         AND games.actual_started_at IS NOT NULL
         AND games.actual_started_at <= NOW()
         AND games.actual_ended_at IS NULL
         AND (games.team_1_score IS NULL OR games.team_2_score IS NULL)
         AND games.result_type IS DISTINCT FROM 'forfeit'
       ORDER BY games.stream_id, games.actual_started_at DESC`,
      [tournament.id]
    )
  ]);
  const streamBySlot = new Map(courtStreams.map((stream) => [`${stream.stream_date.slice(0, 10)}-${stream.court}`, stream]));
  const currentGameByStream = new Map(currentStreamGames.map((game) => [game.stream_id, game]));
  const seedingGames = games
    .filter((game) => game.phase === "seeding" && game.division !== "Unlimited")
    .map((game) => ({
      ...game,
      score_locked: activeBracketDivisions.has(game.division),
      score_lock_reason: activeBracketDivisions.has(game.division)
        ? "Locked after bracket generation. Rebuild or void the bracket before changing seeding results."
        : null
    }));
  const unscoredSeedingCount = seedingGames.filter((game) => (game.team_1_score === null || game.team_2_score === null) && game.result_type !== "forfeit").length;
  const allSeedingScored = seedingGames.length > 0 && unscoredSeedingCount === 0;
  const bracketsReady = false;

  return (
    <main className="content">
      <div className="actions">
        <h1 style={{ marginRight: "auto" }}>Score Entry</h1>
        <span className="pill ok">{access === "admin" ? "Admin access" : "Scorekeeper access"}</span>
        {access === "admin" ? (
          <a className="button secondary" href="/admin/dashboard">Admin Dashboard</a>
        ) : (
          <form action={scorekeeperLogoutAction}>
            <button className="button secondary">Log Out</button>
          </form>
        )}
      </div>
      {access === "admin" ? <p className="muted">You are already logged in as admin, so the scorekeeper passcode is not required.</p> : null}

      <section className="section card">
        <div className="section-heading">
          <div>
            <h2>Court Streams</h2>
            <p className="muted">
              Saving a YouTube URL connects that court and estimates replay timestamps from the stream start. Each first-time final score advances the next game to the current time.
            </p>
          </div>
        </div>
        {params.stream_saved ? <p className="pill ok">Stream saved and replay estimates updated.</p> : null}
        {params.stream_error ? <p className="pill warn">Enter a valid YouTube video or live-stream URL.</p> : null}
        {streamSlots.length ? (
          <div className="grid">
            {streamSlots.map((slot) => {
              const stream = streamBySlot.get(`${slot.stream_date}-${slot.court}`);
              const currentGame = stream ? currentGameByStream.get(stream.id) : null;
              return (
                <form action={saveCourtStreamAction} className="card compact stack" key={`${slot.stream_date}-${slot.court}`}>
                  <input name="tournament_id" type="hidden" value={tournament.id} />
                  <input name="court" type="hidden" value={slot.court} />
                  <input name="stream_date" type="hidden" value={slot.stream_date} />
                  <div className="section-heading">
                    <div>
                      <h3>Court {slot.court}</h3>
                      <p className="muted">{slot.stream_date}</p>
                    </div>
                    <span className={`pill ${currentGame ? "ok" : stream ? "" : "warn"}`}>
                      {currentGame ? "Live" : stream ? "Connected" : "Needs URL"}
                    </span>
                  </div>
                  {currentGame ? (
                    <p><strong>{currentGame.division}: {currentGame.team_1} vs. {currentGame.team_2}</strong></p>
                  ) : null}
                  <label>
                    YouTube stream URL
                    <input
                      name="youtube_url"
                      type="url"
                      defaultValue={stream?.youtube_url || ""}
                      placeholder="https://www.youtube.com/watch?v=..."
                      required
                    />
                  </label>
                  <button className="button">{stream ? "Update Stream" : "Save Stream"}</button>
                </form>
              );
            })}
          </div>
        ) : (
          <p className="muted">Generate the schedule before connecting court streams.</p>
        )}
      </section>

      <section className="section card">
        <div className="section-heading">
          <div>
            <h2>Manual Bracket</h2>
            <p className="muted">The tournament bracket is being handled manually. Score entry here covers scheduled seeding games only.</p>
          </div>
          <span className={allSeedingScored ? "pill ok" : "pill warn"}>{allSeedingScored ? "Seeding complete" : `${unscoredSeedingCount} seeding scores left`}</span>
        </div>
      </section>

        <ScoreEntryTables seedingGames={seedingGames} bracketGames={[]} bracketsReady={bracketsReady} timeZone={tournament.timezone} />
    </main>
  );
}
