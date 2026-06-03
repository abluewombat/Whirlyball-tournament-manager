import pg from "pg";

const { Pool } = pg;
const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required");

const pool = new Pool({
  connectionString: databaseUrl,
  ssl: databaseUrl.includes("localhost") || databaseUrl.includes("127.0.0.1") ? false : { rejectUnauthorized: false }
});

const rows = (
  await pool.query(`
    SELECT games.id, games.phase, games.division, games.court, games.starts_at,
           games.team_1_id, games.team_2_id, games.ref_team_id, games.label,
           t1.name as team_1, t2.name as team_2, tr.name as ref_team,
           c1.name as team_1_center, c2.name as team_2_center, cr.name as ref_center
    FROM games
    LEFT JOIN teams t1 ON t1.id = games.team_1_id
    LEFT JOIN teams t2 ON t2.id = games.team_2_id
    LEFT JOIN teams tr ON tr.id = games.ref_team_id
    LEFT JOIN centers c1 ON c1.id = t1.center_id
    LEFT JOIN centers c2 ON c2.id = t2.center_id
    LEFT JOIN centers cr ON cr.id = tr.center_id
    ORDER BY games.starts_at, games.court
  `)
).rows;

const teams = (
  await pool.query(`
    SELECT teams.id, teams.name, teams.division, centers.name as center
    FROM teams JOIN centers ON centers.id = teams.center_id
    WHERE teams.deleted_at IS NULL
  `)
).rows;

await pool.end();

const teamById = new Map(teams.map((team) => [team.id, team]));
const assignments = new Map();
for (const team of teams) assignments.set(team.id, []);

for (const game of rows) {
  const startsAt = normalizeDateTime(game.starts_at);
  for (const teamId of [game.team_1_id, game.team_2_id]) {
    if (!teamId || !assignments.has(teamId)) continue;
    assignments.get(teamId).push({
      role: "play",
      startsAt,
      court: game.court,
      phase: game.phase,
      division: game.division,
      label: game.team_1 && game.team_2 ? `${game.team_1} vs ${game.team_2}` : `${game.division}: ${game.label || "Game"}`
    });
  }
  if (game.ref_team_id && assignments.has(game.ref_team_id)) {
    assignments.get(game.ref_team_id).push({
      role: "ref",
      startsAt,
      court: game.court,
      phase: game.phase,
      division: game.division,
      label: game.team_1 && game.team_2 ? `${game.team_1} vs ${game.team_2}` : `${game.division}: ${game.label || "Game"}`
    });
  }
}

const issues = [];
for (const [teamId, items] of assignments.entries()) {
  const team = teamById.get(teamId);
  if (!team) continue;
  const byDay = new Map();
  for (const item of items.sort((a, b) => a.startsAt.localeCompare(b.startsAt) || a.court - b.court)) {
    const day = item.startsAt.slice(0, 10);
    byDay.set(day, [...(byDay.get(day) || []), item]);
  }
  for (const [day, dayItems] of byDay.entries()) {
    const plays = dayItems.filter((item) => item.role === "play");
    const refs = dayItems.filter((item) => item.role === "ref");
    const span = minutesBetween(dayItems[0].startsAt, dayItems[dayItems.length - 1].startsAt);
    const refSpan = refs.length > 1 ? minutesBetween(refs[0].startsAt, refs[refs.length - 1].startsAt) : 0;
    const playSpan = plays.length > 1 ? minutesBetween(plays[0].startsAt, plays[plays.length - 1].startsAt) : 0;
    const maxRun = longestRun(dayItems.map((item) => item.role));
    const longIdleGaps = [];
    for (let index = 1; index < dayItems.length; index += 1) {
      const gap = minutesBetween(dayItems[index - 1].startsAt, dayItems[index].startsAt);
      if (gap >= 180) longIdleGaps.push({ gap, from: dayItems[index - 1], to: dayItems[index] });
    }
    if (refs.length && !plays.length && refSpan >= 180) {
      issues.push(issue(95, team, day, `Ref-only day is spread ${fmt(refSpan)} from first to last ref`, dayItems));
    }
    if (refs.length && plays.length && span >= 480 && (refs[0].startsAt < plays[0].startsAt || refs[refs.length - 1].startsAt > plays[plays.length - 1].startsAt)) {
      issues.push(issue(78, team, day, `Refs extend the day to ${fmt(span)} around play window (${fmt(playSpan)} play span)`, dayItems));
    }
    for (const gap of longIdleGaps) {
      issues.push(issue(70, team, day, `Long idle gap of ${fmt(gap.gap)} between ${gap.from.role} and ${gap.to.role}`, dayItems));
    }
    if (maxRun.role === "play" && maxRun.count >= 3) {
      issues.push(issue(65, team, day, `Plays ${maxRun.count} games in a row`, dayItems));
    }
    if (maxRun.role === "ref" && maxRun.count >= 2) {
      issues.push(issue(50, team, day, `Refs ${maxRun.count} games in a row`, dayItems));
    }
    if (dayItems.length >= 4) {
      const roles = dayItems.map((item) => item.role).join("-");
      if (/^ref-ref-play-play/.test(roles) || /^play-play-ref-ref/.test(roles)) {
        issues.push(issue(45, team, day, `Chunked assignment order: ${roles}`, dayItems));
      }
    }
  }
}

issues.sort((left, right) => right.severity - left.severity || left.team.localeCompare(right.team));
console.log(JSON.stringify({ count: issues.length, issues: issues.slice(0, 80) }, null, 2));

function issue(severity, team, day, message, items) {
  return {
    severity,
    team: `${team.division} ${team.center} ${team.name}`,
    day,
    message,
    assignments: items.map((item) => `${item.startsAt.slice(11, 16)} ${item.role.toUpperCase()} C${item.court} ${item.division}: ${item.label}`)
  };
}

function minutesBetween(left, right) {
  return (Date.parse(right) - Date.parse(left)) / 60000;
}

function normalizeDateTime(value) {
  if (value instanceof Date) return value.toISOString().slice(0, 19);
  const date = new Date(value);
  if (!Number.isNaN(date.getTime())) return date.toISOString().slice(0, 19);
  return String(value).slice(0, 19);
}

function fmt(minutes) {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m ? `${h}h ${m}m` : `${h}h`;
}

function longestRun(values) {
  let best = { role: "", count: 0 };
  let current = { role: "", count: 0 };
  for (const value of values) {
    if (value === current.role) current.count += 1;
    else current = { role: value, count: 1 };
    if (current.count > best.count) best = { ...current };
  }
  return best;
}
