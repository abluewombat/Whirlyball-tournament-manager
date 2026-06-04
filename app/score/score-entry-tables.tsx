"use client";

import { useEffect, useMemo, useState, type ChangeEvent } from "react";
import {
  resetGameScoreAction,
  resetBracketScoreAction,
  submitBracketForfeitAction,
  submitBracketScoreAction,
  submitGameForfeitAction,
  submitGameScoreAction
} from "@/app/actions";

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
  schedule_label: string | null;
  starts_at: string | null;
  court: number | null;
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
  const scoreableSeedingGames = useMemo(() => seedingGames.filter(isScoreableGame), [seedingGames]);
  const scoreableBracketGames = useMemo(() => bracketGames.filter((game) => isScoreableGame(game) && game.starts_at && game.court), [bracketGames]);
  const [showAllSeeding, setShowAllSeeding] = useState(false);
  const [showAllTournament, setShowAllTournament] = useState(false);
  const [seedingDayFilter, setSeedingDayFilter] = useState("");
  const [tournamentDayFilter, setTournamentDayFilter] = useState("");
  const [seedingDivisionFilter, setSeedingDivisionFilter] = useState("all");
  const [seedingTeamFilter, setSeedingTeamFilter] = useState("all");
  const [seedingCourtFilter, setSeedingCourtFilter] = useState("all");
  const [tournamentDivisionFilter, setTournamentDivisionFilter] = useState("all");
  const [tournamentTeamFilter, setTournamentTeamFilter] = useState("all");
  const [tournamentCourtFilter, setTournamentCourtFilter] = useState("all");
  const unscoredSeedingCount = useMemo(() => scoreableSeedingGames.filter(isUnscoredScheduleGame).length, [scoreableSeedingGames]);
  const unscoredBracketCount = useMemo(() => scoreableBracketGames.filter(isUnscoredBracketGame).length, [scoreableBracketGames]);
  const allSeedingScored = scoreableSeedingGames.length > 0 && unscoredSeedingCount === 0;
  const [seedingOpen, setSeedingOpen] = useState(!bracketsReady || allSeedingScored);
  const [tournamentOpen, setTournamentOpen] = useState(bracketsReady || unscoredBracketCount === 0);
  const seedingDays = useMemo(() => dayOptions(scoreableSeedingGames), [scoreableSeedingGames]);
  const selectedSeedingDay = seedingDayFilter || defaultDayFilter(seedingDays);
  const tournamentDays = useMemo(() => dayOptions(scoreableBracketGames), [scoreableBracketGames]);
  const selectedTournamentDay = tournamentDayFilter || defaultDayFilter(tournamentDays);
  const seedingBaseGames = useMemo(() => filterByDay(showAllSeeding ? scoreableSeedingGames : scoreableSeedingGames.filter(isUnscoredScheduleGame), selectedSeedingDay), [scoreableSeedingGames, showAllSeeding, selectedSeedingDay]);
  const tournamentBaseGames = useMemo(() => filterByDay(showAllTournament ? scoreableBracketGames : scoreableBracketGames.filter(isUnscoredBracketGame), selectedTournamentDay), [scoreableBracketGames, showAllTournament, selectedTournamentDay]);
  const seedingDivisions = useMemo(() => divisionOptions(seedingBaseGames), [seedingBaseGames]);
  const tournamentDivisions = useMemo(() => divisionOptions(tournamentBaseGames), [tournamentBaseGames]);
  const seedingTeams = useMemo(() => teamOptions(seedingBaseGames, seedingDivisionFilter), [seedingBaseGames, seedingDivisionFilter]);
  const tournamentTeams = useMemo(() => teamOptions(tournamentBaseGames, tournamentDivisionFilter), [tournamentBaseGames, tournamentDivisionFilter]);
  const seedingCourts = useMemo(() => courtOptions(seedingBaseGames), [seedingBaseGames]);
  const tournamentCourts = useMemo(() => courtOptions(tournamentBaseGames), [tournamentBaseGames]);
  const visibleSeedingGames = useMemo(
    () => filterScoreRows(seedingBaseGames, seedingDivisionFilter, seedingTeamFilter, seedingCourtFilter),
    [seedingBaseGames, seedingDivisionFilter, seedingTeamFilter, seedingCourtFilter]
  );
  const visibleBracketGames = useMemo(
    () => filterScoreRows(tournamentBaseGames, tournamentDivisionFilter, tournamentTeamFilter, tournamentCourtFilter),
    [tournamentBaseGames, tournamentDivisionFilter, tournamentTeamFilter, tournamentCourtFilter]
  );

  useEffect(() => {
    if (seedingDivisionFilter !== "all" && !seedingDivisions.includes(seedingDivisionFilter)) setSeedingDivisionFilter("all");
    if (seedingTeamFilter !== "all" && !seedingTeams.includes(seedingTeamFilter)) setSeedingTeamFilter("all");
    if (seedingCourtFilter !== "all" && !seedingCourts.includes(Number(seedingCourtFilter))) setSeedingCourtFilter("all");
  }, [seedingCourtFilter, seedingCourts, seedingDivisionFilter, seedingDivisions, seedingTeamFilter, seedingTeams]);

  useEffect(() => {
    if (tournamentDivisionFilter !== "all" && !tournamentDivisions.includes(tournamentDivisionFilter)) setTournamentDivisionFilter("all");
    if (tournamentTeamFilter !== "all" && !tournamentTeams.includes(tournamentTeamFilter)) setTournamentTeamFilter("all");
    if (tournamentCourtFilter !== "all" && !tournamentCourts.includes(Number(tournamentCourtFilter))) setTournamentCourtFilter("all");
  }, [tournamentCourtFilter, tournamentCourts, tournamentDivisionFilter, tournamentDivisions, tournamentTeamFilter, tournamentTeams]);

  return (
    <>
      <details className="section card score-collapse" open={seedingOpen} onToggle={(event) => setSeedingOpen(event.currentTarget.open)}>
        <summary>
          <span>Seeding Score Entry</span>
          <span className={allSeedingScored ? "pill ok" : "pill warn"}>{allSeedingScored ? "Complete" : `${unscoredSeedingCount} left`}</span>
        </summary>
        <ScoreFilterControl
          isShowingAll={showAllSeeding}
          showText="Show All Seeding Games"
          hideText="Hide Scored Seeding Games"
          onToggle={() => setShowAllSeeding((value) => !value)}
        />
        <ScoreDayFilter label="Seeding" days={seedingDays} selectedDay={selectedSeedingDay} onDayChange={setSeedingDayFilter} />
        <ScoreScopeFilters
          label="Seeding"
          divisions={seedingDivisions}
          teams={seedingTeams}
          courts={seedingCourts}
          selectedDivision={seedingDivisionFilter}
          selectedTeam={seedingTeamFilter}
          selectedCourt={seedingCourtFilter}
          onDivisionChange={(division) => {
            setSeedingDivisionFilter(division);
            setSeedingTeamFilter("all");
          }}
          onTeamChange={setSeedingTeamFilter}
          onCourtChange={setSeedingCourtFilter}
        />
        <ScheduleScoreGrid games={visibleSeedingGames} emptyText={showAllSeeding ? "No seeding games available for this day." : "No unscored seeding games for this day."} />
      </details>

      {scoreableBracketGames.length ? (
        <details className="section card score-collapse" open={tournamentOpen} onToggle={(event) => setTournamentOpen(event.currentTarget.open)}>
          <summary>
            <span>Tournament Score Entry</span>
            <span className={unscoredBracketCount ? "pill warn" : "pill ok"}>{unscoredBracketCount ? `${unscoredBracketCount} left` : "Complete"}</span>
          </summary>
          <ScoreFilterControl
            isShowingAll={showAllTournament}
            showText="Show All Tournament Games"
            hideText="Hide Scored Tournament Games"
            onToggle={() => setShowAllTournament((value) => !value)}
          />
          <ScoreDayFilter label="Tournament" days={tournamentDays} selectedDay={selectedTournamentDay} onDayChange={setTournamentDayFilter} />
          <ScoreScopeFilters
            label="Tournament"
            divisions={tournamentDivisions}
            teams={tournamentTeams}
            courts={tournamentCourts}
            selectedDivision={tournamentDivisionFilter}
            selectedTeam={tournamentTeamFilter}
            selectedCourt={tournamentCourtFilter}
            onDivisionChange={(division) => {
              setTournamentDivisionFilter(division);
              setTournamentTeamFilter("all");
            }}
            onTeamChange={setTournamentTeamFilter}
            onCourtChange={setTournamentCourtFilter}
          />
          <BracketScheduleScoreGrid games={visibleBracketGames} emptyText={showAllTournament ? "No bracket games available for this day." : "No unscored bracket games for this day."} />
        </details>
      ) : null}
    </>
  );
}

