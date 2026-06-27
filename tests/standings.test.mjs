import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("standings use head-to-head before point differential", async () => {
  const standings = await readFile(new URL("../lib/standings.ts", import.meta.url), "utf8");
  const headToHeadTieBreaker = standings.indexOf("leftHeadToHead.standingPoints");
  const pointDiffTieBreaker = standings.indexOf("left.point_diff");
  assert.notEqual(headToHeadTieBreaker, -1);
  assert.notEqual(pointDiffTieBreaker, -1);
  assert.ok(headToHeadTieBreaker < pointDiffTieBreaker);
  assert.doesNotMatch(standings, /left\.wins !== right\.wins/);
});
