# WarmHawk — Tier 0 Quickstart (first send in 5 minutes)

> New, closing a real gap: Tier 0 has been "direct API endpoints, no web UI" since day one with
> no onboarding material of its own. This is that starting point — a curl-based walkthrough to
> your first send.

No dashboard required for any of this — every step is a plain HTTP call against your own running
instance (`https://api.yourcompany.com` after `install.sh`, or `http://localhost:4600` in local
dev).

---

## 1. Create an API user (one-time, via the bootstrap CLI)

```bash
docker compose exec api node -e "
  const bcrypt = require('bcrypt');
  const { prisma } = require('@warmhawk/db');
  (async () => {
    const passwordHash = await bcrypt.hash('change-me-immediately', 10);
    await prisma.user.create({ data: { email: 'you@yourcompany.com', passwordHash, role: 'ADMIN' } });
    console.log('User created.');
  })();
"
```

## 2. Log in

```bash
curl -s -X POST https://api.yourcompany.com/v1/auth/login \
  -H 'content-type: application/json' \
  -d '{"email":"you@yourcompany.com","password":"change-me-immediately"}'
# => { "token": "..." }
```

Save that token — every call below sends it as `Authorization: Bearer <token>`.

## 3. Create a campaign

```bash
curl -s -X POST https://api.yourcompany.com/v1/campaigns \
  -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"name":"First Campaign","aiPromptTemplate":"Write a short, friendly intro email."}'
```

## 4. Import a test lead

```bash
curl -s -X POST https://api.yourcompany.com/v1/leads/webhook \
  -H 'content-type: application/json' \
  -d '{"campaignId":"<campaign-id-from-step-3>","email":"test-lead@example.com","firstName":"Test"}'
```

## 5. Check the queue status

```bash
curl -s https://api.yourcompany.com/v1/leads?campaignId=<campaign-id> -H "Authorization: Bearer $TOKEN"
```

Once a mailbox is connected (see the main README's mailbox-connect docs) and the campaign is set
`ACTIVE`, the worker's enqueuer picks this lead up automatically — no further action needed.

---

Questions? Community support (GitHub Issues/Discussions) for Tier 0 — see the Support Model in
the main product docs for Tier 1/2 SLAs.
