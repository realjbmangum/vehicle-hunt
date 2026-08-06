# Contributing

Thanks for looking. This started as one person's tool for buying one truck, so
it has opinions. Contributions that make it work for *your* vehicle without
breaking mine are very welcome.

## The one rule

**Nothing outside `hunt.config.ts` may hardcode a vehicle, a price, a year or a
location.** That file is the whole configuration surface. If you find code that
violates this, it's a bug worth reporting even if you don't fix it.

## Getting set up

```bash
git clone https://github.com/realjbmangum/vehicle-hunt.git
cd vehicle-hunt
npm install
cd email-worker && npm install
```

Run the dashboard against a local database with fake data — no Cloudflare
account needed:

```bash
cp wrangler.example.jsonc wrangler.jsonc     # placeholder id is fine locally
npx wrangler d1 execute vehicle-hunt-db --local --file=./src/data/schema.sql
for m in email-worker/migrations/*.sql; do
  npx wrangler d1 execute vehicle-hunt-db --local --file="$m"
done
npx wrangler d1 execute vehicle-hunt-db --local --file=./src/data/seed.sql
npm run dev
```

## Before you open a PR

```bash
cd email-worker && npm run typecheck && npm test
cd .. && npm run build
```

CI runs exactly these three. All 83 tests must pass.

## Testing

Tests live in `email-worker/tests/` and run on Node's native TypeScript
stripping — no build step, no test framework beyond `node:test`.

They make **no network calls** and mock none of our own code. VIN decoding,
scoring, twin matching and the inventory mapper are tested against real
captured API payloads in `tests/fixtures/`.

If you change parsing or scoring behaviour, add a case. If you're changing how
listings are interpreted, the `/replay` endpoint lets you dry-run the new
parser over emails already in your database and see the diff before anything
is written.

## Things that need doing

- **More vehicle profiles.** The shipped config describes a Toyota Tacoma.
  Worked configs for other common searches — a 4Runner, an F-150, a Wrangler —
  would make this useful immediately rather than after an hour of editing.
- **Other inventory sources.** The sweep talks to one API. The mapper in
  `inventory-map.ts` is deliberately separate from the fetching so a second
  source is mostly a new mapper.
- **Private-party listings.** Facebook Marketplace and Craigslist are where
  the sharper prices are and nothing here reaches them. If you have a legal,
  terms-respecting approach, that's the biggest gap in the project.

## Style

Match what's there. The codebase comments *why*, not *what* — several comments
explain a bug that the current shape exists to prevent, and those are the most
valuable lines in the repo. Please don't strip them.

## Reporting bugs

Include your `hunt.config.ts` (with your email and ZIP removed) and what you
expected versus what happened. If it's a parsing issue, a redacted sample of
the email that broke it helps enormously.