type FilterableScoreRow = {
  division: string;
  court: number | string | null;
  team_1: string | null;
  team_2: string | null;
};

const divisionOrder = ["A", "B", "C", "D", "Unlimited"];

function ScoreScopeFilters({
  label,
  divisions,
  teams,
  courts,
  selectedDivision,
  selectedTeam,
  selectedCourt,
  onDivisionChange,
  onTeamChange,
  onCourtChange
}: {
  label: string;
  divisions: string[];
  teams: string[];
  courts: number[];
  selectedDivision: string;
  selectedTeam: string;
  selectedCourt: string;
  onDivisionChange: (division: string) => void;
  onTeamChange: (team: string) => void;
  onCourtChange: (court: string) => void;
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
      <label>
        Court
        <select value={selectedCourt} onChange={(event) => onCourtChange(event.target.value)}>
          <option value="all">All courts</option>
          {courts.map((court) => (
            <option value={String(court)} key={court}>
              Court {court}
            </option>
          ))}
        </select>
      </label>
    </div>
  );
}

function ScoreDayFilter({
  label,
  days,
  selectedDay,
  onDayChange
}: {
  label: string;
  days: Array<{ key: string; label: string }>;
  selectedDay: string;
  onDayChange: (day: string) => void;
}) {
  const selectedDayExists = selectedDay === "all" || days.some((day) => day.key === selectedDay);
  return (
    <div className="score-filter-grid score-day-filter" aria-label={`${label} day filter`}>
      <label>
        Day
        <select value={selectedDay} onChange={(event) => onDayChange(event.target.value)}>
          <option value="all">All days</option>
          {!selectedDayExists ? <option value={selectedDay}>Today</option> : null}
          {days.map((day) => (
            <option value={day.key} key={day.key}>
              {day.label}
            </option>
          ))}
        </select>
      </label>
    </div>
  );
}

