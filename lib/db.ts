import { Pool, type PoolClient, type QueryResultRow } from "pg";
import { hashSecret } from "./security";

const divisions = ["A", "B", "C", "D", "Unlimited"] as const;
const centers = ["Texas", "Cleveland", "Atlanta", "Chicago", "Seattle", "Michigan"];

export type Division = (typeof divisions)[number];
export const DIVISIONS = divisions;
export const SHIRT_SIZES = ["YS", "YM", "YL", "S", "M", "L", "XL", "XLT", "2XL", "2XLT", "3XL", "3XLT", "4XL", "4XLT"] as const;
export type TournamentType = "nationals" | "draft";
export type TournamentStatus = "upcoming" | "active" | "past";

export type TournamentRow = {
  id: number;
  name: string;
  slug: string;
  tournament_type: TournamentType;
  status: TournamentStatus;
  location: string | null;
  timezone: string;
  starts_on: string;
  ends_on: string;
  registration_deadline: string | null;
  featured: boolean;
  editing_locked: boolean;
  draft_locked: boolean;
  created_at: string;
  updated_at: string;
};

export type TournamentDivisionRow = {
  id: number;
  tournament_id: number;
  name: string;
  display_order: number;
  is_exhibition: boolean;
  public_label_hidden: boolean;
};

let pool: Pool | null = null;
let initPromise: Promise<void> | null = null;

function getPool() {
  if (pool) return pool;
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error("DATABASE_URL is required. Create a free Postgres database on Neon, Supabase, or Railway and add its connection string.");
  }
  pool = new Pool({
    connectionString,
    ssl: connectionString.includes("localhost") || connectionString.includes("127.0.0.1") ? false : { rejectUnauthorized: false },
    max: 5
  });
  return pool;
}

