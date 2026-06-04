"use client";

import { useMemo, useState } from "react";
import { resetGameScoreAction, resetBracketScoreAction, submitBracketScoreAction, submitGameScoreAction } from "@/app/actions";
import { displayDateTime } from "@/lib/format";

export type ScoreGame = {
  id: number;
  phase: string;
  division: string;
  starts_at: string;
  court: number;
  team_1: string | null;
  team_2: string | null;
  team_1_score: number | null;
  team_2_score: number | null;
  label: string | null;
};

export type EditableBracketGame = {
  id: number;
  division: string;
  game_key: string;
  bracket_side: string;
  round: number;
  position: number;
  team_1: string | null;
  team_2: string | null;
  team_1_score: number | null;
  team_2_score: number | null;
};

type ScoreEntryTablesProps = {
  seedingGames: ScoreGame[];
  bracketGames: EditableBracketGame[];
  bracketsReady: boolean;
};

export function ScoreEntryTables({ seedingGames, bracketGames, bracketsReady }: ScoreEntryTablesProps) {
  const [showAllSeeding, setShowAllSeeding] = useState(false);
  const [showAllTournament, setShowAllTournament] = useState(false);
  const [seedingDivisionFilter, setSeedingDivisionFilter] = useState("all");
  const [seedingTeamFilter, setSeedingTeamFilter] = useState("all");
  const [tournamentDivisionFilter, setTournamentDivisionFilter] = useState("all");
  const [tournamentTeamFilter, setTournamentTeamFilter] = useState("all");
  const unscoredSeedingCount = useMemo(() => seedingGames.filter(isUnscoredScheduleGame).length, [seedingGames]);
  const unscoredBracketCount = useMemo(() => bracketGames.filter(isUnscoredBracketGame).length, [bracketGames]);
  const allSeedingScored = seedingGames.length > 0 && unscoredSeedingCount === 0;
  const [seedingOpen, setSeedingOpen] = useState(!bracketsReady || allSeedingScored);
  const [tournamentOpen, setTournamentOpen] = useState(bracketsReady || unscoredBracketCount === 0);
  const seedingDivisions = useMemo(() => divisionOptions(seedingGames), [seedingGames]);
  const tournamentDivisions = useMemo(() => divisionOptions(bracketGames), [bracketGames]);
  const seedingTeams = useMemo(() => teamOptions(seedingGames, seedingDivisionFilter), [seedingGames, seedingDivisionFilter]);
  const tournamentTeams = useMemo(() => teamOptions(bracketGames, tournamentDivisionFilter), [bracketGames, tournamentDivisionFilter]);
  const visibleSeedingGames = useMemo(
    () => filterScoreRows(showAllSeeding ? seedingGames : seedingGames.filter(isUnscoredScheduleGame), seedingDivisionFilter, seedingTeamFilter),
    [seedingGames, showAllSeeding, seedingDivisionFilter, seedingTeamFilter]
  );
  const visibleBracketGames = useMemo(
    () => filterScoreRows(showAllTournament ? bracketGames : bracketGames.filter(isUnscoredBracketGame), tournamentDivisionFilter, tournamentTeamFilter),
    [bracketGames, showAllTournament, tournamentDivisionFilter, tournamentTeamFilter]
  );

  return (
    <>
      <details className="section card score-collapse" open={seedingOpen} onToggle={(event) => setSeedingOpen(event.currentTarget.open)}>
        <summary>
          <span>Seeding Score Entry</span>
          <span className={allSeedingScored ? "pill ok" : "pill warn"}>{allSeedingScored ? "Complete" : `${unscoredSeedingCount} left`}</span>
        </summary>
        <ScoreFilterControl
          isShowingAll={showAllSeeding}
          hiddenLabel="Showing only unscored seeding games"
          shownLabel="Showing all seeding games"
          showText="Show All Seeding Games"
          hideText="Hide Scored Seeding Games"
          onToggle={() => setShowAllSeeding((value) => !value)}
        />
        <ScoreScopeFilters
          label="Seeding"
          divisions={seedingDivisions}
          teams={seedingTeams}
          selectedDivision={seedingDivisionFilter}
          selectedTeam={seedingTeamFilter}
          onDivisionChange={(division) => {
            setSeedingDivisionFilter(division);
            setSeedingTeamFilter("all");
          }}
          onTeamChange={setSeedingTeamFilter}
        />
        <ScoreTable games={visibleSeedingGames} emptyText={showAllSeeding ? "No seeding games available." : "No unscored seeding games."} />
      </details>

      {bracketGames.length ? (
        <details className="section card score-collapse" open={tournamentOpen} onToggle={(event) => setTournamentOpen(event.currentTarget.open)}>
          <summary>
            <span>Tournament Score Entry</span>
            <span className={unscoredBracketCount ? "pill warn" : "pill ok"}>{unscoredBracketCount ? `${unscoredBracketCount} left` : "Complete"}</span>
          </summary>
          <ScoreFilterControl
            isShowingAll={showAllTournament}
            hiddenLabel="Showing only unscored tournament games"
            shownLabel="Showing all tournament games"
            showText="Show All Tournament Games"
            hideText="Hide Scored Tournament Games"
            onToggle={() => setShowAllTournament((value) => !value)}
          />
          <ScoreScopeFilters
            label="Tournament"
            divisions={tournamentDivisions}
            teams={tournamentTeams}
            selectedDivision={tournamentDivisionFilter}
            selectedTeam={tournamentTeamFilter}
            onDivisionChange={(division) => {
              setTournamentDivisionFilter(division);
              setTournamentTeamFilter("all");
            }}
            onTeamChange={setTournamentTeamFilter}
          />
          <BracketScoreTable games={visibleBracketGames} emptyText={showAllTournament ? "No bracket games available." : "No unscored bracket games."} />
        </details>
      ) : null}
    </>
  );
}

