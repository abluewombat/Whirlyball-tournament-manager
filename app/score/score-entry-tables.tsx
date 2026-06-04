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
  const unscoredSeedingCount = useMemo(() => seedingGames.filter(isUnscoredScheduleGame).length, [seedingGames]);
  const unscoredBracketCount = useMemo(() => bracketGames.filter(isUnscoredBracketGame).length, [bracketGames]);
  const allSeedingScored = seedingGames.length > 0 && unscoredSeedingCount === 0;
  const [seedingOpen, setSeedingOpen] = useState(!bracketsReady || allSeedingScored);
  const [tournamentOpen, setTournamentOpen] = useState(bracketsReady || unscoredBracketCount === 0);
  const visibleSeedingGames = useMemo(
    () => (showAllSeeding ? seedingGames : seedingGames.filter(isUnscoredScheduleGame)),
    [seedingGames, showAllSeeding]
  );
  const visibleBracketGames = useMemo(
    () => (showAllTournament ? bracketGames : bracketGames.filter(isUnscoredBracketGame)),
    [bracketGames, showAllTournament]
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
          <BracketScoreTable games={visibleBracketGames} emptyText={showAllTournament ? "No bracket games available." : "No unscored bracket games."} />
        </details>
      ) : null}
    </>
  );
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
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            <th>Game</th>
            <th>Team 1</th>
            <th>Team 2</th>
            <th>Score</th>
          </tr>
        </thead>
        <tbody>
          {games.map((game) => (
            <tr key={`bracket-${game.id}`} className={game.team_1_score !== null && game.team_2_score !== null ? "muted-game-row" : ""}>
              <td>
                {bracketGameLabel(game)}
                <div className="muted">
                  {game.division} {game.game_key}
                </div>
              </td>
              <td>{game.team_1 || "TBD"}</td>
              <td>{game.team_2 || "TBD"}</td>
              <td>
                {game.team_1 && game.team_2 ? (
                  <div className="score-actions">
                    <form action={submitBracketScoreAction} className="inline-form">
                      <input name="bracket_game_id" type="hidden" value={game.id} />
                      <input name="team_1_score" type="number" min="0" defaultValue={game.team_1_score ?? ""} placeholder={game.team_1} style={{ width: 90 }} />
                      <input name="team_2_score" type="number" min="0" defaultValue={game.team_2_score ?? ""} placeholder={game.team_2} style={{ width: 90 }} />
                      <button className="button secondary">Save</button>
                    </form>
                    {game.team_1_score !== null && game.team_2_score !== null ? (
                      <form action={resetBracketScoreAction}>
                        <input name="bracket_game_id" type="hidden" value={game.id} />
                        <button className="button danger">Reset</button>
                      </form>
                    ) : null}
                  </div>
                ) : (
                  <span className="muted">Waiting on bracket results</span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
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
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            <th>Game</th>
            <th>Team 1</th>
            <th>Team 2</th>
            <th>Score</th>
          </tr>
        </thead>
        <tbody>
          {games.map((game) => (
            <tr key={`schedule-${game.id}`} className={game.team_1_score !== null && game.team_2_score !== null ? "muted-game-row" : ""}>
              <td>
                {game.starts_at ? `${displayDateTime(game.starts_at)} Court ${game.court}` : game.label}
                <div className="muted">
                  {game.division} {game.phase}
                </div>
              </td>
              <td>{game.team_1 || "TBD"}</td>
              <td>{game.team_2 || "TBD"}</td>
              <td>
                {game.team_1 && game.team_2 ? (
                  <div className="score-actions">
                    <form action={submitGameScoreAction} className="inline-form">
                      <input name="game_id" type="hidden" value={game.id} />
                      <input name="team_1_score" type="number" min="0" defaultValue={game.team_1_score ?? ""} placeholder={game.team_1} style={{ width: 90 }} />
                      <input name="team_2_score" type="number" min="0" defaultValue={game.team_2_score ?? ""} placeholder={game.team_2} style={{ width: 90 }} />
                      <button className="button secondary">Save</button>
                    </form>
                    {game.team_1_score !== null && game.team_2_score !== null ? (
                      <form action={resetGameScoreAction}>
                        <input name="game_id" type="hidden" value={game.id} />
                        <button className="button danger">Reset</button>
                      </form>
                    ) : null}
                  </div>
                ) : (
                  <span className="muted">Waiting on teams</span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
