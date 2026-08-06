## What this changes

<!-- One or two sentences. -->

## Why

<!-- What breaks or is missing without it. -->

## Checklist

- [ ] `cd email-worker && npm run typecheck && npm test` passes (83 tests)
- [ ] `npm run build` succeeds
- [ ] No vehicle, price, year or location hardcoded outside `hunt.config.ts`
- [ ] No personal data (email, ZIP, API keys) in the diff
- [ ] Added a test if this changes parsing or scoring behaviour
