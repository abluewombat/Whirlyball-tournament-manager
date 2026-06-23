import { exec, query } from "./db";

export const googleSheetSyncKey = "google-sheet-sync";

export type SyncStatus = {
  sync_key: string;
  tournament_id: number | null;
  status: "success" | "failure";
  summary: string;
  detail_json: Record<string, unknown> | null;
  changed_count: number;
  synced_at: string;
  updated_at: string;
};

export async function readGoogleSheetSyncStatus(tournamentId: number) {
  const [status] = await query<SyncStatus>(
    `SELECT sync_key, tournament_id, status, summary, detail_json, changed_count, synced_at, updated_at
       FROM sync_status
      WHERE sync_key = $1
        AND tournament_id = $2`,
    [googleSheetSyncKey, tournamentId]
  );
  return status || null;
}

export async function recordGoogleSheetSyncStatus(input: {
  tournamentId: number;
  status: "success" | "failure";
  summary: string;
  detail?: Record<string, unknown>;
  changedCount?: number;
}) {
  await exec(
    `INSERT INTO sync_status (sync_key, tournament_id, status, summary, detail_json, changed_count, synced_at, updated_at)
     VALUES ($1, $2, $3, $4, $5::jsonb, $6, NOW(), NOW())
     ON CONFLICT (sync_key)
     DO UPDATE SET tournament_id = EXCLUDED.tournament_id,
                   status = EXCLUDED.status,
                   summary = EXCLUDED.summary,
                   detail_json = EXCLUDED.detail_json,
                   changed_count = EXCLUDED.changed_count,
                   synced_at = EXCLUDED.synced_at,
                   updated_at = NOW()`,
    [
      googleSheetSyncKey,
      input.tournamentId,
      input.status,
      input.summary,
      JSON.stringify(input.detail || null),
      input.changedCount || 0
    ]
  );
}
