# Security Policy

## Reporting a vulnerability

Please report security issues through
[GitHub's private vulnerability reporting](https://github.com/realjbmangum/vehicle-hunt/security/advisories/new)
rather than opening a public issue.

I'll acknowledge within a week. This is a personal project maintained in spare
time, so please set expectations accordingly — but anything that exposes a
user's data or API keys I'll treat as urgent.

## What this software handles

Running this means holding, on your own infrastructure:

- **An Anthropic API key**, as a Cloudflare Worker secret. Every inbound email
  spends against it.
- **An inventory API key**, if you enable the sweep.
- **A trigger token** guarding `/digest`, `/sweep` and `/replay`.
- **Raw inbound email**, stored in D1 — including whatever the sender put in it.
- **Your email address and ZIP code**, in config.

## If you deploy this

**Set a strong `TRIGGER_TOKEN`.** It is the only thing standing between the
public internet and your endpoints. `/replay` and `/sweep` both spend money on
your API keys — an unguarded one is somebody else's free LLM. Use a long random
string, not a word.

**Never commit `wrangler.jsonc`.** Both are gitignored for this reason. They
carry your database ID and addresses.

**Secrets go through `wrangler secret put`, never into config files.** Nothing
in this repo should ever contain a live key.

**Your ZIP and email end up in `hunt.config.ts`.** That file is committed. If
you fork this publicly, that's your home area and your inbox in public git
history — the same mistake that meant this project had to be republished from
a clean snapshot rather than open-sourced in place. Consider whether your fork
should be private.

## Deliberate design choices

These are intentional, not oversights:

- **The email path forwards to your address only.** Verification emails are
  forwarded, but only from an allowlist of known sender domains. Untrusted
  senders always go through the classifier first, so the worker can't be turned
  into an open relay by putting "verify your email" in a subject line.
- **`/replay` is capped.** Both `limit` and an explicit id list are clamped to
  50, because every id costs an LLM call and `?id=1,2,…,10000` would otherwise
  be an expensive way to burn your key.
- **`/img/` rejects path traversal** and only ever reads. Keys are opaque.
- **The parser never invents facts.** An unstated drivetrain returns null
  rather than a guess. This is a data-integrity property, but it's also why a
  malicious listing can't assert its way past your filters.

## Scope

Not in scope: vulnerabilities in Cloudflare, Anthropic, or the inventory APIs
themselves — report those to the relevant vendor.
