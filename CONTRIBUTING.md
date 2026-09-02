# 🤝 Contributing to WarmHawk Core Engine

Thanks for your interest in this project. A few things to know before opening an issue or PR.

---

## 📄 License context

This repo is licensed under the [Business Source License 1.1](LICENSE) — source-available, not
a permissive open-source license. WarmHawk is the sole maintainer, and we're intentionally
selective about what gets merged, since every accepted change becomes something we commit to
supporting long-term.

## 🐛 Bug reports

Open a [GitHub issue](../../issues) with steps to reproduce, your install tier, and relevant
logs (`warmhawk logs`). We read every report.

## 🔒 Security issues

**Do not open a public issue for a security vulnerability.** Follow [`security.txt`](security.txt)
— report to security@warmhawk.com instead, and we'll acknowledge within our published SLA.

## 🚀 Pull requests

- **Small fixes** (typos, docs, a clear bug with a minimal repro) — open a PR directly.
- **Anything larger** (new features, architecture changes, new dependencies) — open an issue
  first and describe what you want to do before writing code. We may not be able to accept a
  large PR that doesn't match our roadmap, even if it works, and we'd rather tell you that
  before you invest the time.
- All PRs need to pass `npm run lint`, `npm run typecheck`, `npm test`, and
  `npm run format:check` before review.

## ❓ Questions

Not a bug, not a feature request? Reach us at hello@warmhawk.com.
