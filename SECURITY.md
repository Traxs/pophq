# Security policy

## Reporting a vulnerability

Please report security issues privately through GitHub's **"Report a vulnerability"** button on this repository's Security tab. Don't open a public issue. We aim to reply within 7 days.

## Secrets

This repository is public. Secrets are never committed:

- Runtime secrets (Discord webhooks, the Discord OAuth client secret, the origin-verify value, the agent-token pepper) live only in AWS SSM Parameter Store.
- AWS access uses short-lived roles; there are no access keys in this repository or in GitHub.
- Every commit is scanned by gitleaks locally (pre-commit hook) and in CI (required check), and GitHub push protection is on.

If a secret is ever committed: rotate or revoke it first, check logs for use, then clean the history.
