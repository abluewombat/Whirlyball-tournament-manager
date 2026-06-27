import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("Google score sync does not block seeding scores after brackets exist", async () => {
  const scoreSync = await readFile(new URL("../lib/score-sync.ts", import.meta.url), "utf8");
  assert.doesNotMatch(scoreSync, /Seeding score is locked because an active bracket exists for this division/);
  assert.doesNotMatch(scoreSync, /activeBracketExistsForDivision/);
});
