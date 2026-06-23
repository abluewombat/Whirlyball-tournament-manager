# Whirlyball Manager

Lightweight tournament logistics app for team registration, roster management, shirts, payments, admin exports, snapshots, and draft schedule generation.

## Run Locally

This app now uses Postgres. The easiest local database is Docker:

```bash
docker compose up -d
copy .env.example .env.local
npm install
npm run dev
```

For local Docker Postgres, set this in `.env.local`:

```bash
DATABASE_URL=postgresql://whirlyball:whirlyball@localhost:55432/whirlyball
ADMIN_PASSWORD=admin
APP_SECRET=local-dev-secret-change-me
YOUTUBE_API_KEY=optional-youtube-data-api-v3-key
CRON_SECRET=change-this-long-random-string
GOOGLE_SERVICE_ACCOUNT_JSON={"type":"service_account","project_id":"..."}
GOOGLE_SCORES_SPREADSHEET_ID=1Ja6ff8IbAWm3_eGWCWlRhWoKRyQELQxA
GOOGLE_SCORES_SHEET_NAME=2026 Schedule Final wcolor no R
GOOGLE_SCORES_RANGE=A1:Q1000
GOOGLE_SCORES_TOURNAMENT=novi-2026
GOOGLE_SCHEDULE_SYNC_ENABLED=true
GOOGLE_SCHEDULE_SYNC_SHEET_NAME=2026 Schedule Final wcolor no R
GOOGLE_SCHEDULE_SYNC_RANGE=A1:Q1000
```

Open http://localhost:3000.

## Default Access

- Admin page: `/admin`
- Center page: `/center`
- Default center passcodes are the lowercase center names, such as `texas`, `chicago`, and `cleveland`.
- Set `ADMIN_PASSWORD` and `APP_SECRET` before using this with real data.

## Free Deployment Recommendation

The smoothest free setup is:

1. Create a free Postgres database on Neon.
2. Deploy this repo to Vercel.
3. Add these Vercel environment variables:

```bash
DATABASE_URL=your-neon-pooled-connection-string
ADMIN_PASSWORD=your-real-admin-password
APP_SECRET=a-long-random-string
YOUTUBE_API_KEY=optional-youtube-data-api-v3-key
```

Neon is a good fit because it has a free Postgres tier and gives you a pooled connection string that works well with serverless hosting. Supabase Postgres also works. Railway works too, but may not stay free depending on current account credits and usage.

## Deploy To Vercel

1. Push this folder to GitHub.
2. Go to Vercel and import the GitHub repo.
3. In the Vercel project settings, add the environment variables from above.
4. Deploy.

The database tables and default centers are created automatically on first request.

## Main Features

- Public team list grouped by division.
- Public pages hide payment and shirt-size details.
- Center passcode dashboard for adding, editing, and soft-deleting that center's teams.
- Teams are unique by center + division + team name.
- Five-player roster limit per team.
- Team-specific time blockers for travel/work constraints that the schedule generator respects.
- Player shirt size and extra player-tied shirt orders.
- Entry payment tracking with paid checkbox, amount, date, and method.
- Admin dashboard for all centers, teams, passcodes, snapshots, and Excel export.
- Admin state snapshots with restore.
- Draft seeding and double-elimination placeholder schedule generator.
- Schedule generator can use full round robin or balanced target games per team when full round robin exceeds available court time.
- Tournament generation has separate tournament-day and final-day end times so Sunday can stop earlier than seeding nights.
- Tournament divisions can be assigned automatically by bracket size so the largest brackets are split across tournament days.
- Excel export includes teams, players, extra shirts, and schedule.

## Google Score Sync

Call `/api/cron/sync-google-scores` from Vercel Cron every minute for testing. The route reads the configured Google Sheet, syncs game/ref rows by default, then imports rows with both score cells filled through the same scoring rules used by the score entry workflow.

Share the source Google Sheet with the service account email, then set `GOOGLE_SERVICE_ACCOUNT_JSON` to the full JSON key in Vercel. `CRON_SECRET` protects the cron endpoint; manual test calls can also use `x-admin-password`. Set `GOOGLE_SCHEDULE_SYNC_ENABLED=false` or add `?scheduleSync=0` to skip the game/ref sync pass while still importing scores.

## Admin Schedule Import

Use the permanent admin importer when a PDF/CSV/JSON schedule needs to replace or update the saved game rows.

```bash
npm run admin:import-schedule -- --input schedule.json
npm run admin:import-schedule -- --input schedule.json --apply
```

The command is a dry run unless `--apply` is passed. On apply it creates a state snapshot, upserts `games`, optionally deletes missing seeding rows, and refreshes the saved schedule rules report.

Direct PDF import requires Poppler's `pdftotext`:

```bash
brew install poppler
npm run admin:import-schedule -- --pdf "2026 Novi Nats Teams 2.pdf" --out-json parsed-schedule.json
npm run admin:import-schedule -- --input parsed-schedule.json --apply --delete-missing
```

Accepted JSON shape:

```json
{
  "games": [
    {
      "starts_at": "2026-06-23T19:00:00-04:00",
      "court": 1,
      "division": "A",
      "team_1_code": "MICH A1",
      "team_2_code": "SEA A1",
      "ref_team_code": "CHI B1"
    }
  ]
}
```

The importer refuses same-division refs and scored-game overwrites by default. Use `--allow-scored-overwrite` only when intentionally replacing scored rows.