function divisionOptions(games: FilterableScoreRow[]) {
  return [...new Set(games.map((game) => game.division))].sort(compareDivisions);
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

function courtOptions(games: FilterableScoreRow[]) {
  return [...new Set(games.map((game) => normalizeCourt(game.court)).filter((court): court is number => court !== null))].sort((left, right) => left - right);
}

function compareDivisions(left: string, right: string) {
  const leftIndex = divisionOrder.indexOf(left);
  const rightIndex = divisionOrder.indexOf(right);
  if (leftIndex !== -1 && rightIndex !== -1) return leftIndex - rightIndex;
  if (leftIndex !== -1) return -1;
  if (rightIndex !== -1) return 1;
  return left.localeCompare(right);
}

function filterScoreRows<T extends FilterableScoreRow>(games: T[], divisionFilter: string, teamFilter: string, courtFilter: string) {
  const selectedCourt = normalizeCourt(courtFilter);
  return games.filter((game) => {
    const divisionMatches = divisionFilter === "all" || game.division === divisionFilter;
    const teamMatches = teamFilter === "all" || game.team_1 === teamFilter || game.team_2 === teamFilter;
    const courtMatches = courtFilter === "all" || normalizeCourt(game.court) === selectedCourt;
    return divisionMatches && teamMatches && courtMatches;
  });
}

function normalizeCourt(court: number | string | null) {
  if (court === null || court === "") return null;
  const value = Number(court);
  return Number.isInteger(value) && value > 0 ? value : null;
}

type DatedScoreRow = {
  starts_at: string | null;
};

function filterByDay<T extends DatedScoreRow>(games: T[], dayFilter: string) {
  if (dayFilter === "all") return games;
  return games.filter((game) => game.starts_at && dateKey(game.starts_at) === dayFilter);
}

function dayOptions(games: DatedScoreRow[]) {
  const days = new Map<string, string>();
  for (const game of games) {
    if (!game.starts_at) continue;
    const key = dateKey(game.starts_at);
    if (!key) continue;
    days.set(key, dayLabel(game.starts_at));
  }
  return [...days.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, label]) => ({ key, label }));
}

