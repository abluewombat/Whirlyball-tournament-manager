import { listPlayers } from "@/lib/queries";
import { currentTournament, tournamentPath } from "@/lib/tournaments";
import { PlayerDirectory, type PlayerDirectoryRow } from "./player-directory";

export const dynamic = "force-dynamic";

export default async function PlayersPage() {
  const tournament = await currentTournament();
  const players = (await listPlayers(tournament.id, false)) as PlayerDirectoryRow[];

  return (
    <main className="content">
      <section className="section card">
        <h1>Players</h1>
        <p className="muted">Search for a player and click their row to open their team page.</p>
      </section>
      <PlayerDirectory players={players} basePath={tournamentPath(tournament)} />
    </main>
  );
}
