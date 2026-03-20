# Changesets

This repository uses Changesets for versioning and npm releases.

## Create a release entry

Run:

```bash
npm run changeset
```

Pick the package, choose the bump type, and write a short summary.

Commit the generated file in `.changeset/`.

## What happens on GitHub

- pushes to `main` run the release workflow
- if there are pending changesets, GitHub opens or updates a release PR
- when that release PR is merged, GitHub publishes the package to npm
- GitHub releases are created automatically by the Changesets action
