import { listCenters } from "@/lib/db";
import { currentTournament } from "@/lib/tournaments";
import { LoginTabs } from "./login-tabs";

export const dynamic = "force-dynamic";

type LoginMode = "center" | "score" | "admin";

export default async function LoginPage({
  searchParams
}: {
  searchParams: Promise<{ mode?: string; error?: string }>;
}) {
  const [params, centers, tournament] = await Promise.all([searchParams, listCenters(), currentTournament()]);
  const initialMode: LoginMode = params.mode === "score" || params.mode === "admin" ? params.mode : "center";

  return (
    <main className="content login-page">
      <LoginTabs
        centers={centers}
        tournamentId={tournament.id}
        tournamentName={tournament.name}
        initialMode={initialMode}
        hasError={Boolean(params.error)}
      />
    </main>
  );
}
