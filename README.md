# BoothGuard

React/Vite and Express application with MongoDB Atlas persistence.

## Run locally

Requires Node.js 22.18+ (Node.js 24 recommended).

```powershell
npm install
Copy-Item .env.example .env # only for a fresh checkout; preserve your configured .env
npm run dev
```

Open http://localhost:3000. This checkout already has the supplied Atlas connection configured in the Git-ignored `.env` file.

Environment settings:

- `MONGODB_URI`: Atlas connection string; server-only secret.
- `MONGODB_DB_NAME`: database name, default `boothguard`.
- `SEED_DEMO_DATA=true`: initializes the original demo data only when both booths and admins are empty. Disable for deployments that should not contain demonstration accounts.
- `MONGODB_DNS_SERVERS`: optional comma-separated DNS servers for environments whose system DNS refuses Atlas SRV/TXT queries. This machine required `1.1.1.1,8.8.8.8`.
- `PORT`: defaults to `3000`.

Atlas must permit the application's IP in Network Access, and the database user needs read/write and index-creation access. Transactions require Atlas or another MongoDB replica set.

Demo logins: booth `BOOTH-042`, `officer1` / `1001` or `officer2` / `1002`; ward administrator `admin` / `9999`.

## Validate

```powershell
npm run lint
npm run build
npm run test:db
```

The database integration test uses a randomly named `bgtest_...` database and drops that database in cleanup. It requires permission to create and drop a separate test database and never uses `MONGODB_DB_NAME` as its target.

For production, build first, set `NODE_ENV=production`, then run `npm start`.

## Storage

MongoDB collections: `booths`, `officers`, `voters`, `audit_logs`, `admins`, and `counters`. Existing numeric voter/audit IDs and API response shapes are preserved. Unique indexes enforce booth/user and voter identifiers. Transactions cover vote/audit updates, roll replacement, booth creation, and poll changes. A per-booth transaction write lock prevents poll closure or roll replacement from racing a vote.

The SQLite runtime has been removed. The repository contained SQLite WAL/SHM sidecar files without the main database; they are not imported or used. `src/server/demo-data.json` preserves the original code-generated demonstration data. This change does not migrate an existing external SQLite database.

Realtime WebSocket presence and broadcasts remain local to a single server process, as in the original application.
