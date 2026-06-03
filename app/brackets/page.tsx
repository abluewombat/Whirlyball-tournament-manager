import { cookies } from "next/headers";
import { rebuildBracketAction } from "@/app/actions";
import { DIVISIONS, query } from "@/lib/db";
import { LiveRefresh } from "@/app/live-refresh";
import { unsign } from "@/lib/security";

export const dynamic = "force-dynamic";

type BracketGame = {
  bracket_id: number;
  division: string;
  game_key: string;
  bracket_side: string;
  round: number;
  position: number;
  team_1: string | null;
  team_2: string | null;
  team_1_score: number | null;
  team_2_score: number | null;
  winner_team: string | null;
};

export default async function BracketsPage() {
  const isAdmin = unsign((await cookies()).get("admin_session")?.value) === "admin";
  const games = await query<BracketGame>(
    `SELECT bracket_games.bracket_id, brackets.division, bracket_games.game_key, bracket_games.bracket_side,
            bracket_games.round, bracket_games.position, bracket_games.team_1_score, bracket_games.team_2_score,
            t1.name as team_1, t2.name as team_2, tw.name as winner_team
     FROM bracket_games
     JOIN brackets ON brackets.id = bracket_games.bracket_id
     LEFT JOIN teams t1 ON t1.id = bracket_games.team_1_id
     LEFT JOIN teams t2 ON t2.id = bracket_games.team_2_id
     LEFT JOIN teams tw ON tw.id = bracket_games.winner_team_id
     WHERE brackets.status = 'active'
     ORDER BY brackets.division, bracket_games.bracket_side DESC, bracket_games.round, bracket_games.position`
  );

  return (
    <main className="content bracket-page">
      <LiveRefresh seconds={30} />
      <div className="section-heading">
        <div>
          <h1>Brackets</h1>
          <p className="muted">Brackets appear automatically when all seeding games in a division are scored.</p>
        </div>
        <a className="button secondary" href="/standings">Standings</a>
      </div>

      {DIVISIONS.map((division) => {
        const divisionGames = games.filter((game) => game.division === division);
        return (
          <section className="section card" key={division}>
            <div className="section-heading">
              <h2>{division} Division</h2>
              {isAdmin ? (
                <form action={rebuildBracketAction}>
                  <input name="division" type="hidden" value={division} />
                  <button className="button secondary">Rebuild Bracket</button>
                </form>
              ) : null}
            </div>
            {divisionGames.length ? (
              <>
                <BracketTree title="Winners Bracket + Finals" games={divisionGames.filter((game) => game.bracket_side === "winners")} />
                <BracketTree title="Losers Bracket" games={divisionGames.filter((game) => game.bracket_side === "losers")} />
              </>
            ) : (
              <p className="muted">No bracket created yet.</p>
            )}
          </section>
        );
      })}
    </main>
  );
}

function BracketTree({ title, games }: { title: string; games: BracketGame[] }) {
  const rounds = [...new Set(games.map((game) => game.round))].sort((left, right) => left - right);
  return (
    <div className="bracket-section">
      <h3>{title}</h3>
      <div className="bracket-scroll">
        <div className="bracket-rounds" style={{ gridTemplateColumns: `repeat(${Math.max(1, rounds.length)}, minmax(220px, 1fr))` }}>
          {rounds.map((round) => (
            <div className="bracket-round" key={round}>
              <h4>Round {round}</h4>
              {games
                .filter((game) => game.round === round)
                .sort((left, right) => left.position - right.position)
                .map((game) => (
                  <article className="bracket-game" key={game.game_key}>
                    <div className="muted">{game.game_key}</div>
                    <BracketTeam name={game.team_1} score={game.team_1_score} winner={game.winner_team === game.team_1} />
                    <BracketTeam name={game.team_2} score={game.team_2_score} winner={game.winner_team === game.team_2} />
                  </article>
                ))}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function BracketTeam({ name, score, winner }: { name: string | null; score: number | null; winner: boolean }) {
  return (
    <div className={`bracket-team ${winner ? "winner" : ""}`}>
      <span>{name || "TBD"}</span>
      <strong>{score ?? ""}</strong>
    </div>
  );
}
