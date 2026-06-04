"use client";

import { useMemo, useState, type ChangeEvent } from "react";
import {
  resetGameScoreAction,
  resetBracketScoreAction,
  submitBracketForfeitAction,
  submitBracketScoreAction,
  submitGameForfeitAction,
  submitGameScoreAction
} from "@/app/actions";
import { displayDateTime } from "@/lib/format";

export type ScoreGame = {
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
  winner_team_id: number | null;
  loser_team_id: number | null;
  result_type: string | null;
  forfeit_team_id: number | null;
  label: string | null;
  score_locked?: boolean;
  score_lock_reason?: string | null;
};

export type EditableBracketGame = {
  id: number;
  division: string;
  game_key: string;
  bracket_side: string;
  round: number;
  position: number;
  team_1_id: number | null;
  team_2_id: number | null;
  team_1: string | null;
  team_2: string | null;
  team_1_score: number | null;
  team_2_score: number | null;
  winner_team_id: number | null;
  result_type: string | null;
  forfeit_team_id: number | null;
  result_locked?: boolean;
  result_lock_reason?: string | null;
  reset_locked?: boolean;
  reset_lock_reason?: string | null;
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
  return !isCompleteScheduleResult(game);
}

function isUnscoredBracketGame(game: EditableBracketGame) {
  return !isCompleteBracketResult(game);
}

function isCompleteScheduleResult(game: ScoreGame) {
  return (game.team_1_score !== null && game.team_2_score !== null) || game.result_type === "forfeit";
}

function isCompleteBracketResult(game: EditableBracketGame) {
  return (game.team_1_score !== null && game.team_2_score !== null) || game.result_type === "forfeit";
}

function BracketScoreTable({ games, emptyText }: { games: EditableBracketGame[]; emptyText: string }) {
  if (!games.length) return <p className="muted">{emptyText}</p>;
  return (
    <div className="score-entry-list">
      {games.map((game) => (
        <BracketScoreCard game={game} key={`bracket-${game.id}`} />
      ))}
    </div>
  );
}

function BracketScoreCard({ game }: { game: EditableBracketGame }) {
  const [team1Score, setTeam1Score] = useState(game.team_1_score === null ? "" : String(game.team_1_score));
  const [team2Score, setTeam2Score] = useState(game.team_2_score === null ? "" : String(game.team_2_score));
  const currentWinner = currentWinnerSide(game);
  const nextWinner = winnerSide(scoreValue(team1Score), scoreValue(team2Score));
  const invalidScore = !validScoreText(team1Score) || !validScoreText(team2Score);
  const tiedScore = team1Score !== "" && team2Score !== "" && Number(team1Score) === Number(team2Score);
  const winnerChangeBlocked = Boolean(game.result_locked && currentWinner && nextWinner && currentWinner !== nextWinner);
  const saveDisabled = invalidScore || tiedScore || winnerChangeBlocked;
  const resultText = bracketResultText(game);

  return (
    <article className={`score-game-card ${isUnscoredBracketGame(game) ? "" : "muted-game-row"}`.trim()}>
      <div className="score-game-header">
        <div>
          <h3>{bracketGameLabel(game)}</h3>
          <p className="muted">
            {game.division} {game.game_key}
          </p>
        </div>
        <span className={isUnscoredBracketGame(game) ? "pill warn" : "pill ok"}>{isUnscoredBracketGame(game) ? "Needs score" : resultText}</span>
      </div>
      {game.team_1 && game.team_2 ? (
        <div className="score-card-actions">
          {game.result_locked ? <p className={winnerChangeBlocked ? "pill warn" : "muted"}>{game.result_lock_reason}</p> : null}
          {tiedScore ? <p className="pill warn">Tournament games need a winner before saving.</p> : null}
          <form action={submitBracketScoreAction} className="score-card-form">
            <input name="bracket_game_id" type="hidden" value={game.id} />
            <ScoreTeamInput name="team_1_score" team={game.team_1} value={team1Score} onChange={setTeam1Score} />
            <ScoreTeamInput name="team_2_score" team={game.team_2} value={team2Score} onChange={setTeam2Score} />
            <button className="button" disabled={saveDisabled}>
              Save Score
            </button>
          </form>
          <div className="forfeit-actions">
            <span className="muted">Forfeit</span>
            <BracketForfeitButton game={game} teamId={game.team_1_id} teamName={game.team_1} />
            <BracketForfeitButton game={game} teamId={game.team_2_id} teamName={game.team_2} />
          </div>
          {isCompleteBracketResult(game) ? (
            <form action={resetBracketScoreAction}>
              <input name="bracket_game_id" type="hidden" value={game.id} />
              {game.reset_locked ? <p className="pill warn">{game.reset_lock_reason}</p> : null}
              <button className="button danger" disabled={Boolean(game.reset_locked)}>
                Reset
              </button>
            </form>
          ) : null}
        </div>
      ) : (
        <p className="muted">Waiting on bracket results</p>
      )}
    </article>
  );
}

