import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("schedule grid keeps tournament rows visible even when completed", async () => {
  const grid = await readFile(new URL("../app/schedule/schedule-day-grid.tsx", import.meta.url), "utf8");
  assert.match(grid, /showOldGames \|\| hasUnscoredGame\(row\) \|\| hasTournamentGame\(row\)/);
  assert.match(grid, /function hasTournamentGame/);
});
