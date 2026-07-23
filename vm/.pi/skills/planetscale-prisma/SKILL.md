---
name: planetscale-prisma
description: Conventions for PlanetScale Postgres + Prisma in harness-provisioned apps — schema.prisma as source of truth, direct vs pooled connection strings, prisma.config.ts. Use when touching the database layer, Prisma schema, or DB config.
---

# PlanetScale Postgres + Prisma conventions

This app owns one isolated PlanetScale Postgres **branch** (branches are fully isolated databases).
Two connection strings exist in `~/app/.env` — they have different jobs:

| Env var | Port | Role privileges | Use for |
|---|---|---|---|
| `DATABASE_URL` | 6432 (PgBouncer, transaction pooling) | data read/write only, no DDL | the app at runtime — ONLY this one |
| `DIRECT_DATABASE_URL` | 5432 (direct) | DDL-capable | Prisma CLI (migrations). Never used by app code |

## Hard rules

1. `prisma/schema.prisma` is the source of truth for the schema. Model everything there.
2. Do NOT run `prisma migrate dev` / `migrate deploy` / `db push` — the harness applies migrations
   (`migrate diff` → `db execute` over the direct connection). Just write the schema, then run
   `npx prisma generate` if you need the client for type-checking.
3. Create `prisma.config.ts` exactly like this (Prisma v7 + PlanetScale docs pattern), so CLI
   operations use the direct connection:

   ```ts
   import "dotenv/config";
   import { defineConfig, env } from "prisma/config";

   export default defineConfig({
     schema: "prisma/schema.prisma",
     migrations: { path: "prisma/migrations" },
     datasource: { url: env("DIRECT_DATABASE_URL") },
   });
   ```

4. The runtime client must connect via `DATABASE_URL` (PgBouncer). PgBouncer runs in transaction
   pooling mode: no session state (`SET`, advisory locks held across transactions, LISTEN/NOTIFY).
   Prefer Prisma Client (check the installed Prisma major version's docs for the current
   PostgreSQL adapter setup) or `pg` Pool with `connectionString: process.env.DATABASE_URL`.
5. TLS is mandatory; the URLs already carry `sslmode=verify-full`. Never edit or log them.
6. Every table needs a primary key. Keep the schema in the default `postgres` database, `public` schema.