type FilterableScoreRow = {
  division: string;
  team_1: string | null;
  team_2: string | null;
};

function ScoreScopeFilters({
  label,
  divisions,
  teams,
  selectedDivision,
  selectedTeam,
  onDivisionChange,
  onTeamChange
}: {
  label: string;
  divisions: string[];
  teams: string[];
  selectedDivision: string;
  selectedTeam: string;
  onDivisionChange: (division: string) => void;
  onTeamChange: (team: string) => void;
}) {
  return (
    <div className="score-filter-grid" aria-label={`${label} score filters`}>
      <label>
        Division
        <select value={selectedDivision} onChange={(event) => onDivisionChange(event.target.value)}>
          <option value="all">All divisions</option>
          {divisions.map((division) => (
            <option value={division} key={division}>
              {division}
            </option>
          ))}
        </select>
      </label>
      <label>
        Team
        <select value={selectedTeam} onChange={(event) => onTeamChange(event.target.value)}>
          <option value="all">All teams</option>
          {teams.map((team) => (
            <option value={team} key={team}>
              {team}
            </option>
          ))}
        </select>
      </label>
    </div>
  );
}

function divisionOptions(games: FilterableScoreRow[]) {
  return [...new Set(games.map((game) => game.division))].sort((left, right) => left.localeCompare(right));
}

function teamOptions(games: FilterableScoreRow[], divisionFilter: string) {
  const scopedGames = divisionFilter === "all" ? games : games.filter((game) => game.division === divisionFilter);
  const teams = new Set<string>();
  for (const game of scopedGames) {
    if (game.team_1) teams.add(game.team_1);
    if (game.team_2) teams.add(game.team_2);
  }
  return [...teams].sort((left, right) => left.localeCompare(right));
}

function filterScoreRows<T extends FilterableScoreRow>(games: T[], divisionFilter: string, teamFilter: string) {
  return games.filter((game) => {
    const divisionMatches = divisionFilter === "all" || game.division === divisionFilter;
    const teamMatches = teamFilter === "all" || game.team_1 === teamFilter || game.team_2 === teamFilter;
    return divisionMatches && teamMatches;
  });
}

function ScoreFilterControl({
  isShowingAll,
  hiddenLabel,
  shownLabel,
  showText,
  hideText,
  onToggle
}: {
  isShowingAll: boolean;
  hiddenLabel: string;
  shownLabel: string;
  showText: string;
  hideText: string;
  onToggle: () => void;
}) {
  return (
    <div className="actions">
      <span className="pill">{isShowingAll ? shownLabel : hiddenLabel}</span>
      <button type="button" className="button secondary" onClick={onToggle}>
        {isShowingAll ? hideText : showText}
      </button>
    </div>
  );
}

