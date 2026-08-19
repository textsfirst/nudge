# Contributing to Nudge

Thanks for helping improve Nudge.

## Before opening a change

- For substantial changes, open an issue first so the approach can be discussed.
- Keep changes focused and include tests for behavior changes.
- Do not commit credentials, OAuth tokens, personal data, `.env`, or files from `.data/`.

## Development checks

Install dependencies and run the full check suite:

```bash
pnpm install
pnpm check
```

## Developer Certificate of Origin

Nudge uses the [Developer Certificate of Origin 1.1](DCO). Every commit must include a `Signed-off-by` trailer certifying that you have the right to submit the contribution under the project's license.

Sign a commit with:

```bash
git commit -s
```

The trailer uses the identity configured in Git, for example:

```text
Signed-off-by: Jane Developer <jane@example.com>
```

If a pull request contains unsigned commits, sign and amend or rebase those commits before it is merged. The DCO is a certification of contribution rights, not a copyright assignment.

## Contribution license

Unless explicitly stated otherwise, contributions accepted into this repository are licensed under the [Apache License 2.0](LICENSE), consistent with section 5 of that license. Material incorporated from elsewhere must retain its original license, copyright, and attribution notices.
