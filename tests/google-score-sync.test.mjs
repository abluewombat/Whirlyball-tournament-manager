import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("Google schedule sync recognizes bracket game rows with assigned teams", async () => {
  const sync = await readFile(new URL("../lib/google-score-sync.ts", import.meta.url), "utf8");
  assert.match(sync, /parseTournamentPlaceholder\(rawTeam1, rawTeam2, refTeamName, inferredTournamentDivision\)/);
  assert.match(sync, /function findTournamentDivisionHeader/);
  assert.match(sync, /function inferTournamentDivisionFromTeamCells/);
  assert.match(sync, /playoffGameNumberFromText/);
});
