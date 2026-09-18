## What and why

<!-- One or two sentences. Link the spec story ID(s), e.g. PWR-01, FM-11. -->

## How it's tested

- [ ] Unit tests cover the changed behaviour (bug fixes start with a failing test)
- [ ] Integration tests updated if routes, streams, outbox or auth changed
- [ ] Ran locally against `npm run dev:up`

## Safety

- [ ] No secrets, tokens, webhook URLs or account IDs in the diff (gitleaks passed locally)
- [ ] API changes are additive within `/v1`
- [ ] Data changes follow expand/contract (no field or index removed in the same deploy that stops using it)
