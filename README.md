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
- Player shirt size and extra player-tied shirt orders.
- Entry payment tracking with paid checkbox, amount, date, and method.
- Admin dashboard for all centers, teams, passcodes, snapshots, and Excel export.
- Admin state snapshots with restore.
- Draft seeding and double-elimination placeholder schedule generator.
- Excel export includes teams, players, extra shirts, and schedule.
