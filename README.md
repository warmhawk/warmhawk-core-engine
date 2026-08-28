# 🦅 WarmHawk Core Engine

Open-core, self-hosted cold-email/outbound sending infrastructure. API server + BullMQ worker +
Prisma schema + install/update scripts — the free, fully-functional Tier 0 engine
("direct API endpoints, no web UI"). The licensed dashboard lives in the separate, private
`warmhawk-enterprise-operator` repo.

---

## 🚀 Quickstart (self-hosted install)

```bash
curl -fsSL https://warmhawk.com/install | bash -s -- \
  --license whk_live_XXXXXXXXXXXX \
  --domain api.yourcompany.com
```

See `docs/quickstart.md` for the Tier 0 (API-only) 5-minute first-send walkthrough, and
`docs/backup-and-restore.md` before you need either.

---

## 🗂️ Repo layout

| Path | What's in it |
|---|---|
| `apps/api` | Fastify API server — routes, lib (encryption, license, spintax, spam score, OAuth, DNS checks) |
| `apps/worker` | BullMQ dispatch worker — cadence/jitter, weighted rotation, reconciliation cron |
| `packages/db` | Prisma schema + generated client |
| `packages/tier-config` | Single source of truth for Tier 0/1/2 feature gating |
| `ops/redis.conf` | AOF-durable Redis config |
| `nginx/` | Bundled nginx config template + Dockerfile (the only published ports in this package) |
| `scripts/` | `install.sh`, `update.sh`, `backup-postgres.sh` |
| `docs/` | Quickstart, backup/restore, and other self-serve docs |
| `n8n/workflows` | Dispatch/warmup n8n workflow JSON |

---

## 🧪 Local development

```bash
npm install
docker compose -f docker-compose.yml -f docker-compose.test.yml up -d postgres redis
npm run db:migrate
npm test                    # fast unit suite, no external dependencies
npm run test:integration    # against the real Postgres/Redis above
```

---

## 📄 License

Business Source License 1.1 — non-compete Additional Use Grant blocking resale as a competing
hosted service, converts to Apache 2.0 four years after each version's release date.

<!-- ci-verify: 2026-08-28 push:main -> self-trigger-promote -> Pipeline B live-verification commit, no functional change -->
