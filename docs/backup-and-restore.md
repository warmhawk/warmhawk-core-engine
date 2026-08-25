# WarmHawk — Backup & Restore

> A backup you have never restored is a guess, not a backup. This doc walks through both taking a
> manual backup and actually restoring one — drill the restore once against a scratch instance
> before you need it for real.

---

## 📋 Quick reference

| Task | Command |
|---|---|
| Take a manual backup right now | `./scripts/backup-postgres.sh` |
| See where backups are stored | `echo $BACKUP_LOCAL_PATH` (default `/var/backups/warmhawk`) |
| List existing backups | `ls -lh $BACKUP_LOCAL_PATH` |
| Restore the most recent backup | `./scripts/restore-postgres.sh --latest` |
| Restore a specific backup | `./scripts/restore-postgres.sh /path/to/warmhawk-postgres-<timestamp>.sql.gz` |
| Change retention window | Edit `BACKUP_RETENTION_DAYS` in `.env` (default 14 days) |

---

## 🕐 How the nightly backup works

`scripts/install.sh` prompts once, during setup, for nightly backups (default: **yes**) and
writes a cron entry that runs `scripts/backup-postgres.sh` every night. The script:

1. Runs `pg_dump` **inside** the `postgres` container (via `docker exec`) — no local `pg_dump`
   binary version-matching required.
2. Pipes the dump through `gzip -9` to `${BACKUP_LOCAL_PATH}/warmhawk-postgres-<timestamp>.sql.gz`.
3. Optionally copies that file off-box via `rclone`, if you've configured
   `BACKUP_RCLONE_REMOTE` in `.env` (your own S3/B2/etc. bucket — WarmHawk never receives or
   stores this backup itself).
4. Prunes local backups older than `BACKUP_RETENTION_DAYS` (default 14).

> **🔑 Your data never leaves your box unless you explicitly configure an off-box remote.** This
> is consistent with the rest of WarmHawk's self-hosted positioning — WarmHawk has no access to
> your Postgres instance or its backups after `install.sh` finishes.

---

## 🔧 Taking a manual backup

```bash
./scripts/backup-postgres.sh
```

This is the exact same script the nightly cron runs — safe to run any time, e.g. right before a
`warmhawk update` or a risky manual change.

---

## ♻️ Restoring from a backup

> ⚠️ **This will overwrite your current database.** Take a fresh backup first if there's any
> chance you need what's currently live.

```bash
./scripts/restore-postgres.sh --latest
# or a specific file:
./scripts/restore-postgres.sh /var/backups/warmhawk/warmhawk-postgres-20260101T020000Z.sql.gz
```

`scripts/restore-postgres.sh` automates every step that used to be a manual walkthrough here:
stops `api`/`worker`/`n8n` (Postgres stays up), terminates existing connections and **drops and
recreates** the `warmhawk` database (this is the fix for the foreign-key-conflict restore issue —
applied automatically now, not left as a manual troubleshooting step), restores the dump, then
brings `api`/`worker`/`n8n` back up. It asks for a typed `restore` confirmation before touching
anything (skip that prompt with `--yes` for scripted/CI use). If bringing the app services back up
fails after a successful restore, the script says so explicitly and tells you the exact command to
retry — a failure at that point does **not** mean the restore itself failed.

**Verify:** log into the dashboard (or query the API directly) and confirm your leads/campaigns/
domains are present and current as of the backup's timestamp.

---

## ✅ This restore path has actually been drilled, not just documented

Unlike a doc written from a script's intended behavior, this one reflects a real run: a marker row
was inserted, backed up with `backup-postgres.sh`, a second marker row was inserted afterward,
then `restore-postgres.sh --latest --yes` was run against that same instance. Result: the
pre-backup row survived, the post-backup row was gone, and `psql` confirmed both directly — this is
what "the restore path is tested, not just documented" concretely means for this repo.

If you want to re-drill this yourself against your own instance (recommended before you need it
for real, and worth repeating after any Postgres major-version upgrade):

- [ ] Take a manual backup: `./scripts/backup-postgres.sh`.
- [ ] Add a test lead/campaign so there's a clear "before/after" marker.
- [ ] Add another test lead **after** the backup (this one should be gone after restore).
- [ ] Restore: `./scripts/restore-postgres.sh --latest`.
- [ ] Confirm the pre-backup lead is present and the post-backup lead is gone.

If any step above doesn't work exactly as documented, fix the doc (or the script) before you
actually need it under pressure.

---

## 🆘 Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| `pg_dump: command not found` inside the container error | Wrong Postgres image/tag | Confirm `postgres` service is the one shipped in `docker-compose.yml` — don't swap the image |
| Backup file is 0 bytes / `.partial` file left behind | `pg_dump` failed partway (disk full, DB down) | Check `docker compose logs postgres`; free disk space; re-run the script |
| `rclone` warning about missing binary | `BACKUP_RCLONE_REMOTE` set but `rclone` not installed on the host | `apt install rclone` / `brew install rclone`, then re-run |
| Restore hangs or errors on foreign key constraints | Restoring into a DB with existing conflicting data | Drop and recreate the `warmhawk` database first, or restore into a fresh scratch instance |

Still stuck? `support@warmhawk.com` — 1-business-day SLA, 4-hour for critical issues (Tier 1+).
