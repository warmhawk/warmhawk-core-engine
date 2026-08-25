# WarmHawk — Troubleshooting

Self-serve docs absorb support volume before it becomes a ticket (Support Model). Check here
first; `support@warmhawk.com` (Tier 1: 1-business-day / 4h-critical) if you're still stuck.

---

## `install.sh` failures

| Symptom | Fix |
|---|---|
| "Port 80/443 already in use" | Stop whatever's bound to it (`sudo lsof -i :80`), re-run |
| "DNS does not appear to resolve" | Point your domain's `A` record at this server's public IP, wait for propagation (`dig +short yourdomain.com`), re-run |
| Script exits partway through | Safe to just re-run — `install.sh` is idempotent and reuses already-generated secrets/certs |

## certbot / TLS issuance failures

Certbot failure never crashes the stack — nginx stays up in HTTP-only mode. Once DNS is
confirmed pointing at this server:

```bash
./scripts/install.sh --retry-tls
```

Common causes: DNS not yet propagated, Let's Encrypt rate limits (5 certs/domain/week — wait or
use `--staging` while testing), port 80 blocked by a firewall between the internet and this box.

## Stripe / license-issuance issues

This repo (Tier 0) has no Stripe integration and issues no licenses — it carries no license gate
at all. The Stripe webhook and RSA license signing live in `warmhawk-site`; license verification
lives in `warmhawk-enterprise-operator`'s `LicenseGate`. See those repos' own troubleshooting docs
(`warmhawk-site`'s `/docs/stripe-webhooks` and `/docs/license-activation`) for webhook-delivery and
signature issues.

## Common `docker compose` problems

| Symptom | Fix |
|---|---|
| A service is "unhealthy" and others won't start | `docker compose logs <service>` — usually `postgres` still initializing; healthchecks wait for it |
| `migrate` container exits non-zero | Check `docker compose logs migrate` — usually a schema drift; never edit the DB by hand, always go through `scripts/update.sh` |
| Rebuilding after a code change doesn't take effect | `docker compose up -d --build` (not just `up -d`) |

## Backup/restore

See `docs/backup-and-restore.md` — the same doc used for the Pre-Production restore drill.

## `warmhawk update` (`scripts/update.sh`) failures

| Symptom | Fix |
|---|---|
| Migration step fails | Nothing is torn down — previous version keeps running. Check `docker compose logs migrate`, fix, re-run `./scripts/update.sh` |
| `git checkout` warning | You're on a modified working tree or offline — the script proceeds with what's on disk; commit/stash local changes or reconnect and re-run |

## Microsoft 365 mailbox connect

Requires a completed Entra app registration under your own tenant (or WarmHawk's, once verified
under the WarmHawk brand) — see `docs/microsoft-365-oauth-setup.md`. Until then, connect the
mailbox via SMTP/IMAP username+password instead (the universal fallback for any provider).
