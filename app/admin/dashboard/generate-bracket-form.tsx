"use client";

import { generateBracketAction } from "@/app/actions";

type GenerateBracketFormProps = {
  tournamentId: number;
  seedingComplete: boolean;
  activeBracketCount: number;
  unscoredSeedingCount: number;
};

export function GenerateBracketForm({
  tournamentId,
  seedingComplete,
  activeBracketCount,
  unscoredSeedingCount
}: GenerateBracketFormProps) {
  const hasActiveBrackets = activeBracketCount > 0;

  return (
    <form
      action={generateBracketAction}
      className="stack"
      onSubmit={(event) => {
        if (hasActiveBrackets && !window.confirm("are you sure? This will override current tournament")) {
          event.preventDefault();
        }
      }}
    >
      <input name="tournament_id" type="hidden" value={tournamentId} />
      {hasActiveBrackets ? <input name="force" type="hidden" value="1" /> : null}
      <button className={`button ${hasActiveBrackets ? "danger" : ""}`.trim()} disabled={!seedingComplete}>
        {hasActiveBrackets ? "Regenerate Tournament Brackets" : "Generate Tournament Brackets"}
      </button>
      {!seedingComplete ? (
        <p className="muted">{unscoredSeedingCount} seeding {unscoredSeedingCount === 1 ? "game" : "games"} still need scores.</p>
      ) : null}
    </form>
  );
}
