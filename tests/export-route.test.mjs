import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("export route temporarily emits only schedule and schedule details sheets", async () => {
  const route = await readFile(new URL("../app/api/export/route.ts", import.meta.url), "utf8");
  const scheduleSheetCall = route.indexOf("addScheduleGridSheet(workbook, games, timeZone);");
  const detailsSheetCall = route.indexOf("addScheduleDetailSheet(workbook, games, timeZone);");

  assert.notEqual(scheduleSheetCall, -1);
  assert.notEqual(detailsSheetCall, -1);
  assert.ok(scheduleSheetCall < detailsSheetCall);
  assert.equal(route.includes("addRulesCheckSheet(workbook, rulesReport);"), false);
  assert.equal(route.includes("addScheduleSummarySheet(workbook, teams, games);"), false);
  assert.equal(route.includes("addOpponentMatrixSheet(workbook, teams, games);"), false);
  assert.equal(route.includes('addObjectSheet(workbook, "Teams", teams);'), false);
});

test("export route does not treat UTC database timestamps as literal local times", async () => {
  const route = await readFile(new URL("../app/api/export/route.ts", import.meta.url), "utf8");

  assert.match(route, /function hasExplicitTimeZone/);
  assert.match(route, /if \(hasExplicitTimeZone\(value\)\) return null;/);
  assert.match(route, /timeZone = tournament\.timezone \|\| defaultTournamentTimeZone/);
});
