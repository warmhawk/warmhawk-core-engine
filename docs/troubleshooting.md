# WarmHawk — Troubleshooting

Self-serve docs absorb support volume before it becomes a ticket (Support Model). Check here
first; `support@warmhawk.com` (Tier 1: 1-business-day / 4h-critical) if you're still stuck.

---

## `install.sh` failures

| Symptom | Fix |
|---|---|
| "port 80 and/or 443 is already in use" | No longer a hard failure — `install.sh` falls back to alt ports automatically. See "Installing alongside an existing web server" below. |
| "DNS does not appear to resolve" | Point your domain's `A` record at this server's public IP, wait for propagation (`dig +short yourdomain.com`), re-run |
| Script exits partway through | Safe to just re-run — `install.sh` is idempotent and reuses already-generated secrets/certs |

## Installing alongside an existing web server

Most installs land on an empty box and `install.sh` binds nginx straight to 80/443. If this server
already runs something else on those ports — another app, a hand-rolled nginx/Apache/Caddy, or
the licensed dashboard product's own nginx — `install.sh` detects that and falls back automatically
instead of failing:

- [x] nginx publishes alt ports instead — `8080`/`8443` by default, or whatever you pass via
      `--http-port`/`--https-port`.
- [x] Everything else (secrets, database, TLS bootstrap) proceeds exactly as normal.
- [x] The script prints a `WARNING` with the exact ports it picked — re-run any time with
      `./scripts/install.sh --http-port <port> --https-port <port>` to pick specific ones instead
      of the defaults.

**What you still have to do by hand:** forward your domain from whatever already owns 80/443 to
WarmHawk's alt ports. This can't be automated — `install.sh` has no way to know what's already
running or how to reconfigure it. Add a block like this to your *existing* server's config,
pointing at the alt HTTP port `install.sh` printed:

```nginx
server {
    listen 80;
    listen 443 ssl;
    server_name api.yourcompany.com;   # your WarmHawk domain

    # your existing TLS cert config here, if this block already terminates TLS for other sites

    location / {
        proxy_pass http://127.0.0.1:8080;   # WarmHawk's alt HTTP port
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

> **⚠️ The `/.well-known/acme-challenge/` path matters most.** Certbot's own HTTP-01 challenge
> reaches your domain on the real port 80, not WarmHawk's alt port — it only succeeds if whatever
> owns port 80 is already forwarding to WarmHawk's alt HTTP port *before* `install.sh` gets to the
> certbot step. Set the forward up first, then run (or re-run) `install.sh`; if certbot already
> failed, fix the forward and retry with `./scripts/install.sh --retry-tls`.

This is exactly the scenario `tests/e2e-install/test-port-fallback.sh` exercises locally (pre-occupy
80/443, run `install.sh`, confirm the fallback works end to end) — see that script if you want to
verify this behavior yourself before relying on it in production.

## certbot / TLS issuance failures

Certbot failure never crashes the stack — nginx stays up in HTTP-only mode. Once DNS is
confirmed pointing at this server:

```bash
./scripts/install.sh --retry-tls
```

Common causes: DNS not yet propagated, Let's Encrypt rate limits (5 certs/domain/week — wait or
use `--letsencrypt-staging` while testing), port 80 blocked by a firewall between the internet and
this box.

## Stripe / license-issuance issues

This repo (Tier 0) has no Stripe integration and issues no licenses — it carries no license gate
at all. Billing and license activation are handled by WarmHawk's other products (the account/
billing site and the licensed dashboard) — if you're seeing a billing or licensing issue, contact
`support@warmhawk.com` rather than looking for it here.

## Common `docker compose` problems

| Symptom | Fix |
|---|---|
| A service is "unhealthy" and others won't start | `docker compose logs <service>` — usually `postgres` still initializing; healthchecks wait for it |
| `migrate` container exits non-zero | Check `docker compose logs migrate` — usually a schema drift; never edit the DB by hand, always go through `scripts/update.sh` |
| Rebuilding after a code change doesn't take effect | `docker compose up -d --build` (not just `up -d`) |

## Backup/restore

See `docs/backup-and-restore.md`.

## `warmhawk update` (`scripts/update.sh`) failures

| Symptom | Fix |
|---|---|
| Migration step fails | Nothing is torn down — previous version keeps running. Check `docker compose logs migrate`, fix, re-run `./scripts/update.sh` |
| `git checkout` warning | You're on a modified working tree or offline — the script proceeds with what's on disk; commit/stash local changes or reconnect and re-run |

## Microsoft 365 mailbox connect

Requires a completed Entra app registration under your own tenant (or WarmHawk's, once verified
under the WarmHawk brand). Until then, connect the mailbox via SMTP/IMAP username+password instead
(the universal fallback for any provider).
