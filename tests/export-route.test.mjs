import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("export route includes Rules Check as the first workbook sheet", async () => {
  const route = await readFile(new URL("../app/api/export/route.ts", import.meta.url), "utf8");
  const rulesSheetDefinition = route.indexOf('workbook.addWorksheet("Rules Check"');
  const rulesSheetCall = route.indexOf("addRulesCheckSheet(workbook, rulesReport);");
  const firstScheduleSheetCall = route.indexOf("addScheduleGridSheet(workbook, games);");

  assert.notEqual(rulesSheetDefinition, -1);
  assert.notEqual(rulesSheetCall, -1);
  assert.notEqual(firstScheduleSheetCall, -1);
  assert.ok(rulesSheetCall < firstScheduleSheetCall);
});