export async function initDb() {
  if (initPromise) return initPromise;
  initPromise = (async () => {
    await getPool().query(`
      CREATE TABLE IF NOT EXISTS centers (
        id SERIAL PRIMARY KEY,
        name TEXT NOT NULL UNIQUE,
        passcode_hash TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS teams (
        id SERIAL PRIMARY KEY,
        center_id INTEGER NOT NULL REFERENCES centers(id),
        division TEXT NOT NULL,
        name TEXT NOT NULL,
        early_available BOOLEAN NOT NULL DEFAULT FALSE,
        deleted_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE(center_id, division, name)
      );

      CREATE TABLE IF NOT EXISTS team_availability_blocks (
        id SERIAL PRIMARY KEY,
        team_id INTEGER NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
        starts_at TIMESTAMPTZ NOT NULL,
        ends_at TIMESTAMPTZ NOT NULL,
        reason TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CHECK (ends_at > starts_at)
      );

      CREATE TABLE IF NOT EXISTS players (
        id SERIAL PRIMARY KEY,
        team_id INTEGER NOT NULL REFERENCES teams(id),
        name TEXT NOT NULL,
        shirt_size TEXT NOT NULL,
        entry_paid BOOLEAN NOT NULL DEFAULT FALSE,
        entry_amount NUMERIC NOT NULL DEFAULT 0,
        entry_paid_date DATE,
        entry_payment_method TEXT,
        notes TEXT,
        deleted_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS shirt_orders (
        id SERIAL PRIMARY KEY,
        player_id INTEGER NOT NULL REFERENCES players(id),
        size TEXT NOT NULL,
        quantity INTEGER NOT NULL DEFAULT 1,
        paid BOOLEAN NOT NULL DEFAULT FALSE,
        amount NUMERIC NOT NULL DEFAULT 0,
        paid_date DATE,
        payment_method TEXT,
        notes TEXT,
        deleted_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS schedule_settings (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        settings_json TEXT NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS games (
        id SERIAL PRIMARY KEY,
        phase TEXT NOT NULL,
        division TEXT NOT NULL,
        court INTEGER NOT NULL,
        starts_at TIMESTAMPTZ NOT NULL,
        team_1_id INTEGER,
        team_2_id INTEGER,
        ref_team_id INTEGER,
        label TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      ALTER TABLE games ADD COLUMN IF NOT EXISTS team_1_score INTEGER;
      ALTER TABLE games ADD COLUMN IF NOT EXISTS team_2_score INTEGER;
      ALTER TABLE games ADD COLUMN IF NOT EXISTS winner_team_id INTEGER;
      ALTER TABLE games ADD COLUMN IF NOT EXISTS loser_team_id INTEGER;
      ALTER TABLE games ADD COLUMN IF NOT EXISTS result_type TEXT;
      ALTER TABLE games ADD COLUMN IF NOT EXISTS forfeit_team_id INTEGER;
      ALTER TABLE games ADD COLUMN IF NOT EXISTS scored_by TEXT;
      ALTER TABLE games ADD COLUMN IF NOT EXISTS scored_at TIMESTAMPTZ;

      CREATE TABLE IF NOT EXISTS event_settings (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        scorekeeper_passcode_hash TEXT NOT NULL,
        announcement TEXT,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS blocker_requests (
        id SERIAL PRIMARY KEY,
        team_id INTEGER NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
        starts_at TIMESTAMPTZ NOT NULL,
        ends_at TIMESTAMPTZ NOT NULL,
        reason TEXT,
        status TEXT NOT NULL DEFAULT 'pending',
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        reviewed_at TIMESTAMPTZ,
        CHECK (ends_at > starts_at)
      );

      CREATE TABLE IF NOT EXISTS brackets (
        id SERIAL PRIMARY KEY,
        division TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'active',
        seed_snapshot_json JSONB NOT NULL,
        bracket_data_json JSONB,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      ALTER TABLE brackets ADD COLUMN IF NOT EXISTS bracket_data_json JSONB;
      ALTER TABLE brackets ADD COLUMN IF NOT EXISTS bracket_odds_json JSONB;

      CREATE TABLE IF NOT EXISTS bracket_games (
        id SERIAL PRIMARY KEY,
        bracket_id INTEGER NOT NULL REFERENCES brackets(id) ON DELETE CASCADE,
        game_key TEXT NOT NULL,
        bracket_side TEXT NOT NULL,
        round INTEGER NOT NULL,
        position INTEGER NOT NULL,
        team_1_id INTEGER REFERENCES teams(id),
        team_2_id INTEGER REFERENCES teams(id),
        team_1_score INTEGER,
        team_2_score INTEGER,
        winner_team_id INTEGER REFERENCES teams(id),
        loser_team_id INTEGER REFERENCES teams(id),
        result_type TEXT,
        forfeit_team_id INTEGER REFERENCES teams(id),
        next_winner_game_key TEXT,
        next_winner_slot INTEGER,
        next_loser_game_key TEXT,
        next_loser_slot INTEGER,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE (bracket_id, game_key)
      );

      ALTER TABLE bracket_games ADD COLUMN IF NOT EXISTS result_type TEXT;
      ALTER TABLE bracket_games ADD COLUMN IF NOT EXISTS forfeit_team_id INTEGER REFERENCES teams(id);

      CREATE TABLE IF NOT EXISTS state_snapshots (
        id SERIAL PRIMARY KEY,
        label TEXT NOT NULL,
        data_json JSONB NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE INDEX IF NOT EXISTS idx_team_availability_blocks_team_id
        ON team_availability_blocks(team_id);

      CREATE TABLE IF NOT EXISTS tournaments (
        id SERIAL PRIMARY KEY,
        name TEXT NOT NULL,
        slug TEXT NOT NULL UNIQUE,
        tournament_type TEXT NOT NULL CHECK (tournament_type IN ('nationals', 'draft')),
        status TEXT NOT NULL DEFAULT 'upcoming' CHECK (status IN ('upcoming', 'active', 'past')),
        location TEXT,
        timezone TEXT NOT NULL DEFAULT 'America/Detroit',
        starts_on DATE NOT NULL,
        ends_on DATE NOT NULL,
        registration_deadline TIMESTAMPTZ,
        featured BOOLEAN NOT NULL DEFAULT FALSE,
        editing_locked BOOLEAN NOT NULL DEFAULT FALSE,
        draft_locked BOOLEAN NOT NULL DEFAULT FALSE,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CHECK (ends_on >= starts_on)
      );

      CREATE TABLE IF NOT EXISTS tournament_divisions (
        id SERIAL PRIMARY KEY,
        tournament_id INTEGER NOT NULL REFERENCES tournaments(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        display_order INTEGER NOT NULL DEFAULT 0,
        is_exhibition BOOLEAN NOT NULL DEFAULT FALSE,
        public_label_hidden BOOLEAN NOT NULL DEFAULT FALSE,
        UNIQUE (tournament_id, name)
      );

      CREATE TABLE IF NOT EXISTS people (
        id SERIAL PRIMARY KEY,
        center_id INTEGER NOT NULL REFERENCES centers(id),
        name TEXT NOT NULL,
        normalized_name TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE (center_id, normalized_name)
      );

      CREATE TABLE IF NOT EXISTS tournament_settings (
        tournament_id INTEGER PRIMARY KEY REFERENCES tournaments(id) ON DELETE CASCADE,
        scorekeeper_passcode_hash TEXT NOT NULL,
        announcement TEXT,
        schedule_settings_json JSONB,
        schedule_rules_report_json JSONB,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      ALTER TABLE tournament_settings ADD COLUMN IF NOT EXISTS schedule_rules_report_json JSONB;

      CREATE TABLE IF NOT EXISTS sync_status (
        sync_key TEXT PRIMARY KEY,
        tournament_id INTEGER REFERENCES tournaments(id),
        status TEXT NOT NULL CHECK (status IN ('success', 'failure')),
        summary TEXT NOT NULL,
        detail_json JSONB,
        changed_count INTEGER NOT NULL DEFAULT 0,
        synced_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS court_streams (
        id SERIAL PRIMARY KEY,
        tournament_id INTEGER NOT NULL REFERENCES tournaments(id) ON DELETE CASCADE,
        court INTEGER NOT NULL CHECK (court > 0),
        stream_date DATE NOT NULL,
        youtube_url TEXT NOT NULL,
        youtube_video_id TEXT NOT NULL,
        stream_started_at TIMESTAMPTZ NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE (tournament_id, court, stream_date)
      );

      ALTER TABLE games ADD COLUMN IF NOT EXISTS stream_id INTEGER REFERENCES court_streams(id) ON DELETE SET NULL;
      ALTER TABLE games ADD COLUMN IF NOT EXISTS actual_started_at TIMESTAMPTZ;
      ALTER TABLE games ADD COLUMN IF NOT EXISTS actual_ended_at TIMESTAMPTZ;

      CREATE INDEX IF NOT EXISTS idx_court_streams_tournament_date
        ON court_streams(tournament_id, stream_date, court);
      CREATE INDEX IF NOT EXISTS idx_games_stream_id ON games(stream_id);

      CREATE TABLE IF NOT EXISTS registration_requests (
        id SERIAL PRIMARY KEY,
        tournament_id INTEGER NOT NULL REFERENCES tournaments(id) ON DELETE CASCADE,
        center_id INTEGER NOT NULL REFERENCES centers(id),
        request_type TEXT NOT NULL CHECK (request_type IN ('individual', 'team')),
        proposed_team_name TEXT,
        requested_team_id INTEGER REFERENCES teams(id),
        requested_division TEXT,
        status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
        submitted_by_name TEXT NOT NULL,
        notes TEXT,
        reviewed_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS registration_request_players (
        id SERIAL PRIMARY KEY,
        request_id INTEGER NOT NULL REFERENCES registration_requests(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        shirt_size TEXT,
        is_submitter BOOLEAN NOT NULL DEFAULT FALSE,
        UNIQUE (request_id, name)
      );

      CREATE TABLE IF NOT EXISTS schema_migrations (
        version TEXT PRIMARY KEY,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);

    await migrateTournamentSchema();
    await migrateNovi2026Location();

    const count = await getPool().query<{ count: string }>("SELECT COUNT(*) as count FROM centers");
    if (Number(count.rows[0]?.count || 0) === 0) {
      for (const center of centers) {
        await getPool().query("INSERT INTO centers (name, passcode_hash) VALUES ($1, $2) ON CONFLICT (name) DO NOTHING", [
          center,
          hashSecret(center.toLowerCase())
        ]);
      }
    }
    await getPool().query("INSERT INTO event_settings (id, scorekeeper_passcode_hash) VALUES (1, $1) ON CONFLICT (id) DO NOTHING", [
      hashSecret("scorekeeper")
    ]);
  })();
  return initPromise;
}

async function migrateTournamentSchema() {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const migrationVersion = "20260605_multi_tournament_v1";
    const applied = await client.query("SELECT 1 FROM schema_migrations WHERE version = $1", [migrationVersion]);
    if (applied.rowCount) {
      await client.query("COMMIT");
      return;
    }
    const tournamentResult = await client.query<{ id: number }>(
      `INSERT INTO tournaments (
         name, slug, tournament_type, status, location, timezone,
         starts_on, ends_on, registration_deadline, featured
       )
       VALUES (
         '2026 WhirlyBall Nationals', 'novi-2026', 'nationals', 'active',
         'Novi, Michigan', 'America/Detroit', '2026-06-23', '2026-06-28', '2026-06-23T00:00:00-04:00', TRUE
       )
       ON CONFLICT (slug) DO UPDATE SET slug = EXCLUDED.slug
       RETURNING id`
    );
    const tournamentId = tournamentResult.rows[0].id;

    for (const [index, division] of divisions.entries()) {
      await client.query(
        `INSERT INTO tournament_divisions (tournament_id, name, display_order, is_exhibition)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (tournament_id, name) DO NOTHING`,
        [tournamentId, division, index, division === "Unlimited"]
      );
    }

    await client.query("ALTER TABLE teams ADD COLUMN IF NOT EXISTS tournament_id INTEGER REFERENCES tournaments(id)");
    await client.query("UPDATE teams SET tournament_id = $1 WHERE tournament_id IS NULL", [tournamentId]);
    await client.query("ALTER TABLE teams ALTER COLUMN tournament_id SET NOT NULL");
    await client.query("ALTER TABLE teams ALTER COLUMN center_id DROP NOT NULL");
    await client.query("ALTER TABLE teams DROP CONSTRAINT IF EXISTS teams_center_id_division_name_key");
    await client.query("CREATE INDEX IF NOT EXISTS idx_teams_tournament_id ON teams(tournament_id)");
    await client.query(
      "CREATE UNIQUE INDEX IF NOT EXISTS idx_teams_tournament_center_division_name ON teams(tournament_id, center_id, division, name)"
    );
    await client.query("CREATE UNIQUE INDEX IF NOT EXISTS idx_one_active_tournament ON tournaments(status) WHERE status = 'active'");

    await client.query("ALTER TABLE players ADD COLUMN IF NOT EXISTS tournament_id INTEGER REFERENCES tournaments(id)");
    await client.query("ALTER TABLE players ADD COLUMN IF NOT EXISTS person_id INTEGER REFERENCES people(id)");
    await client.query("ALTER TABLE players ADD COLUMN IF NOT EXISTS registration_status TEXT NOT NULL DEFAULT 'approved'");
    await client.query("ALTER TABLE players ADD COLUMN IF NOT EXISTS assigned_level TEXT");
    await client.query("ALTER TABLE players ALTER COLUMN team_id DROP NOT NULL");
    await client.query(
      `INSERT INTO people (center_id, name, normalized_name)
       SELECT DISTINCT
              COALESCE(
                (SELECT id FROM centers WHERE LOWER(players.notes) = LOWER('Player center: ' || centers.name) LIMIT 1),
                teams.center_id
              ),
              players.name,
              LOWER(REGEXP_REPLACE(TRIM(players.name), '\\s+', ' ', 'g'))
       FROM players
       JOIN teams ON teams.id = players.team_id
       WHERE teams.center_id IS NOT NULL
       ON CONFLICT (center_id, normalized_name) DO NOTHING`
    );
    await client.query(
      `UPDATE players
       SET tournament_id = teams.tournament_id,
           person_id = people.id
       FROM teams, people
       WHERE players.team_id = teams.id
         AND people.center_id = COALESCE(
           (SELECT id FROM centers WHERE LOWER(players.notes) = LOWER('Player center: ' || centers.name) LIMIT 1),
           teams.center_id
         )
         AND people.normalized_name = LOWER(REGEXP_REPLACE(TRIM(players.name), '\\s+', ' ', 'g'))
         AND (players.tournament_id IS NULL OR players.person_id IS NULL)`
    );
    await client.query("UPDATE players SET tournament_id = $1 WHERE tournament_id IS NULL", [tournamentId]);
    await client.query("ALTER TABLE players ALTER COLUMN tournament_id SET NOT NULL");
    await client.query("CREATE INDEX IF NOT EXISTS idx_players_tournament_id ON players(tournament_id)");
    await client.query("CREATE INDEX IF NOT EXISTS idx_players_person_id ON players(person_id)");

    for (const table of ["games", "brackets", "blocker_requests", "state_snapshots"]) {
      await client.query(`ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS tournament_id INTEGER REFERENCES tournaments(id)`);
      await client.query(`UPDATE ${table} SET tournament_id = $1 WHERE tournament_id IS NULL`, [tournamentId]);
      await client.query(`ALTER TABLE ${table} ALTER COLUMN tournament_id SET NOT NULL`);
      await client.query(`CREATE INDEX IF NOT EXISTS idx_${table}_tournament_id ON ${table}(tournament_id)`);
    }

    const settings = await client.query<{ scorekeeper_passcode_hash: string; announcement: string | null }>(
      "SELECT scorekeeper_passcode_hash, announcement FROM event_settings WHERE id = 1"
    );
    await client.query(
      `INSERT INTO tournament_settings (tournament_id, scorekeeper_passcode_hash, announcement)
       VALUES ($1, $2, $3)
       ON CONFLICT (tournament_id) DO NOTHING`,
      [tournamentId, settings.rows[0]?.scorekeeper_passcode_hash || hashSecret("scorekeeper"), settings.rows[0]?.announcement || null]
    );
    await migrateLegacySnapshots(client, tournamentId);
    await client.query("INSERT INTO schema_migrations (version) VALUES ($1)", [migrationVersion]);

    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function migrateNovi2026Location() {
  const migrationVersion = "20260606_novi_2026_location";
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const applied = await client.query("SELECT 1 FROM schema_migrations WHERE version = $1", [migrationVersion]);
    if (!applied.rowCount) {
      await client.query(
        `UPDATE tournaments
         SET slug = 'novi-2026',
             location = 'Novi, Michigan',
             timezone = 'America/Detroit',
             registration_deadline = '2026-06-23T00:00:00-04:00',
             updated_at = NOW()
         WHERE name = '2026 WhirlyBall Nationals'
           AND slug = 'chicago-2026'`
      );
      await client.query("INSERT INTO schema_migrations (version) VALUES ($1)", [migrationVersion]);
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function migrateLegacySnapshots(client: PoolClient, tournamentId: number) {
  const snapshots = await client.query<{ id: number; data_json: Record<string, Array<Record<string, unknown>>> }>(
    "SELECT id, data_json FROM state_snapshots WHERE tournament_id = $1",
    [tournamentId]
  );
  const divisionsResult = await client.query("SELECT * FROM tournament_divisions WHERE tournament_id = $1 ORDER BY display_order, id", [
    tournamentId
  ]);

  for (const snapshot of snapshots.rows) {
    const data = snapshot.data_json;
    if (Array.isArray(data.tournament_divisions)) continue;
    const teams: Array<Record<string, unknown>> = (data.teams || []).map((row) => ({ ...row, tournament_id: tournamentId }));
    const teamById = new Map(teams.map((team) => [Number(team["id"]), team]));
    const people = new Map<number, Record<string, unknown>>();
    const players: Array<Record<string, unknown>> = [];

    for (const row of data.players || []) {
      const team = teamById.get(Number(row.team_id));
      let centerId = Number(team?.["center_id"]);
      const name = String(row.name || "").trim();
      const centerNote = String(row.notes || "").match(/^Player center:\s*(.+)$/i);
      if (centerNote) {
        const centerResult = await client.query<{ id: number }>("SELECT id FROM centers WHERE LOWER(name) = LOWER($1)", [centerNote[1].trim()]);
        centerId = centerResult.rows[0]?.id || centerId;
      }
      let personId: number | null = null;
      if (centerId && name) {
        const personResult = await client.query<{ id: number }>(
          `INSERT INTO people (center_id, name, normalized_name)
           VALUES ($1, $2, $3)
           ON CONFLICT (center_id, normalized_name)
           DO UPDATE SET name = EXCLUDED.name
           RETURNING id`,
          [centerId, name, name.replace(/\s+/g, " ").toLowerCase()]
        );
        personId = personResult.rows[0].id;
        const personRow = await client.query<Record<string, unknown>>("SELECT * FROM people WHERE id = $1", [personId]);
        people.set(personId, personRow.rows[0]);
      }
      players.push({
        ...row,
        tournament_id: tournamentId,
        person_id: personId,
        registration_status: "approved",
        assigned_level: null
      });
    }

    const eventSettings = data.event_settings?.[0];
    const converted = {
      people: [...people.values()],
      tournament_divisions: divisionsResult.rows,
      tournament_settings: eventSettings
        ? [
            {
              tournament_id: tournamentId,
              scorekeeper_passcode_hash: eventSettings.scorekeeper_passcode_hash,
              announcement: eventSettings.announcement || null,
              schedule_settings_json: data.schedule_settings?.[0]?.settings_json || null,
              updated_at: eventSettings.updated_at
            }
          ]
        : [],
      teams,
      team_availability_blocks: data.team_availability_blocks || [],
      players,
      shirt_orders: data.shirt_orders || [],
      games: (data.games || []).map((row) => ({ ...row, tournament_id: tournamentId })),
      blocker_requests: (data.blocker_requests || []).map((row) => ({ ...row, tournament_id: tournamentId })),
      brackets: (data.brackets || []).map((row) => ({ ...row, tournament_id: tournamentId })),
      bracket_games: data.bracket_games || []
    };
    await client.query("UPDATE state_snapshots SET data_json = $1::jsonb WHERE id = $2", [JSON.stringify(converted), snapshot.id]);
  }
}

export async function query<T extends QueryResultRow = QueryResultRow>(sql: string, params: unknown[] = []) {
  await initDb();
  const result = await getPool().query<T>(sql, params);
  return result.rows.map(normalizeRow) as T[];
}

export async function exec(sql: string, params: unknown[] = []) {
  await initDb();
  return getPool().query(sql, params);
}

export async function withTransaction<T>(callback: (client: PoolClient) => Promise<T>) {
  await initDb();
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const result = await callback(client as never);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function listCenters() {
  return query<{ id: number; name: string }>("SELECT id, name FROM centers ORDER BY name");
}

export async function listTournaments() {
  return query<TournamentRow>(
    `SELECT *
     FROM tournaments
     ORDER BY
       CASE status WHEN 'active' THEN 0 WHEN 'upcoming' THEN 1 ELSE 2 END,
       starts_on DESC,
       id DESC`
  );
}

export async function getTournamentById(id: number) {
  const [tournament] = await query<TournamentRow>("SELECT * FROM tournaments WHERE id = $1", [id]);
  return tournament || null;
}

export async function getTournamentBySlug(slug: string) {
  const [tournament] = await query<TournamentRow>("SELECT * FROM tournaments WHERE slug = $1", [slug]);
  return tournament || null;
}

export async function getFeaturedTournament() {
  const [tournament] = await query<TournamentRow>(
    `SELECT *
     FROM tournaments
     ORDER BY
       CASE WHEN status = 'active' THEN 0 WHEN status = 'upcoming' THEN 1 ELSE 2 END,
       featured DESC,
       CASE WHEN status = 'past' THEN starts_on END DESC,
       CASE WHEN status <> 'past' THEN starts_on END ASC,
       id DESC
     LIMIT 1`
  );
  return tournament || null;
}

export async function listTournamentDivisions(tournamentId: number) {
  return query<TournamentDivisionRow>(
    "SELECT * FROM tournament_divisions WHERE tournament_id = $1 ORDER BY display_order, id",
    [tournamentId]
  );
}

function normalizeValue(value: unknown): unknown {
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(normalizeValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, nested]) => [key, normalizeValue(nested)]));
  }
  return value;
}

function normalizeRow<T extends QueryResultRow>(row: T): T {
  return Object.fromEntries(Object.entries(row).map(([key, value]) => [key, normalizeValue(value)])) as T;
}

export async function getFullState(tournamentId: number) {
  const [
    teams,
    availabilityBlocks,
    players,
    shirtOrders,
    games,
    blockerRequests,
    brackets,
    bracketGames,
    settings,
    tournamentDivisions,
    people,
    courtStreams
  ] = await Promise.all([
    query("SELECT * FROM teams WHERE tournament_id = $1", [tournamentId]),
    query("SELECT team_availability_blocks.* FROM team_availability_blocks JOIN teams ON teams.id = team_availability_blocks.team_id WHERE teams.tournament_id = $1", [tournamentId]),
    query("SELECT * FROM players WHERE tournament_id = $1", [tournamentId]),
    query("SELECT shirt_orders.* FROM shirt_orders JOIN players ON players.id = shirt_orders.player_id WHERE players.tournament_id = $1", [tournamentId]),
    query("SELECT * FROM games WHERE tournament_id = $1", [tournamentId]),
    query("SELECT * FROM blocker_requests WHERE tournament_id = $1", [tournamentId]),
    query("SELECT * FROM brackets WHERE tournament_id = $1", [tournamentId]),
    query("SELECT bracket_games.* FROM bracket_games JOIN brackets ON brackets.id = bracket_games.bracket_id WHERE brackets.tournament_id = $1", [tournamentId]),
    query("SELECT * FROM tournament_settings WHERE tournament_id = $1", [tournamentId]),
    query("SELECT * FROM tournament_divisions WHERE tournament_id = $1", [tournamentId]),
    query("SELECT DISTINCT people.* FROM people JOIN players ON players.person_id = people.id WHERE players.tournament_id = $1", [tournamentId]),
    query("SELECT * FROM court_streams WHERE tournament_id = $1", [tournamentId])
  ]);
  return {
    people,
    tournament_divisions: tournamentDivisions,
    tournament_settings: settings,
    court_streams: courtStreams,
    teams,
    team_availability_blocks: availabilityBlocks,
    players,
    shirt_orders: shirtOrders,
    games,
    blocker_requests: blockerRequests,
    brackets,
    bracket_games: bracketGames
  };
}

export async function createSnapshot(tournamentId: number, label: string) {
  const data = await getFullState(tournamentId);
  return exec("INSERT INTO state_snapshots (tournament_id, label, data_json) VALUES ($1, $2, $3::jsonb) RETURNING id", [
    tournamentId,
    label,
    JSON.stringify(data)
  ]);
}

export async function restoreSnapshot(tournamentId: number, id: number) {
  const [snapshot] = await query<{ data_json: Record<string, Array<Record<string, unknown>>> }>(
    "SELECT data_json FROM state_snapshots WHERE id = $1 AND tournament_id = $2",
    [id, tournamentId]
  );
  if (!snapshot) throw new Error("Snapshot not found");

  const data = snapshot.data_json;
  await withTransaction(async (client) => {
    const personIdMap = new Map<number, number>();
    for (const row of data.people || []) {
      const snapshotPersonId = Number(row.id);
      const centerId = Number(row.center_id);
      const normalizedName = String(row.normalized_name || "");
      const name = String(row.name || "");
      if (!snapshotPersonId || !centerId || !normalizedName) continue;

      const existingByIdentity = await client.query<{ id: number }>(
        "SELECT id FROM people WHERE center_id = $1 AND normalized_name = $2",
        [centerId, normalizedName]
      );
      if (existingByIdentity.rows[0]) {
        personIdMap.set(snapshotPersonId, existingByIdentity.rows[0].id);
        await client.query("UPDATE people SET name = $1, updated_at = NOW() WHERE id = $2", [name, existingByIdentity.rows[0].id]);
        continue;
      }

      const keys = Object.keys(row);
      await client.query(
        `INSERT INTO people (${keys.join(", ")}) VALUES (${keys.map((_, index) => `$${index + 1}`).join(", ")})
         ON CONFLICT (id) DO UPDATE SET
           center_id = EXCLUDED.center_id,
           name = EXCLUDED.name,
           normalized_name = EXCLUDED.normalized_name,
           updated_at = NOW()`,
        keys.map((key) => row[key])
      );
      personIdMap.set(snapshotPersonId, snapshotPersonId);
    }

    await client.query("DELETE FROM bracket_games WHERE bracket_id IN (SELECT id FROM brackets WHERE tournament_id = $1)", [tournamentId]);
    await client.query("DELETE FROM brackets WHERE tournament_id = $1", [tournamentId]);
    await client.query("DELETE FROM blocker_requests WHERE tournament_id = $1", [tournamentId]);
    await client.query("DELETE FROM games WHERE tournament_id = $1", [tournamentId]);
    await client.query("DELETE FROM court_streams WHERE tournament_id = $1", [tournamentId]);
    await client.query("DELETE FROM registration_request_players WHERE request_id IN (SELECT id FROM registration_requests WHERE tournament_id = $1)", [tournamentId]);
    await client.query("DELETE FROM registration_requests WHERE tournament_id = $1", [tournamentId]);
    await client.query("DELETE FROM shirt_orders WHERE player_id IN (SELECT id FROM players WHERE tournament_id = $1)", [tournamentId]);
    await client.query("DELETE FROM players WHERE tournament_id = $1", [tournamentId]);
    await client.query("DELETE FROM team_availability_blocks WHERE team_id IN (SELECT id FROM teams WHERE tournament_id = $1)", [tournamentId]);
    await client.query("DELETE FROM teams WHERE tournament_id = $1", [tournamentId]);
    await client.query("DELETE FROM tournament_settings WHERE tournament_id = $1", [tournamentId]);
    await client.query("DELETE FROM tournament_divisions WHERE tournament_id = $1", [tournamentId]);

    for (const table of [
      "tournament_divisions",
      "tournament_settings",
      "court_streams",
      "teams",
      "team_availability_blocks",
      "players",
      "shirt_orders",
      "games",
      "blocker_requests",
      "brackets",
      "bracket_games"
    ]) {
      for (const row of data[table] || []) {
        let restoredRow = row;
        if (table === "players" && row.person_id !== null && row.person_id !== undefined) {
          restoredRow = {
            ...row,
            person_id: personIdMap.get(Number(row.person_id)) || row.person_id
          };
        }
        const keys = Object.keys(restoredRow);
        const cols = keys.join(", ");
        const placeholders = keys.map((_, index) => `$${index + 1}`).join(", ");
        await client.query(`INSERT INTO ${table} (${cols}) VALUES (${placeholders})`, keys.map((key) => restoredRow[key]));
      }
    }
  });
}
