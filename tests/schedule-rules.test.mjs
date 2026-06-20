import test from "node:test";
import assert from "node:assert/strict";
import { buildScheduleRulesReport } from "../lib/schedule-rules.ts";

test("blocked assignment rule flags ref teams with overlapping blockers", () => {
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

  const rule = ruleById(report, "blocked-assignments");
  assert.equal(rule.issueCount, 1);
  assert.equal(rule.issues[0].team, "B Texas Refs");
});

test("blocked assignment rule flags playing teams with overlapping blockers", () => {
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
    teams: [{ id: 101, division: "A", center: "Texas", name: "Blocked Player" }],
    availabilityBlocks: [{ id: 1, team_id: 101, starts_at: "2026-06-23T09:50:00", ends_at: "2026-06-23T10:10:00", reason: "Travel" }]
  });

  const rule = ruleById(report, "blocked-assignments");
  assert.equal(rule.issueCount, 1);
  assert.equal(rule.issues[0].details.role, "play");
});

test("blocked assignment rule treats touching blocker boundaries as available", () => {
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

  assert.equal(ruleById(report, "blocked-assignments").issueCount, 0);
});

test("blocked assignment rule uses tournament duration for ref windows", () => {
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

  assert.equal(ruleById(report, "blocked-assignments").issueCount, 1);
});

test("blocked assignment rule blocks non-early teams before 7 PM Tuesday", () => {
  const report = reportFor({
    games: [{ ...seedingGame(1, "A", "2026-06-23T18:40:00", 1), team_1_id: 101 }],
    teams: [{ id: 101, division: "A", center: "Texas", name: "Late Arrival", early_available: false }],
    settings: { seedingMinutes: 20, startDate: "2026-06-23", endDate: "2026-06-28", includeTuesday: true }
  });

  const rule = ruleById(report, "blocked-assignments");
  assert.equal(rule.issueCount, 1);
  assert.equal(rule.issues[0].details.reason, "Default Tuesday arrival (19:00)");
});

test("blocked assignment rule allows early-available teams before 7 PM Tuesday", () => {
  const report = reportFor({
    games: [{ ...seedingGame(1, "A", "2026-06-23T18:40:00", 1), team_1_id: 101 }],
    teams: [{ id: 101, division: "A", center: "Texas", name: "Early Team", early_available: true }],
    settings: { seedingMinutes: 20, startDate: "2026-06-23", endDate: "2026-06-28", includeTuesday: true }
  });

  assert.equal(ruleById(report, "blocked-assignments").issueCount, 0);
});

