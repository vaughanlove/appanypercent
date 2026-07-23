---
name: planetscale-prisma
description: Conventions for PlanetScale Postgres + Prisma in harness-provisioned apps — exact Prisma 6 pin, schema.prisma as source of truth, direct vs pooled connection strings. Use when touching the database layer, Prisma schema, or DB config.
---

# PlanetScale Postgres + Prisma conventions

This app owns one isolated PlanetScale Postgres **branch** (branches are fully isolated databases).
Two connection strings exist in `~/app/.env` — they have different jobs:

| Env var | Port | Role privileges | Use for |
|---|---|---|---|
| `DATABASE_URL` | 6432 (PgBouncer, transaction pooling) | data read/write only, no DDL | the app at runtime — ONLY this one |
| `DIRECT_DATABASE_URL` | 5432 (direct) | DDL-capable | Prisma CLI (migrations). Never used by app code |

## Hard rules

1. Pin Prisma EXACTLY in package.json (no caret — the harness's migrate commands are written
   against this version's CLI flags):

   ```json
   "dependencies": { "@prisma/client": "6.19.3" },
   "devDependencies": { "prisma": "6.19.3" }
   ```

2. `prisma/schema.prisma` is the source of truth. Datasource block exactly:

   ```prisma
   datasource db {
     provider  = "postgresql"
     url       = env("DATABASE_URL")          // runtime: PgBouncer :6432
     directUrl = env("DIRECT_DATABASE_URL")   // prisma CLI: direct :5432
   }
   ```

   Do NOT create a `prisma.config.ts` (that's the Prisma 7 pattern; we're on 6).
3. Do NOT run `prisma migrate dev` / `migrate deploy` / `db push` — the harness applies the schema
   (`migrate diff --from-url ... --to-schema-datamodel ...` → `db execute --url ...` over the
   direct connection). Just write the schema; run `npx prisma generate` for the typed client.
4. Runtime: `new PrismaClient()` (it reads `DATABASE_URL`). PgBouncer runs transaction pooling:
   no session state (`SET`, session advisory locks, LISTEN/NOTIFY).
5. TLS is mandatory; the URLs already carry `sslmode=verify-full`. Never edit or log them.
6. Every table needs a primary key. Keep the schema in the default `postgres` database, `public` schema.
