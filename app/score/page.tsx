import {
  generateBracketAction,
  saveCourtStreamAction,
  scorekeeperLoginAction,
  scorekeeperLogoutAction,
  syncScheduleFromBracketsAction
} from "@/app/actions";
import { scoreEntryAccess } from "@/lib/auth";
import { getActiveBracketScheduleSlots, getActiveBracketScoreLocks } from "@/lib/brackets";
import { query } from "@/lib/db";
import { ManagedBracketViewer, type ManagedBracketData } from "@/app/brackets/managed-bracket-viewer";
import { ScoreEntryTables, type EditableBracketGame, type ScoreGame } from "@/app/score/score-entry-tables";
import { currentTournament, tournamentDivisionNames } from "@/lib/tournaments";
import { courtStreamsForTournament } from "@/lib/streams";

export const dynamic = "force-dynamic";

type BracketScoreGame = {
  bracket_id: number;
  division: string;
  bracket_data_json: ManagedBracketData | null;
};

export default async function ScorePage({
  searchParams
}: {
  searchParams: Promise<{ error?: string; stream_error?: string; stream_saved?: string }>;
}) {
  const params = await searchParams;
  const tournament = await currentTournament();
  const bracketDivisions = await tournamentDivisionNames(tournament.id, false);
  const access = await scoreEntryAccess(tournament.id);
  if (!access) {
    return (
      <main className="content">
        <section className="section card compact">
          <h1>Score Entry</h1>
          <p className="muted">Enter the event scorekeeper passcode.</p>
          {params.error ? <p className="pill warn">Wrong passcode.</p> : null}
          <form action={scorekeeperLoginAction} className="stack">
            <input name="tournament_id" type="hidden" value={tournament.id} />
            <input name="passcode" type="password" required />
            <button className="button">Enter Scorekeeper Mode</button>
          </form>
        </section>
      </main>
    );
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
  const bracketGames = await query<BracketScoreGame>(
    `SELECT brackets.id as bracket_id, brackets.division, brackets.bracket_data_json
     FROM brackets
     WHERE brackets.tournament_id = $1 AND brackets.status = 'active'
     ORDER BY brackets.division, brackets.id`,
    [tournament.id]
  );
  const editableBracketGames = await query<EditableBracketGame>(
    `SELECT bracket_games.id, brackets.division, bracket_games.game_key, bracket_games.bracket_side,
            bracket_games.round, bracket_games.position,
            bracket_games.team_1_id, bracket_games.team_2_id, bracket_games.winner_team_id,
            bracket_games.team_1_score, bracket_games.team_2_score,
            bracket_games.result_type, bracket_games.forfeit_team_id,
            t1.name as team_1, t2.name as team_2
     FROM bracket_games
     JOIN brackets ON brackets.id = bracket_games.bracket_id
     LEFT JOIN teams t1 ON t1.id = bracket_games.team_1_id
     LEFT JOIN teams t2 ON t2.id = bracket_games.team_2_id
     WHERE brackets.tournament_id = $1 AND brackets.status = 'active'
     ORDER BY brackets.division,
              CASE bracket_games.bracket_side WHEN 'winners' THEN 1 WHEN 'losers' THEN 2 ELSE 3 END,
              bracket_games.round, bracket_games.position`,
    [tournament.id]
  );
  const activeBracketDivisions = new Set(bracketGames.map((game) => game.division));
  const [streamSlots, courtStreams, currentStreamGames] = await Promise.all([
    query<{ court: number; stream_date: string }>(
      `SELECT DISTINCT court, TO_CHAR(starts_at AT TIME ZONE 'UTC', 'YYYY-MM-DD') as stream_date
       FROM games
       WHERE tournament_id = $1
       ORDER BY stream_date, court`,
      [tournament.id]
    ),
    courtStreamsForTournament(tournament.id),
    query<{
      stream_id: number;
      division: string;
      team_1: string;
      team_2: string;
    }>(
      `SELECT games.stream_id, games.division, t1.name as team_1, t2.name as team_2
       FROM games
       JOIN teams t1 ON t1.id = games.team_1_id
       JOIN teams t2 ON t2.id = games.team_2_id
       WHERE games.tournament_id = $1
         AND games.stream_id IS NOT NULL
         AND games.actual_started_at IS NOT NULL
         AND games.actual_ended_at IS NULL
         AND (games.team_1_score IS NULL OR games.team_2_score IS NULL)
         AND games.result_type IS DISTINCT FROM 'forfeit'
       ORDER BY games.actual_started_at`,
      [tournament.id]
    )
  ]);
  const streamBySlot = new Map(courtStreams.map((stream) => [`${stream.stream_date.slice(0, 10)}-${stream.court}`, stream]));
  const currentGameByStream = new Map(currentStreamGames.map((game) => [game.stream_id, game]));
  const bracketScoreLocks = await getActiveBracketScoreLocks(tournament.id);
  const bracketScheduleSlots = await getActiveBracketScheduleSlots(tournament.id);
  const seedingGames = games
    .filter((game) => game.phase === "seeding" && game.division !== "Unlimited")
    .map((game) => ({
      ...game,
      score_locked: activeBracketDivisions.has(game.division),
      score_lock_reason: activeBracketDivisions.has(game.division)
        ? "Locked after bracket generation. Rebuild or void the bracket before changing seeding results."
        : null
    }));
  const editableBracketGamesWithLocks = editableBracketGames.map((game) => {
    const lock = bracketScoreLocks.get(game.id);
    const scheduleSlot = bracketScheduleSlots.get(game.id);
    return {
      ...game,
      schedule_label: scheduleSlot?.schedule_label || null,
      starts_at: scheduleSlot?.starts_at || null,
      court: scheduleSlot?.court || null,
      actual_started_at: scheduleSlot?.actual_started_at || null,
      actual_ended_at: scheduleSlot?.actual_ended_at || null,
      result_locked: Boolean(lock?.result_locked),
      result_lock_reason: lock?.result_lock_reason || null,
      reset_locked: Boolean(lock?.reset_locked),
      reset_lock_reason: lock?.reset_lock_reason || null
    };
  });
  const unscoredSeedingCount = seedingGames.filter((game) => (game.team_1_score === null || game.team_2_score === null) && game.result_type !== "forfeit").length;
  const allSeedingScored = seedingGames.length > 0 && unscoredSeedingCount === 0;
  const bracketsReady = allSeedingScored && bracketGames.length > 0;

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
              Saving a YouTube URL starts the first unscored game on that court. Each first-time final score advances the live game automatically.
            </p>
          </div>
        </div>
        {params.stream_saved ? <p className="pill ok">Stream saved and court timeline started.</p> : null}
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
                  <button className="button">{stream ? "Update Stream" : "Save Stream & Start Court"}</button>
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
            <h2>Bracket Setup</h2>
            <p className="muted">
              {allSeedingScored ? "All seeding scores are filled." : `${unscoredSeedingCount} seeding scores remaining.`}
            </p>
          </div>
          {bracketsReady ? (
            <div className="actions">
              <span className="pill ok">Bracket generated</span>
              <form action={syncScheduleFromBracketsAction}>
                <input name="tournament_id" type="hidden" value={tournament.id} />
                <button className="button secondary">Sync Schedule</button>
              </form>
            </div>
          ) : (
            <div className="actions">
              <form action={generateBracketAction}>
                <input name="tournament_id" type="hidden" value={tournament.id} />
                <button className="button" disabled={!allSeedingScored}>Generate Bracket</button>
              </form>
              {bracketGames.length ? (
                <form action={syncScheduleFromBracketsAction}>
                  <input name="tournament_id" type="hidden" value={tournament.id} />
                  <button className="button secondary">Sync Schedule</button>
                </form>
              ) : null}
            </div>
          )}
        </div>
      </section>

      <ScoreEntryTables seedingGames={seedingGames} bracketGames={editableBracketGamesWithLocks} bracketsReady={bracketsReady} />

      {bracketGames.length ? (
        <section className="section card bracket-page">
          <h2>Bracket</h2>
          {bracketDivisions.map((division) => {
            const [divisionBracket] = bracketGames.filter((game) => game.division === division);
            if (!divisionBracket?.bracket_data_json) return null;
            return (
              <details className="bracket-division-card" key={division} open={division === "A"}>
                <summary>
                  <span>{division} Division</span>
                  <span className="pill">Double elimination</span>
                </summary>
                <ManagedBracketViewer data={divisionBracket.bracket_data_json} />
              </details>
            );
          })}
        </section>
      ) : null}
    </main>
  );
}
