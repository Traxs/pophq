# Read API

A bot token may use every normal POP HQ `GET /v1/...` route with the issuing person's current permissions and linked accounts. It cannot use normal `POST`, `PUT`, `PATCH`, or `DELETE` routes. Browser-origin requests are rejected.

Use `scripts/s26.py get PATH`, where `PATH` starts below `/v1`:

- `/me`: current issuer groups and linked game accounts.
- `/accounts`: game accounts.
- `/accounts/{playerId}`: one game account.
- `/accounts/{playerId}/reports`: strength reports and current values.
- `/accounts/{playerId}/reliability`: attendance reliability; own account or officer.
- `/accounts/{playerId}/timeline`: history; own account or officer.
- `/roster`: officer roster and trends.
- `/metrics/alliance`: officer alliance metrics.
- `/event-types`: configured event types.
- `/events`: recent and upcoming events.
- `/events/{eventId}`: event details, sign-ups, lineup, strategy and results, filtered by the issuer's permissions.

For a personalized view, add `--account-id PLAYER_ID`. The ID must be linked to the issuing user. Preserve server-side visibility rules: do not infer or claim access to data that a response omits.
