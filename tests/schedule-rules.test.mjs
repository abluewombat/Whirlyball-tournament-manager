import test from "node:test";
import assert from "node:assert/strict";
import { buildScheduleRulesReport } from "../lib/schedule-rules.ts";

test("blocked ref rule flags ref teams with overlapping blockers", () => {
  const report = reportFor({
    games: [
      {
        id: 1,
        phase: "seeding",
        division: "A",
        court: 1,
        starts_at: "2026-06-23T10:00:00",
        team_1_id: 101,
        team_2_id: 102,
        ref_team_id: 201,
        label: "A R1"
      }
    ],
    teams: [{ id: 201, division: "B", center: "Texas", name: "Refs" }],
    availabilityBlocks: [{ id: 1, team_id: 201, starts_at: "2026-06-23T10:10:00", ends_at: "2026-06-23T10:30:00", reason: "Arriving late" }]
  });

  const rule = ruleById(report, "blocked-ref-assignments");
  assert.equal(rule.issueCount, 1);
  assert.equal(rule.issues[0].team, "B Texas Refs");
});

test("blocked ref rule treats touching blocker boundaries as available", () => {
  const report = reportFor({
    games: [
      {
        id: 1,
        phase: "seeding",
        division: "A",
        court: 1,
        starts_at: "2026-06-23T10:00:00",
        team_1_id: 101,
        team_2_id: 102,
        ref_team_id: 201,
        label: "A R1"
      }
    ],
    teams: [{ id: 201, division: "B", center: "Texas", name: "Refs" }],
    availabilityBlocks: [{ id: 1, team_id: 201, starts_at: "2026-06-23T09:00:00", ends_at: "2026-06-23T10:00:00", reason: null }]
  });

  assert.equal(ruleById(report, "blocked-ref-assignments").issueCount, 0);
});

test("blocked ref rule uses tournament duration for ref windows", () => {
  const report = reportFor({
    games: [
      {
        id: 1,
        phase: "tournament",
        division: "A",
        court: 1,
        starts_at: "2026-06-27T12:00:00",
        team_1_id: 101,
        team_2_id: 102,
        ref_team_id: 201,
        label: "Winners R1"
      }
    ],
    teams: [{ id: 201, division: "B", center: "Texas", name: "Refs" }],
    availabilityBlocks: [{ id: 1, team_id: 201, starts_at: "2026-06-27T12:30:00", ends_at: "2026-06-27T12:45:00", reason: null }],
    settings: { tournamentMinutes: 40 }
  });

  assert.equal(ruleById(report, "blocked-ref-assignments").issueCount, 1);
});

test("first/last division rule flags any division present in both edge rows", () => {
  const report = reportFor({
    games: [
      seedingGame(1, "A", "2026-06-23T09:00:00", 1),
      seedingGame(2, "B", "2026-06-23T09:00:00", 2),
      seedingGame(3, "C", "2026-06-23T10:00:00", 1),
      seedingGame(4, "A", "2026-06-23T11:00:00", 1)
    ]
  });

  const rule = ruleById(report, "first-last-division");
  assert.equal(rule.issueCount, 1);
  assert.deepEqual(rule.issues[0].details.repeatedDivisions, ["A"]);
});

test("first/last division rule ignores single-row days and non-seeding games", () => {
  const report = reportFor({
    games: [
      seedingGame(1, "A", "2026-06-23T09:00:00", 1),
      { ...seedingGame(2, "A", "2026-06-24T09:00:00", 1), phase: "tournament" },
      { ...seedingGame(3, "A", "2026-06-24T18:00:00", 1), phase: "unlimited" }
    ]
  });

  assert.equal(ruleById(report, "first-last-division").issueCount, 0);
});

test("cross-court rule flags a team playing on another court at the same time", () => {
  const report = reportFor({
    games: [
      { ...seedingGame(1, "A", "2026-06-23T09:00:00", 1), team_1_id: 101 },
      { ...seedingGame(2, "A", "2026-06-23T09:00:00", 2), team_2_id: 101 }
    ],
    teams: [{ id: 101, division: "A", center: "Texas", name: "Double Booked" }]
  });

  const rule = ruleById(report, "cross-court-buffer");
  assert.equal(rule.issueCount, 1);
  assert.equal(rule.issues[0].team, "A Texas Double Booked");
});