test("first/last division rule flags edge repeats outside the soft split shape", () => {
  const report = reportFor({
    games: [
      seedingGame(1, "A", "2026-06-23T09:00:00", 1),
      seedingGame(2, "B", "2026-06-23T09:20:00", 1),
      seedingGame(3, "C", "2026-06-23T09:40:00", 1),
      seedingGame(4, "A", "2026-06-23T10:00:00", 1)
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

test("first/last division rule allows a soft split with one intervening division block", () => {
  const report = reportFor({
    games: [
      seedingGame(1, "A", "2026-06-23T09:00:00", 1),
      seedingGame(2, "B", "2026-06-23T09:20:00", 1),
      seedingGame(3, "A", "2026-06-23T09:40:00", 1)
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

test("buffer rule flags a team reffing while expected to play another court", () => {
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

test("buffer rule allows a team assigned to ref two courts at the same time", () => {
  const report = reportFor({
    games: [
      { ...seedingGame(1, "A", "2026-06-23T09:00:00", 1), ref_team_id: 201 },
      { ...seedingGame(2, "A", "2026-06-23T09:00:00", 2), ref_team_id: 201 }
    ],
    teams: [{ id: 201, division: "B", center: "Texas", name: "Split Ref" }]
  });

  assert.equal(ruleById(report, "cross-court-buffer").issueCount, 0);
});

test("buffer rule flags back-to-back play assignments on different courts", () => {
  const report = reportFor({
    games: [
      { ...seedingGame(1, "A", "2026-06-23T09:00:00", 1), team_1_id: 101 },
      { ...seedingGame(2, "A", "2026-06-23T09:20:00", 2), team_2_id: 101 }
    ],
    teams: [{ id: 101, division: "A", center: "Texas", name: "No Buffer" }]
  });

  const rule = ruleById(report, "cross-court-buffer");
  assert.equal(rule.issueCount, 1);
  assert.equal(rule.issues[0].details.reason, "cross-court play assignment without a one-game buffer");
});

test("buffer rule allows back-to-back play assignments on the same court", () => {
  const report = reportFor({
    games: [
      { ...seedingGame(1, "A", "2026-06-23T09:00:00", 1), team_1_id: 101 },
      { ...seedingGame(2, "A", "2026-06-23T09:20:00", 1), team_2_id: 101 }
    ],
    teams: [{ id: 101, division: "A", center: "Texas", name: "Same Court" }]
  });

  assert.equal(ruleById(report, "cross-court-buffer").issueCount, 0);
});

test("buffer rule allows play assignments on different courts after a full one-game buffer", () => {
  const report = reportFor({
    games: [
      { ...seedingGame(1, "A", "2026-06-23T09:00:00", 1), team_1_id: 101 },
      { ...seedingGame(2, "A", "2026-06-23T09:40:00", 2), team_2_id: 101 }
    ],
    teams: [{ id: 101, division: "A", center: "Texas", name: "Buffered" }]
  });

  assert.equal(ruleById(report, "cross-court-buffer").issueCount, 0);
});

test("buffer rule flags play before ref without a one-game buffer", () => {
  const report = reportFor({
    games: [
      { ...seedingGame(1, "A", "2026-06-23T09:00:00", 1), team_1_id: 101 },
      { ...seedingGame(2, "B", "2026-06-23T09:20:00", 1), team_1_id: 201, team_2_id: 202, ref_team_id: 101 }
    ],
    teams: [{ id: 101, division: "A", center: "Texas", name: "Play Then Ref" }]
  });

  const rule = ruleById(report, "cross-court-buffer");
  assert.equal(rule.issueCount, 1);
  assert.equal(rule.issues[0].details.reason, "play/ref assignment without a one-game buffer");
});

test("buffer rule flags ref before play without a one-game buffer", () => {
  const report = reportFor({
    games: [
      { ...seedingGame(1, "B", "2026-06-23T09:00:00", 1), team_1_id: 201, team_2_id: 202, ref_team_id: 101 },
      { ...seedingGame(2, "A", "2026-06-23T09:20:00", 1), team_1_id: 101 }
    ],
    teams: [{ id: 101, division: "A", center: "Texas", name: "Ref Then Play" }]
  });

  const rule = ruleById(report, "cross-court-buffer");
  assert.equal(rule.issueCount, 1);
  assert.equal(rule.issues[0].details.reason, "play/ref assignment without a one-game buffer");
});

test("buffer rule allows play and ref after a full one-game buffer", () => {
  const report = reportFor({
    games: [
      { ...seedingGame(1, "A", "2026-06-23T09:00:00", 1), team_1_id: 101 },
      { ...seedingGame(2, "B", "2026-06-23T09:40:00", 1), team_1_id: 201, team_2_id: 202, ref_team_id: 101 }
    ],
    teams: [{ id: 101, division: "A", center: "Texas", name: "Buffered Ref" }]
  });

  assert.equal(ruleById(report, "cross-court-buffer").issueCount, 0);
});

test("division block rule allows one contiguous daily division block below the minimum size", () => {
  const report = reportFor({
    games: [
      seedingGame(1, "A", "2026-06-24T09:00:00", 1),
      seedingGame(2, "A", "2026-06-24T09:20:00", 1),
      seedingGame(3, "B", "2026-06-24T09:40:00", 1)
    ]
  });

  assert.equal(ruleById(report, "division-daily-blocks").issueCount, 0);
});

test("division block rule warns when a large division stays in one daily block", () => {
  const report = reportFor({
    games: [
      seedingGame(1, "A", "2026-06-24T09:00:00", 1),
      seedingGame(2, "A", "2026-06-24T09:00:00", 2),
      seedingGame(3, "A", "2026-06-24T09:20:00", 1),
      seedingGame(4, "A", "2026-06-24T09:20:00", 2),
      seedingGame(5, "A", "2026-06-24T09:40:00", 1),
      seedingGame(6, "A", "2026-06-24T09:40:00", 2),
      seedingGame(7, "A", "2026-06-24T10:00:00", 1),
      seedingGame(8, "A", "2026-06-24T10:00:00", 2),
      seedingGame(9, "B", "2026-06-24T10:20:00", 1)
    ]
  });

  const rule = ruleById(report, "division-daily-blocks");
  assert.equal(rule.issueCount, 1);
  assert.equal(rule.issues[0].details.division, "A");
  assert.equal(rule.issues[0].details.gameCount, 8);
});

test("division block rule allows large divisions in two blocks with one intervening division block", () => {
  const report = reportFor({
    games: [
      seedingGame(1, "A", "2026-06-24T09:00:00", 1),
      seedingGame(2, "A", "2026-06-24T09:00:00", 2),
      seedingGame(3, "A", "2026-06-24T09:20:00", 1),
      seedingGame(4, "A", "2026-06-24T09:20:00", 2),
      seedingGame(5, "B", "2026-06-24T09:40:00", 1),
      seedingGame(6, "A", "2026-06-24T10:00:00", 1),
      seedingGame(7, "A", "2026-06-24T10:00:00", 2),
      seedingGame(8, "A", "2026-06-24T10:20:00", 1),
      seedingGame(9, "A", "2026-06-24T10:20:00", 2)
    ]
  });

  assert.equal(ruleById(report, "division-daily-blocks").issueCount, 0);
});

test("division block rule warns when a split creates a tiny division block", () => {
  const report = reportFor({
    games: [
      seedingGame(1, "A", "2026-06-24T09:00:00", 1),
      seedingGame(2, "A", "2026-06-24T09:00:00", 2),
      seedingGame(3, "A", "2026-06-24T09:20:00", 1),
      seedingGame(4, "A", "2026-06-24T09:20:00", 2),
      seedingGame(5, "B", "2026-06-24T09:40:00", 1),
      seedingGame(6, "A", "2026-06-24T10:00:00", 1)
    ]
  });

  const rule = ruleById(report, "division-daily-blocks");
  assert.equal(rule.issueCount, 1);
  assert.deepEqual(rule.issues[0].details.blockGameCounts, ["4", "1"]);
});

test("division block rule warns when a division split has more than one block between", () => {
  const report = reportFor({
    games: [
      seedingGame(1, "A", "2026-06-24T09:00:00", 1),
      seedingGame(2, "A", "2026-06-24T09:00:00", 2),
      seedingGame(3, "A", "2026-06-24T09:20:00", 1),
      seedingGame(4, "A", "2026-06-24T09:20:00", 2),
      seedingGame(5, "B", "2026-06-24T09:40:00", 1),
      seedingGame(6, "C", "2026-06-24T10:00:00", 1),
      seedingGame(7, "A", "2026-06-24T10:20:00", 1),
      seedingGame(8, "A", "2026-06-24T10:20:00", 2),
      seedingGame(9, "A", "2026-06-24T10:40:00", 1),
      seedingGame(10, "A", "2026-06-24T10:40:00", 2)
    ]
  });

  const rule = ruleById(report, "division-daily-blocks");
  assert.equal(rule.issueCount, 1);
  assert.equal(rule.issues[0].severity, "warning");
  assert.equal(rule.issues[0].details.division, "A");
});

test("division block rule warns when a division appears in three daily blocks", () => {
  const report = reportFor({
    games: [
      seedingGame(1, "A", "2026-06-24T09:00:00", 1),
      seedingGame(2, "A", "2026-06-24T09:20:00", 1),
      seedingGame(3, "B", "2026-06-24T09:40:00", 1),
      seedingGame(4, "A", "2026-06-24T10:00:00", 1),
      seedingGame(5, "C", "2026-06-24T10:20:00", 1),
      seedingGame(6, "A", "2026-06-24T10:40:00", 1)
    ]
  });

  const rule = ruleById(report, "division-daily-blocks");
  assert.equal(rule.issueCount, 1);
  assert.equal(rule.issues[0].details.division, "A");
});

test("rules ignore open schedule slots without teams", () => {
  const report = reportFor({
    games: [
      seedingGame(1, "A", "2026-06-24T09:00:00", 1),
      { ...seedingGame(2, "Open", "2026-06-24T09:20:00", 1), team_1_id: null, team_2_id: null, ref_team_id: null, label: "Open schedule slot" },
      seedingGame(3, "A", "2026-06-24T09:40:00", 1)
    ]
  });

  assert.equal(ruleById(report, "blocked-assignments").issueCount, 0);
  assert.equal(ruleById(report, "division-daily-blocks").issueCount, 0);
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
