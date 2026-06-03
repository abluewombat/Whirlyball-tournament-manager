import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { query } from "@/lib/db";
import { displayDateTime } from "@/lib/format";
import { LiveRefresh } from "@/app/live-refresh";

export const dynamic = "force-dynamic";

type Team = {
  id: number;
  name: string;
  division: string;
  center: string;
};

type TeamGame = {
  id: number;
  phase: string;
  division: string;
  starts_at: string;
  court: number;
  team_1_id: number | null;
  team_2_id: number | null;
  team_1: string | null;
  team_2: string | null;
  team_1_score: number | null;
  team_2_score: number | null;
  ref_team_id: number | null;
  ref_team: string | null;
  label: string | null;
};

export default async function TeamPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const teamId = Number(id);
  const [team] = await query<Team>(
    `SELECT teams.id, teams.name, teams.division, centers.name as center
     FROM teams JOIN centers ON centers.id = teams.center_id
     WHERE teams.id = $1 AND teams.deleted_at IS NULL`,
    [teamId]
  );
  if (!team) notFound();

  const games = await query<TeamGame>(
    `SELECT games.id, games.phase, games.division, games.starts_at, games.court,
            games.team_1_id, games.team_2_id, games.team_1_score, games.team_2_score,
            games.ref_team_id, games.label,
            t1.name as team_1, t2.name as team_2, tr.name as ref_team
     FROM games
     LEFT JOIN teams t1 ON t1.id = games.team_1_id
     LEFT JOIN teams t2 ON t2.id = games.team_2_id
     LEFT JOIN teams tr ON tr.id = games.ref_team_id
     WHERE games.team_1_id = $1 OR games.team_2_id = $1 OR games.ref_team_id = $1
     ORDER BY games.starts_at, games.court`,
    [teamId]
  );
  const host = (await headers()).get("host") || "whirlyball-manager.vercel.app";
  const url = `https://${host}/teams/${team.id}`;
  const qrUrl = `https://api.qrserver.com/v1/create-qr-code/?size=150x150&data=${encodeURIComponent(url)}`;

  return (
    <main className="content">
      <LiveRefresh seconds={30} />
      <section className="section card">
        <div className="section-heading">
          <div>
            <h1>{team.name}</h1>
            <p className="muted">{team.center} - {team.division} Division</p>
          </div>
          <img alt={`${team.name} QR code`} className="qr-code" src={qrUrl} />
        </div>
      </section>

      <section className="section card">
        <h2>Games and Reffing</h2>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Time</th>
                <th>Role</th>
                <th>Court</th>
                <th>Game</th>
                <th>Score</th>
              </tr>
            </thead>
            <tbody>
              {games.map((game) => {
                const playing = game.team_1_id === team.id || game.team_2_id === team.id;
                return (
                  <tr key={game.id} className={game.team_1_score !== null && game.team_2_score !== null ? "muted-game-row" : ""}>
                    <td>{displayDateTime(game.starts_at)}</td>
                    <td>{playing ? "Playing" : "Reffing"}</td>
                    <td>{game.court}</td>
                    <td>{game.team_1 && game.team_2 ? `${game.team_1} vs. ${game.team_2}` : `${game.division}: ${game.label || "Game"}`}</td>
                    <td>{game.team_1_score !== null && game.team_2_score !== null ? `${game.team_1_score}-${game.team_2_score}` : ""}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>
    </main>
  );
}