function isUnscoredScheduleGame(game: ScoreGame) {
  return game.team_1_score === null || game.team_2_score === null;
}

function isUnscoredBracketGame(game: EditableBracketGame) {
  return game.team_1_score === null || game.team_2_score === null;
}

function BracketScoreTable({ games, emptyText }: { games: EditableBracketGame[]; emptyText: string }) {
  if (!games.length) return <p className="muted">{emptyText}</p>;
  return (
    <div className="score-entry-list">
      {games.map((game) => (
        <article key={`bracket-${game.id}`} className={`score-game-card ${isUnscoredBracketGame(game) ? "" : "muted-game-row"}`.trim()}>
          <div className="score-game-header">
            <div>
              <h3>{bracketGameLabel(game)}</h3>
              <p className="muted">
                {game.division} {game.game_key}
              </p>
            </div>
            <span className={isUnscoredBracketGame(game) ? "pill warn" : "pill ok"}>{isUnscoredBracketGame(game) ? "Needs score" : "Scored"}</span>
          </div>
          {game.team_1 && game.team_2 ? (
            <div className="score-card-actions">
              <form action={submitBracketScoreAction} className="score-card-form">
                <input name="bracket_game_id" type="hidden" value={game.id} />
                <ScoreTeamInput name="team_1_score" team={game.team_1} defaultValue={game.team_1_score} />
                <ScoreTeamInput name="team_2_score" team={game.team_2} defaultValue={game.team_2_score} />
                <button className="button">Save Score</button>
              </form>
              {game.team_1_score !== null && game.team_2_score !== null ? (
                <form action={resetBracketScoreAction}>
                  <input name="bracket_game_id" type="hidden" value={game.id} />
                  <button className="button danger">Reset</button>
                </form>
              ) : null}
            </div>
          ) : (
            <p className="muted">Waiting on bracket results</p>
          )}
        </article>
      ))}
    </div>
  );
}

function bracketGameLabel(game: EditableBracketGame) {
  if (game.game_key === "F1") return "Championship";
  if (game.game_key === "F2") return "If-needed Championship";
  return `${game.bracket_side === "losers" ? "Losers" : "Winners"} Round ${game.round} Game ${game.position}`;
}

function ScoreTable({ games, emptyText }: { games: ScoreGame[]; emptyText: string }) {
  if (!games.length) return <p className="muted">{emptyText}</p>;
  return (
    <div className="score-entry-list">
      {games.map((game) => (
        <article key={`schedule-${game.id}`} className={`score-game-card ${isUnscoredScheduleGame(game) ? "" : "muted-game-row"}`.trim()}>
          <div className="score-game-header">
            <div>
              <h3>{game.starts_at ? `${displayDateTime(game.starts_at)} Court ${game.court}` : game.label}</h3>
              <p className="muted">
                {game.division} {game.phase}
              </p>
            </div>
            <span className={isUnscoredScheduleGame(game) ? "pill warn" : "pill ok"}>{isUnscoredScheduleGame(game) ? "Needs score" : "Scored"}</span>
          </div>
          {game.team_1 && game.team_2 ? (
            <div className="score-card-actions">
              <form action={submitGameScoreAction} className="score-card-form">
                <input name="game_id" type="hidden" value={game.id} />
                <ScoreTeamInput name="team_1_score" team={game.team_1} defaultValue={game.team_1_score} />
                <ScoreTeamInput name="team_2_score" team={game.team_2} defaultValue={game.team_2_score} />
                <button className="button">Save Score</button>
              </form>
              {game.team_1_score !== null && game.team_2_score !== null ? (
                <form action={resetGameScoreAction}>
                  <input name="game_id" type="hidden" value={game.id} />
                  <button className="button danger">Reset</button>
                </form>
              ) : null}
            </div>
          ) : (
            <p className="muted">Waiting on teams</p>
          )}
        </article>
      ))}
    </div>
  );
}

function ScoreTeamInput({ name, team, defaultValue }: { name: string; team: string; defaultValue: number | null }) {
  return (
    <label className="score-team-input">
      <span>{team}</span>
      <input name={name} type="number" inputMode="numeric" min="0" defaultValue={defaultValue ?? ""} aria-label={`${team} score`} />
    </label>
  );
}
