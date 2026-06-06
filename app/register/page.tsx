import { listCenters, query, SHIRT_SIZES } from "@/lib/db";
import { currentTournament, tournamentDivisionNames } from "@/lib/tournaments";
import { RegistrationForm } from "./registration-form";

export const dynamic = "force-dynamic";

type TeamOption = {
  id: number;
  center_id: number | null;
  division: string;
  name: string;
  center: string;
};

export default async function RegisterPage({
  searchParams
}: {
  searchParams: Promise<{ submitted?: string; error?: string }>;
}) {
  const [params, tournament, centers] = await Promise.all([searchParams, currentTournament(), listCenters()]);
  const divisions = await tournamentDivisionNames(tournament.id, tournament.tournament_type === "nationals");
  const teams = await query<TeamOption>(
    `SELECT teams.id, teams.center_id, teams.division, teams.name, COALESCE(centers.name, 'Draft') as center
     FROM teams
     LEFT JOIN centers ON centers.id = teams.center_id
     WHERE teams.tournament_id = $1 AND teams.deleted_at IS NULL
     ORDER BY teams.division, centers.name, teams.name`,
    [tournament.id]
  );
  const registrationOpen =
    tournament.status !== "past" &&
    !tournament.editing_locked &&
    !tournament.draft_locked &&
    (!tournament.registration_deadline || Date.now() <= Date.parse(tournament.registration_deadline));

  return (
    <main className="content">
      <section className="section card">
        <h1>Join {tournament.name}</h1>
        <p className="muted">
          Submit your request to your home center. A center admin will review it and handle any later changes.
        </p>
        {params.submitted ? <p className="pill ok">Your request was submitted.</p> : null}
        {params.error === "pending" ? <p className="pill warn">You already have a pending request for this tournament.</p> : null}
        {params.error === "closed" || !registrationOpen ? <p className="pill warn">Registration is closed.</p> : null}

        {registrationOpen ? (
          <RegistrationForm
            tournamentId={tournament.id}
            tournamentType={tournament.tournament_type}
            centers={centers}
            divisions={divisions}
            teams={teams}
            shirtSizes={[...SHIRT_SIZES]}
          />
        ) : null}
      </section>
    </main>
  );
}
