import fs from "node:fs/promises";
import crypto from "node:crypto";
import xlsx from "xlsx";
import pg from "pg";

const workbookPath = "C:/Users/austm/Downloads/2026 Novi Nats Teams 2.xlsx";
const databaseUrl = process.env.SEED_DATABASE_URL || process.env.DATABASE_URL;
const previewOnly = process.argv.includes("--preview");

const CENTER_MAP = new Map([
  ["ATLANTA", "Atlanta"],
  ["CHICAGO", "Chicago"],
  ["CLEVELAND", "Cleveland"],
  ["CLEV", "Cleveland"],
  ["MICHIGAN", "Michigan"],
  ["MICH", "Michigan"],
  ["MINNESOTA", "Minnesota"],
  ["MINN", "Minnesota"],
  ["SEATTLE", "Seattle"],
  ["SEA", "Seattle"],
  ["TEXAS", "Texas"]
]);

const SHIRT_SIZES = new Set(["YS", "YM", "YL", "S", "M", "L", "XL", "XLT", "2XL", "2XLT", "3XL", "3XLT", "4XL", "4XLT"]);

function hashSecret(value) {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto.pbkdf2Sync(value, salt, 120000, 32, "sha256").toString("hex");
  return `${salt}:${hash}`;
}

function clean(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function normalizeCenter(value) {
  const text = clean(value);
  if (!text) return "";
  const upper = text.toUpperCase();
  return CENTER_MAP.get(upper) || text[0].toUpperCase() + text.slice(1).toLowerCase();
}

function parseTeamDescriptor(value, currentCenter) {
  const descriptor = clean(value);
  const [prefixRaw, ...nameParts] = descriptor.split(" - ");
  const prefix = clean(prefixRaw);
  const teamName = clean(nameParts.join(" - ")) || descriptor;
  const prefixParts = prefix.split(" ");
  const centerToken = prefixParts[0] || currentCenter;
  const divisionMatch = prefix.match(/\b(A|B|C|D|Unlimited)\d*\b/i);
  return {
    descriptor,
    name: teamName,
    center: normalizeCenter(centerToken || currentCenter),
    division: divisionMatch ? divisionMatch[1].toUpperCase() : ""
  };
}

function basePlayerName(value) {
  return clean(value).replace(/\s*\((extra\d*|extra)\)\s*$/i, "").trim();
}

function parseWorkbook() {
  const workbook = xlsx.readFile(workbookPath);
  const sheet = workbook.Sheets["2026 All player team info"];
  if (!sheet) throw new Error("Missing sheet: 2026 All player team info");
  const rows = xlsx.utils.sheet_to_json(sheet, { header: 1, defval: null });
  const teams = [];
  const extras = [];
  let currentCenter = "";
  let currentTeam = null;

  for (const row of rows) {
    const c0 = clean(row[0]);
    const c1 = clean(row[1]);
    const c2 = clean(row[2]);
    const c3 = clean(row[3]).toUpperCase();

    if (!c0 && !c1 && !c2 && !c3) continue;
    if (CENTER_MAP.has(c0.toUpperCase()) && !c1 && !c2) {
      currentCenter = normalizeCenter(c0);
      continue;
    }

    const looksLikeTeamRow = (c0 === "TEAM NAME" || c0 === "NAME") && c1 && !c2 && !c3;
    if (looksLikeTeamRow) {
      currentTeam = parseTeamDescriptor(c1, currentCenter);
      if (!currentTeam.center) currentTeam.center = currentCenter;
      teams.push({ ...currentTeam, players: [] });
      continue;
    }

    if (c0 === "NAME" || c0 === "TEAM NAME" || c0 === "2026 Novi Nationals - Team Info") continue;

    if (currentTeam && c0 && c2 && SHIRT_SIZES.has(c3)) {
      const team = teams[teams.length - 1];
      team.division ||= c2.toUpperCase();
      team.players.push({
        name: c0,
        center: normalizeCenter(c1) || team.center,
        division: c2.toUpperCase(),
        shirtSize: c3
      });
      continue;
    }

    if (c0 && SHIRT_SIZES.has(c3) && /\(extra/i.test(c0)) {
      extras.push({ playerName: basePlayerName(c0), size: c3, quantity: 1, note: c0 });
    }
  }

  return {
    teams: teams.filter((team) => team.players.length > 0).map((team) => ({
      ...team,
      division: team.division || team.players[0]?.division || "D"
    })),
    extras
  };
}

async function main() {
  const parsed = parseWorkbook();
  if (previewOnly) {
    const preview = {
      centers: [...new Set(parsed.teams.map((team) => team.center))],
      teams: parsed.teams.length,
      players: parsed.teams.reduce((sum, team) => sum + team.players.length, 0),
      extrasFound: parsed.extras.length,
      sampleTeams: parsed.teams.slice(0, 8).map((team) => ({
        center: team.center,
        division: team.division,
        name: team.name,
        players: team.players.map((player) => `${player.name} (${player.shirtSize})`)
      }))
    };
    console.log(JSON.stringify(preview, null, 2));
    return;
  }
  if (!databaseUrl) {
    throw new Error("Set SEED_DATABASE_URL or DATABASE_URL before running this script.");
  }
  const pool = new pg.Pool({
    connectionString: databaseUrl,
    ssl: databaseUrl.includes("localhost") || databaseUrl.includes("127.0.0.1") ? false : { rejectUnauthorized: false },
    max: 3
  });
  const client = await pool.connect();

  const report = {
    centers: new Set(parsed.teams.map((team) => team.center)).size,
    teams: parsed.teams.length,
    players: parsed.teams.reduce((sum, team) => sum + team.players.length, 0),
    extrasFound: parsed.extras.length,
    extrasInserted: 0,
    extrasSkipped: []
  };

  try {
    await client.query("BEGIN");
    await client.query("DELETE FROM games");
    await client.query("DELETE FROM shirt_orders");
    await client.query("DELETE FROM players");
    await client.query("DELETE FROM team_availability_blocks");
    await client.query("DELETE FROM teams");

    const centerIds = new Map();
    for (const center of [...new Set(parsed.teams.map((team) => team.center))]) {
      const result = await client.query(
        `INSERT INTO centers (name, passcode_hash)
         VALUES ($1, $2)
         ON CONFLICT (name) DO UPDATE SET name = EXCLUDED.name
         RETURNING id`,
        [center, hashSecret(center.toLowerCase())]
      );
      centerIds.set(center, result.rows[0].id);
    }

    const playersByBaseName = new Map();
    for (const team of parsed.teams) {
      const centerId = centerIds.get(team.center);
      const teamResult = await client.query(
        `INSERT INTO teams (center_id, division, name, early_available, deleted_at)
         VALUES ($1, $2, $3, FALSE, NULL)
         ON CONFLICT (center_id, division, name)
         DO UPDATE SET deleted_at = NULL, updated_at = NOW()
         RETURNING id`,
        [centerId, team.division, team.name]
      );
      const teamId = teamResult.rows[0].id;

      for (const player of team.players) {
        const playerResult = await client.query(
          `INSERT INTO players (team_id, name, shirt_size, notes)
           VALUES ($1, $2, $3, $4)
           RETURNING id`,
          [teamId, player.name, player.shirtSize, player.center !== team.center ? `Player center: ${player.center}` : null]
        );
        const key = basePlayerName(player.name).toLowerCase();
        if (!playersByBaseName.has(key)) playersByBaseName.set(key, []);
        playersByBaseName.get(key).push(playerResult.rows[0].id);
      }
    }

    for (const extra of parsed.extras) {
      const matches = playersByBaseName.get(extra.playerName.toLowerCase()) || [];
      if (matches.length === 1) {
        await client.query(
          `INSERT INTO shirt_orders (player_id, size, quantity, paid, amount, notes)
           VALUES ($1, $2, $3, FALSE, 0, $4)`,
          [matches[0], extra.size, extra.quantity, extra.note]
        );
        report.extrasInserted++;
      } else {
        report.extrasSkipped.push({ name: extra.playerName, size: extra.size, matches: matches.length });
      }
    }

    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
    await pool.end();
  }

  report.extrasSkipped = report.extrasSkipped.slice(0, 25);
  await fs.writeFile("seed-report.json", JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
}

await main();