function defaultDayFilter(days: Array<{ key: string; label: string }>) {
  if (!days.length) return "all";
  const today = todayKey();
  const firstDay = days[0].key;
  const lastDay = days[days.length - 1].key;
  if (today < firstDay) return firstDay;
  if (today > lastDay) return lastDay;
  return today;
}

function ScoreFilterControl({
  isShowingAll,
  showText,
  hideText,
  onToggle
}: {
  isShowingAll: boolean;
  showText: string;
  hideText: string;
  onToggle: () => void;
}) {
  return (
    <div className="actions">
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

function isScoreableGame(game: FilterableScoreRow) {
  return Boolean(game.team_1 && game.team_2);
}

function BracketScheduleScoreGrid({ games, emptyText }: { games: EditableBracketGame[]; emptyText: string }) {
  if (!games.length) return <p className="muted">{emptyText}</p>;
  const scheduledGames = games.filter((game) => game.starts_at && game.court);
  const unscheduledGames = games.filter((game) => !game.starts_at || !game.court);
  const rows = buildBracketScheduleScoreRows(scheduledGames);
  if (!rows.rows.length && !unscheduledGames.length) return <p className="muted">{emptyText}</p>;
  return (
    <>
      {rows.rows.length ? (
        <div className="score-schedule-list">
          {rows.rows.map((row) => (
            <div className="score-schedule-list-row" key={row.startsAt}>
              <div className="score-schedule-time">
                <strong>{timeLabel(row.startsAt)}</strong>
                <span>{dayLabel(row.startsAt)}</span>
              </div>
              <div className="score-schedule-games">
                {row.games.map((game) => (
                  <div className="score-schedule-cell" data-court-label={`Court ${game.court}`} key={`bracket-${game.id}`}>
                    <BracketScoreCard game={game} />
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      ) : null}
      {unscheduledGames.length ? (
        <div className="score-entry-list">
          <p className="muted">These bracket games do not have synced schedule slots yet.</p>
          {unscheduledGames.map((game) => (
            <BracketScoreCard game={game} key={`bracket-${game.id}`} />
          ))}
        </div>
      ) : null}
    </>
  );
}

function buildBracketScheduleScoreRows(games: EditableBracketGame[]) {
  const rows = new Map<string, { startsAt: string; games: EditableBracketGame[] }>();
  for (const game of [...games].sort((left, right) => (left.starts_at || "").localeCompare(right.starts_at || "") || (left.court || 0) - (right.court || 0))) {
    const court = normalizeCourt(game.court);
    if (!game.starts_at || court === null) continue;
    const row = rows.get(game.starts_at) || { startsAt: game.starts_at, games: [] };
    row.games.push(game);
    rows.set(game.starts_at, row);
  }
  return { rows: [...rows.values()].filter((row) => row.games.length > 0).sort((left, right) => left.startsAt.localeCompare(right.startsAt)) };
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
            {game.division} {game.game_key}{game.court ? ` · Court ${game.court}` : ""}
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

function ScheduleScoreGrid({ games, emptyText }: { games: ScoreGame[]; emptyText: string }) {
  if (!games.length) return <p className="muted">{emptyText}</p>;
  const rows = buildScheduleScoreRows(games);
  if (!rows.rows.length) return <p className="muted">{emptyText}</p>;
  return (
    <div className="score-schedule-list">
      {rows.rows.map((row) => (
        <div className="score-schedule-list-row" key={row.startsAt}>
          <div className="score-schedule-time">
            <strong>{timeLabel(row.startsAt)}</strong>
            <span>{dayLabel(row.startsAt)}</span>
          </div>
          <div className="score-schedule-games">
            {row.games.map((game) => (
              <div className="score-schedule-cell" data-court-label={`Court ${game.court}`} key={`seeding-${game.id}`}>
                <ScoreGameCard game={game} />
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

function ScoreGameCard({ game }: { game: ScoreGame }) {
  return (
    <article className={`score-game-card ${isUnscoredScheduleGame(game) ? "" : "muted-game-row"}`.trim()}>
      <div className="score-game-header">
        <div>
          <h3>{game.team_1 && game.team_2 ? `${game.team_1} vs. ${game.team_2}` : game.label || `Court ${game.court}`}</h3>
          <p className="muted">
            {game.division} seeding · Court {game.court}
          </p>
        </div>
        <span className={isUnscoredScheduleGame(game) ? "pill warn" : "pill ok"}>{isUnscoredScheduleGame(game) ? "Needs score" : scheduleResultText(game)}</span>
      </div>
      {game.team_1 && game.team_2 ? (
        <div className="score-card-actions">
          {game.score_locked ? (
            <>
              <p className="pill warn">{game.score_lock_reason}</p>
              <p className="muted">Current result: {scheduleResultText(game)}</p>
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
  );
}

function buildScheduleScoreRows(games: ScoreGame[]) {
  const rows = new Map<string, { startsAt: string; games: ScoreGame[] }>();
  for (const game of [...games].sort((left, right) => left.starts_at.localeCompare(right.starts_at) || left.court - right.court)) {
    const court = normalizeCourt(game.court);
    if (court === null) continue;
    const row = rows.get(game.starts_at) || { startsAt: game.starts_at, games: [] };
    row.games.push(game);
    rows.set(game.starts_at, row);
  }
  return { rows: [...rows.values()].filter((row) => row.games.length > 0).sort((left, right) => left.startsAt.localeCompare(right.startsAt)) };
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

function todayKey() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}

function dateKey(value: string) {
  const literal = literalDateTimeParts(value);
  if (literal) return literal.dateKey;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value.slice(0, 10);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function dayLabel(value: string) {
  const literal = literalDateTimeParts(value);
  if (literal) return literal.day;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value.slice(0, 10);
  return date.toLocaleDateString("en-US", { weekday: "short", month: "numeric", day: "numeric" });
}

function timeLabel(value: string) {
  const literal = literalDateTimeParts(value);
  if (literal) return literal.time;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value.slice(11, 16);
  return date.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
}

function literalDateTimeParts(value: string) {
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/);
  if (!match) return null;
  const [, year, month, day, hour, minute] = match;
  const date = new Date(Number(year), Number(month) - 1, Number(day));
  if (Number.isNaN(date.getTime())) return null;
  return {
    dateKey: `${year}-${month}-${day}`,
    day: date.toLocaleDateString("en-US", { weekday: "short", month: "numeric", day: "numeric" }),
    time: formatClock(Number(hour), minute)
  };
}

function formatClock(hour: number, minute: string) {
  const suffix = hour >= 12 ? "PM" : "AM";
  const displayHour = hour % 12 || 12;
  return `${displayHour}:${minute} ${suffix}`;
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