test("cross-court rule flags a team reffing while expected to play another court", () => {
  const report = reportFor({
    games: [
      { ...seedingGame(1, "A", "2026-06-23T09:00:00", 1), team_1_id: 101, ref_team_id: 201 },
      { ...seedingGame(2, "B", "2026-06-23T09:00:00", 2), team_1_id: 301, team_2_id: 302, ref_team_id: 101 }
    ],
    teams: [{ id: 101, division: "A", center: "Texas", name: "Play Ref Conflict" }]
  });

  const rule = ruleById(report, "cross-court-buffer");
  assert.equal(rule.issueCount, 1);
  assert.equal(rule.issues[0].details.leftRole, "play");
  assert.equal(rule.issues[0].details.rightRole, "ref");
});

test("cross-court rule flags a team assigned to ref two courts at the same time", () => {
  const report = reportFor({
    games: [
      { ...seedingGame(1, "A", "2026-06-23T09:00:00", 1), ref_team_id: 201 },
      { ...seedingGame(2, "A", "2026-06-23T09:00:00", 2), ref_team_id: 201 }
    ],
    teams: [{ id: 201, division: "B", center: "Texas", name: "Split Ref" }]
  });

  assert.equal(ruleById(report, "cross-court-buffer").issueCount, 1);
});

test("cross-court rule flags back-to-back assignments on different courts", () => {
  const report = reportFor({
    games: [
      { ...seedingGame(1, "A", "2026-06-23T09:00:00", 1), team_1_id: 101 },
      { ...seedingGame(2, "A", "2026-06-23T09:20:00", 2), team_2_id: 101 }
    ],
    teams: [{ id: 101, division: "A", center: "Texas", name: "No Buffer" }]
  });

  const rule = ruleById(report, "cross-court-buffer");
  assert.equal(rule.issueCount, 1);
  assert.equal(rule.issues[0].details.reason, "cross-court assignment without a one-game buffer");
});

test("cross-court rule allows back-to-back assignments on the same court", () => {
  const report = reportFor({
    games: [
      { ...seedingGame(1, "A", "2026-06-23T09:00:00", 1), team_1_id: 101 },
      { ...seedingGame(2, "A", "2026-06-23T09:20:00", 1), team_2_id: 101 }
    ],
    teams: [{ id: 101, division: "A", center: "Texas", name: "Same Court" }]
  });

  assert.equal(ruleById(report, "cross-court-buffer").issueCount, 0);
});

test("cross-court rule allows assignments on different courts after a full one-game buffer", () => {
  const report = reportFor({
    games: [
      { ...seedingGame(1, "A", "2026-06-23T09:00:00", 1), team_1_id: 101 },
      { ...seedingGame(2, "A", "2026-06-23T09:40:00", 2), team_2_id: 101 }
    ],
    teams: [{ id: 101, division: "A", center: "Texas", name: "Buffered" }]
  });

  assert.equal(ruleById(report, "cross-court-buffer").issueCount, 0);
});

function reportFor({ games, teams = [], availabilityBlocks = [], settings = { seedingMinutes: 20 } }) {
  return buildScheduleRulesReport({
    games,
    teams,
    availabilityBlocks,
    settings,
    generatedAt: "2026-06-20T00:00:00.000Z"
  });
}

function ruleById(report, id) {
  const rule = report.rules.find((candidate) => candidate.id === id);
  assert.ok(rule, `Expected rule ${id}`);
  return rule;
}

function seedingGame(id, division, startsAt, court) {
  return {
    id,
    phase: "seeding",
    division,
    court,
    starts_at: startsAt,
    team_1_id: id * 10 + 1,
    team_2_id: id * 10 + 2,
    ref_team_id: null,
    label: `${division} R1`
  };
}
