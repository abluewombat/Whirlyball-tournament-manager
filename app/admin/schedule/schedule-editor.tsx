"use client";

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { moveScheduleGameAction } from "@/app/actions";

export type AdminScheduleGame = {
  id: number;
  phase: string;
  division: string;
  court: number;
  starts_at: string;
  team_1: string | null;
  team_2: string | null;
  team_1_score: number | null;
  team_2_score: number | null;
  result_type: string | null;
  ref_team: string | null;
  ref_team_division: string | null;
  label: string | null;
};

type ScheduleGridCell = {
  game: AdminScheduleGame | null;
  gameText: string;
  refText: string;
  refDivision: string;
  division: string;
};

type ScheduleGridRow = {
  startsAt: string;
  day: string;
  time: string;
  court1: ScheduleGridCell;
  court2: ScheduleGridCell;
};

const divisionClassNames: Record<string, string> = {
  A: "division-a",
  B: "division-b",
  C: "division-c",
  D: "division-d",
  Unlimited: "division-unlimited"
};

export function ScheduleEditor({ games }: { games: AdminScheduleGame[] }) {
  const router = useRouter();
  const [draggedGameId, setDraggedGameId] = useState<number | null>(null);
  const [message, setMessage] = useState("");
  const [isPending, startTransition] = useTransition();
  const rows = useMemo(() => buildScheduleGrid(games), [games]);

  function moveGame(startsAt: string, court: number) {
    if (!draggedGameId) return;
    const gameId = draggedGameId;
    setDraggedGameId(null);
    setMessage("Saving schedule change...");
    startTransition(async () => {
      await moveScheduleGameAction({ gameId, startsAt, court });
      setMessage("Schedule updated.");
      router.refresh();
    });
  }

  if (!rows.length) return <p className="muted">No generated schedule yet.</p>;

  return (
    <div className="schedule-grid-section">
      <div className="schedule-editor-toolbar">
        <div className="schedule-legend" aria-label="Division color legend">
          {Object.keys(divisionClassNames).map((division) => (
            <span className={`legend-chip ${divisionClassNames[division]}`} key={division}>
              {division}
            </span>
          ))}
        </div>
        <span className="muted">{isPending ? "Saving..." : message || "Drag a game onto another court/time to move or swap it."}</span>
      </div>

      <div className="schedule-grid-wrap">
        <table className="schedule-grid-table admin-schedule-grid">
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
            {rows.map((row) => (
              <tr key={row.startsAt}>
                <td className="schedule-day">{row.day}</td>
                <td className="schedule-time">{row.time}</td>
                <td className={refCellClass(row.court1.refDivision)}>{row.court1.refText}</td>
                {renderGameCell(row, row.court1, 1, draggedGameId, setDraggedGameId, moveGame)}
                {renderGameCell(row, row.court2, 2, draggedGameId, setDraggedGameId, moveGame)}
                <td className={refCellClass(row.court2.refDivision)}>{row.court2.refText}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function renderGameCell(
  row: ScheduleGridRow,
  cell: ScheduleGridCell,
  court: number,
  draggedGameId: number | null,
  setDraggedGameId: (id: number | null) => void,
  moveGame: (startsAt: string, court: number) => void
) {
  const isDragging = draggedGameId !== null && cell.game?.id === draggedGameId;
  const lockedReason = cell.game ? scheduleLockReason(cell.game) : null;
  const canDrop = !lockedReason;
  return (
    <td
      className={`${gameCellClass(cell.division)} schedule-drop-cell ${isDragging ? "is-dragging" : ""} ${lockedReason ? "is-locked" : ""}`.trim()}
      onDragOver={(event) => {
        if (canDrop) event.preventDefault();
      }}
      onDrop={(event) => {
        event.preventDefault();
        if (!canDrop) return;
        moveGame(row.startsAt, court);
      }}
    >
      {cell.game ? (
        <button
          className="schedule-drag-button"
          draggable={!lockedReason}
          disabled={Boolean(lockedReason)}
          type="button"
          title={lockedReason || "Move or swap this game"}
          onDragStart={(event) => {
            if (lockedReason) return;
            event.dataTransfer.effectAllowed = "move";
            event.dataTransfer.setData("text/plain", String(cell.game?.id || ""));
            if (cell.game) setDraggedGameId(cell.game.id);
          }}
          onDragEnd={() => setDraggedGameId(null)}
        >
          {cell.gameText}
          {lockedReason ? <span className="schedule-lock-note">{lockedReason}</span> : null}
        </button>
      ) : (
        <span className="schedule-empty-slot">Drop game here</span>
      )}
    </td>
  );
}

function buildScheduleGrid(games: AdminScheduleGame[]) {
  const rows = new Map<string, ScheduleGridRow>();

  for (const game of games) {
    const row =
      rows.get(game.starts_at) ||
      {
        startsAt: game.starts_at,
        day: formatDay(game.starts_at),
        time: formatTime(game.starts_at),
        court1: emptyCell(),
        court2: emptyCell()
      };
    const cell = {
      game,
      gameText: game.team_1 && game.team_2 ? `${game.division}: ${game.team_1} vs. ${game.team_2}` : `${game.division}: ${game.label || "Game"}`,
      refText: game.ref_team || "",
      refDivision: game.ref_team_division || "",
      division: game.division
    };

    if (game.court === 1) row.court1 = cell;
    if (game.court === 2) row.court2 = cell;
    rows.set(game.starts_at, row);
  }

  return [...rows.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([, row]) => row);
}

function emptyCell(): ScheduleGridCell {
  return { game: null, gameText: "", refText: "", refDivision: "", division: "" };
}

function gameCellClass(division: string) {
  return `schedule-game-cell ${divisionClassNames[division] || "schedule-empty-game-cell"}`.trim();
}

function refCellClass(division: string) {
  return `schedule-ref-cell ${divisionClassNames[division] || ""}`.trim();
}

function scheduleLockReason(game: AdminScheduleGame) {
  if (game.team_1_score !== null || game.team_2_score !== null || game.result_type === "forfeit") return "Scored game locked";
  return "";
}

function formatDay(value: string) {
  const literal = literalDateTimeParts(value);
  if (literal) return literal.day;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value.slice(0, 10);
  return date.toLocaleDateString("en-US", { weekday: "short", month: "numeric", day: "numeric" });
}

function formatTime(value: string) {
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
    day: date.toLocaleDateString("en-US", { weekday: "short", month: "numeric", day: "numeric" }),
    time: formatClock(Number(hour), minute)
  };
}

function formatClock(hour: number, minute: string) {
  const suffix = hour >= 12 ? "PM" : "AM";
  const displayHour = hour % 12 || 12;
  return `${displayHour}:${minute} ${suffix}`;
}
