import { Pool, type PoolClient, type QueryResultRow } from "pg";
import { hashSecret } from "./security";

const divisions = ["A", "B", "C", "D", "Unlimited"] as const;
const centers = ["Texas", "Cleveland", "Atlanta", "Chicago", "Seattle", "Michigan"];

export type Division = (typeof divisions)[number];
export const DIVISIONS = divisions;
export const SHIRT_SIZES = ["YS", "YM", "YL", "S", "M", "L", "XL", "XLT", "2XL", "2XLT", "3XL", "3XLT", "4XL", "4XLT"] as const;

let pool: Pool | null = null;
let initPromise: Promise<void> | null = null;
let isInitializing = false;

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
    isInitializing = true;
    try {
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
        next_winner_game_key TEXT,
        next_winner_slot INTEGER,
        next_loser_game_key TEXT,
        next_loser_slot INTEGER,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE (bracket_id, game_key)
      );

      CREATE TABLE IF NOT EXISTS state_snapshots (
        id SERIAL PRIMARY KEY,
        label TEXT NOT NULL,
        data_json JSONB NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE INDEX IF NOT EXISTS idx_team_availability_blocks_team_id
        ON team_availability_blocks(team_id);
    `);

      const count = await query<{ count: string }>("SELECT COUNT(*) as count FROM centers");
      if (Number(count[0]?.count || 0) === 0) {
        for (const center of centers) {
          await query("INSERT INTO centers (name, passcode_hash) VALUES ($1, $2) ON CONFLICT (name) DO NOTHING", [
            center,
            hashSecret(center.toLowerCase())
          ]);
        }
      }
      await query("INSERT INTO event_settings (id, scorekeeper_passcode_hash) VALUES (1, $1) ON CONFLICT (id) DO NOTHING", [
        hashSecret("scorekeeper")
      ]);
    } finally {
      isInitializing = false;
    }
  })();
  return initPromise;
}

export async function query<T extends QueryResultRow = QueryResultRow>(sql: string, params: unknown[] = []) {
  if (!isInitializing && !sql.includes("CREATE TABLE")) await initDb();
  const result = await getPool().query<T>(sql, params);
  return result.rows.map(normalizeRow) as T[];
}

export async function exec(sql: string, params: unknown[] = []) {
  if (!isInitializing && !sql.includes("CREATE TABLE")) await initDb();
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

export async function getFullState() {
  const tables = [
    "centers",
    "teams",
    "team_availability_blocks",
    "players",
    "shirt_orders",
    "schedule_settings",
    "games",
    "event_settings",
    "blocker_requests",
    "brackets",
    "bracket_games"
  ];
  const entries = await Promise.all(tables.map(async (table) => [table, await query(`SELECT * FROM ${table}`)] as const));
  return Object.fromEntries(entries);
}

export async function createSnapshot(label: string) {
  const data = await getFullState();
  return exec("INSERT INTO state_snapshots (label, data_json) VALUES ($1, $2::jsonb)", [label, JSON.stringify(data)]);
}

export async function restoreSnapshot(id: number) {
  const [snapshot] = await query<{ data_json: Record<string, Array<Record<string, unknown>>> }>(
    "SELECT data_json FROM state_snapshots WHERE id = $1",
    [id]
  );
  if (!snapshot) throw new Error("Snapshot not found");

  const data = snapshot.data_json;
  await withTransaction(async (client) => {
    for (const table of [
      "bracket_games",
      "brackets",
      "blocker_requests",
      "games",
      "shirt_orders",
      "players",
      "team_availability_blocks",
      "teams",
      "schedule_settings",
      "event_settings",
      "centers"
    ]) {
      await client.query(`DELETE FROM ${table}`);
    }
    for (const table of [
      "centers",
      "event_settings",
      "teams",
      "team_availability_blocks",
      "players",
      "shirt_orders",
      "schedule_settings",
      "games",
      "blocker_requests",
      "brackets",
      "bracket_games"
    ]) {
      for (const row of data[table] || []) {
        const keys = Object.keys(row);
        const cols = keys.join(", ");
        const placeholders = keys.map((_, index) => `$${index + 1}`).join(", ");
        await client.query(`INSERT INTO ${table} (${cols}) VALUES (${placeholders})`, keys.map((key) => row[key]));
      }
    }
  });
}
