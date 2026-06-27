"use client";

import { useEffect, useMemo, useState } from "react";

export type ScheduleDayOption = {
  key: string;
  label: string;
};

type ScheduleGridRow = {
  dayKey: string;
  dayName: string;
  day: string;
  time: string;
  court1Ref: string;
  court1RefDivision: string;
  court1Game: string;
  court1Division: string;
  court1Scored: boolean;
  court1Tournament?: boolean;
  court1TournamentTeamCount?: number;
  court1StreamUrl: string;
  court1StreamLabel: string;
  court1CourtTime?: string;
  court2Game: string;
  court2Division: string;
  court2Scored: boolean;
  court2Tournament?: boolean;
  court2TournamentTeamCount?: number;
  court2StreamUrl: string;
  court2StreamLabel: string;
  court2CourtTime?: string;
  court2Ref: string;
  court2RefDivision: string;
};

const divisionClassNames: Record<string, string> = {
  A: "division-a",
  B: "division-b",
  C: "division-c",
  D: "division-d",
  Unlimited: "division-unlimited"
};

export function ScheduleDayGrid({
  rows,
  days,
  initialDay
}: {
  rows: ScheduleGridRow[];
  days: ScheduleDayOption[];
  initialDay: string;
}) {
  const [selectedDay, setSelectedDay] = useState(initialDay);
  const [showOldGames, setShowOldGames] = useState(false);
  const [selectedDivision, setSelectedDivision] = useState("all");
  const selectedDayExists = days.some((day) => day.key === selectedDay);
  const effectiveDay = selectedDayExists ? selectedDay : "all";
  const visibleRows = useMemo(() => {
    return rows
      .filter((row) => effectiveDay === "all" || row.dayKey === effectiveDay)
      .map((row) => filterRowByDivision(row, selectedDivision))
      .filter((row) => showOldGames || hasUnscoredGame(row))
      .filter(hasVisibleGame);
  }, [effectiveDay, rows, selectedDivision, showOldGames]);

  useEffect(() => setSelectedDay(initialDay), [initialDay]);

  function changeDay(day: string) {
    setSelectedDay(day);
    const url = new URL(window.location.href);
    url.searchParams.set("day", day);
    window.history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`);
  }

  return (
    <>
      <div className="schedule-day-control">
        <label>
          Day
          <select value={effectiveDay} onChange={(event) => changeDay(event.currentTarget.value)}>
            {days.map((day) => (
              <option key={day.key} value={day.key}>{day.label}</option>
            ))}
          </select>
        </label>
        <label>
          Division
          <select value={selectedDivision} onChange={(event) => setSelectedDivision(event.currentTarget.value)}>
            <option value="all">All</option>
            <option value="A">A</option>
            <option value="B">B</option>
            <option value="C">C</option>
            <option value="D">D</option>
          </select>
        </label>
        <label className="schedule-checkbox-control">
          <input
            checked={showOldGames}
            onChange={(event) => setShowOldGames(event.currentTarget.checked)}
            type="checkbox"
          />
          Show old games
        </label>
      </div>
      <div className="schedule-grid-wrap">
        <table className="schedule-grid-table">
          <thead>
            <tr>
              <th>Day</th>
              <th>Time</th>
              <th>Ref Court 1</th>
              <th>Court 1</th>
              <th>Court 2</th>
              <th>Ref Court 2</th>
            </tr>
          </thead>
          <tbody>
            {visibleRows.map((row) => (
              <tr key={`${row.dayKey}-${row.time}`}>
                <td className="schedule-day">{row.day}</td>
                <td className="schedule-time">
                  <span>{row.time}</span>
                  <AdjustedCourtTimes court1={row.court1CourtTime} court2={row.court2CourtTime} />
                </td>
                <td className={refCellClass(row.court1RefDivision)}>{row.court1Ref}</td>
                <td className={gameCellClass(row.court1Division, row.court1Scored, row.court1TournamentTeamCount)}>
                  <GameCellContent text={row.court1Game} tournament={row.court1Tournament} />
                  {row.court1StreamUrl ? (
                    <a className="schedule-stream-link" href={row.court1StreamUrl} target="_blank" rel="noreferrer">
                      {row.court1StreamLabel}
                    </a>
                  ) : null}
                </td>
                <td className={gameCellClass(row.court2Division, row.court2Scored, row.court2TournamentTeamCount)}>
                  <GameCellContent text={row.court2Game} tournament={row.court2Tournament} />
                  {row.court2StreamUrl ? (
                    <a className="schedule-stream-link" href={row.court2StreamUrl} target="_blank" rel="noreferrer">
                      {row.court2StreamLabel}
                    </a>
                  ) : null}
                </td>
                <td className={refCellClass(row.court2RefDivision)}>{row.court2Ref}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

function filterRowByDivision(row: ScheduleGridRow, division: string): ScheduleGridRow {
  if (division === "all") return row;
  const next = { ...row };
  if (next.court1Division !== division) {
    next.court1Ref = "";
    next.court1RefDivision = "";
    next.court1Game = "";
    next.court1Division = "";
    next.court1Scored = false;
    next.court1Tournament = false;
    next.court1TournamentTeamCount = 0;
    next.court1StreamUrl = "";
    next.court1StreamLabel = "";
    next.court1CourtTime = "";
  }
  if (next.court2Division !== division) {
    next.court2Game = "";
    next.court2Division = "";
    next.court2Scored = false;
    next.court2Tournament = false;
    next.court2TournamentTeamCount = 0;
    next.court2StreamUrl = "";
    next.court2StreamLabel = "";
    next.court2CourtTime = "";
    next.court2Ref = "";
    next.court2RefDivision = "";
  }
  return next;
}

function hasVisibleGame(row: ScheduleGridRow) {
  return Boolean(row.court1Game || row.court2Game);
}

function hasUnscoredGame(row: ScheduleGridRow) {
  return Boolean((row.court1Game && !row.court1Scored) || (row.court2Game && !row.court2Scored));
}

function gameCellClass(division: string, scored = false, tournamentTeamCount = 0) {
  const tournamentClass = tournamentTeamCount >= 2 ? "tournament-game-complete" : tournamentTeamCount === 1 ? "tournament-game-partial" : "";
  return `schedule-game-cell ${divisionClassNames[division] || ""} ${scored ? "muted-game-row" : ""} ${tournamentClass}`.trim();
}

function refCellClass(division: string) {
  return `schedule-ref-cell ${divisionClassNames[division] || ""}`.trim();
}

function AdjustedCourtTimes({ court1 = "", court2 = "" }: { court1?: string; court2?: string }) {
  if (!court1 && !court2) return null;
  if (court1 && court1 === court2) return <span className="schedule-adjusted-time">{court1}</span>;
  return (
    <span className="schedule-adjusted-time">
      {court1 ? <span>C1 {court1}</span> : null}
      {court2 ? <span>C2 {court2}</span> : null}
    </span>
  );
}

function GameCellContent({ text, tournament = false }: { text: string; tournament?: boolean }) {
  if (!text) return null;
  return (
    <span className="schedule-game-main">
      {tournament ? <span className="schedule-tournament-badge" aria-label="Tournament game">T</span> : null}
      <span>{text}</span>
    </span>
  );
}