function BracketForfeitButton({ game, teamId, teamName }: { game: EditableBracketGame; teamId: number | null; teamName: string }) {
  const currentWinner = currentWinnerSide(game);
  const forfeitWinner = teamId === game.team_1_id ? "team_2" : "team_1";
  const winnerChangeBlocked = Boolean(game.result_locked && currentWinner && currentWinner !== forfeitWinner);
  return (
    <form action={submitBracketForfeitAction}>
      <input name="bracket_game_id" type="hidden" value={game.id} />
      <input name="forfeit_team_id" type="hidden" value={teamId ?? ""} />
      <button className="button danger" disabled={!teamId || winnerChangeBlocked}>
        {teamName}
      </button>
    </form>
  );
}

function bracketGameLabel(game: EditableBracketGame) {
  if (game.game_key === "F1") return "Championship";
  if (game.game_key === "F2") return "If-needed Championship";
  return `${game.bracket_side === "losers" ? "Losers" : "Winners"} Round ${game.round} Game ${game.position}`;
}

function bracketResultText(game: EditableBracketGame) {
  if (game.result_type === "forfeit") {
    if (game.forfeit_team_id === game.team_1_id) return `${game.team_1 || "Team 1"} forfeited`;
    if (game.forfeit_team_id === game.team_2_id) return `${game.team_2 || "Team 2"} forfeited`;
    return "Forfeit";
  }
  if (game.team_1_score !== null && game.team_2_score !== null) return `${game.team_1_score}-${game.team_2_score}`;
  return "Scored";
}

function scoreValue(value: string) {
  if (!validScoreText(value)) return null;
  return Number(value);
}

function validScoreText(value: string) {
  return value !== "" && Number.isInteger(Number(value)) && Number(value) >= 0;
}

function winnerSide(team1Score: number | null, team2Score: number | null) {
  if (team1Score === null || team2Score === null || team1Score === team2Score) return null;
  return team1Score > team2Score ? "team_1" : "team_2";
}

function currentWinnerSide(game: EditableBracketGame) {
  if (game.winner_team_id !== null && game.winner_team_id === game.team_1_id) return "team_1";
  if (game.winner_team_id !== null && game.winner_team_id === game.team_2_id) return "team_2";
  return winnerSide(game.team_1_score, game.team_2_score);
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
            <span className={isUnscoredScheduleGame(game) ? "pill warn" : "pill ok"}>{isUnscoredScheduleGame(game) ? "Needs score" : scheduleResultText(game)}</span>
          </div>
          {game.team_1 && game.team_2 ? (
            <div className="score-card-actions">
              {game.score_locked ? (
                <>
                  <p className="pill warn">{game.score_lock_reason}</p>
                  <p className="muted">
                    Current result: {scheduleResultText(game)}
                  </p>
                </>
              ) : (
                <>
                  <form action={submitGameScoreAction} className="score-card-form">
                    <input name="game_id" type="hidden" value={game.id} />
                    <ScoreTeamInput name="team_1_score" team={game.team_1} defaultValue={game.team_1_score} />
                    <ScoreTeamInput name="team_2_score" team={game.team_2} defaultValue={game.team_2_score} />
                    <button className="button">Save Score</button>
                  </form>
                  <div className="forfeit-actions">
                    <span className="muted">Forfeit</span>
                    <ScheduleForfeitButton game={game} teamId={game.team_1_id} teamName={game.team_1} />
                    <ScheduleForfeitButton game={game} teamId={game.team_2_id} teamName={game.team_2} />
                  </div>
                  {isCompleteScheduleResult(game) ? (
                    <form action={resetGameScoreAction}>
                      <input name="game_id" type="hidden" value={game.id} />
                      <button className="button danger">Reset</button>
                    </form>
                  ) : null}
                </>
              )}
            </div>
          ) : (
            <p className="muted">Waiting on teams</p>
          )}
        </article>
      ))}
    </div>
  );
}

function ScheduleForfeitButton({ game, teamId, teamName }: { game: ScoreGame; teamId: number | null; teamName: string }) {
  return (
    <form action={submitGameForfeitAction}>
      <input name="game_id" type="hidden" value={game.id} />
      <input name="forfeit_team_id" type="hidden" value={teamId ?? ""} />
      <button className="button danger" disabled={!teamId}>
        {teamName}
      </button>
    </form>
  );
}

function scheduleResultText(game: ScoreGame) {
  if (game.result_type === "forfeit") {
    if (game.forfeit_team_id === game.team_1_id) return `${game.team_1 || "Team 1"} forfeited`;
    if (game.forfeit_team_id === game.team_2_id) return `${game.team_2 || "Team 2"} forfeited`;
    return "Forfeit";
  }
  if (game.team_1_score !== null && game.team_2_score !== null) return `${game.team_1_score}-${game.team_2_score}`;
  return "Scored";
}

function ScoreTeamInput({
  name,
  team,
  defaultValue,
  value,
  onChange
}: {
  name: string;
  team: string;
  defaultValue?: number | null;
  value?: string;
  onChange?: (value: string) => void;
}) {
  const controlledProps =
    value === undefined
      ? { defaultValue: defaultValue ?? "" }
      : {
          value,
          onChange: (event: ChangeEvent<HTMLInputElement>) => onChange?.(event.currentTarget.value)
        };
  return (
    <label className="score-team-input">
      <span>{team}</span>
      <input name={name} type="number" inputMode="numeric" min="0" required aria-label={`${team} score`} {...controlledProps} />
    </label>
  );
}
