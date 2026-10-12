# Contributing

## Setup

You need [Bun](https://bun.sh) and Node.js 22.19.0 or later.

```sh
bun install
```

## Check and test

```sh
bun run check
bun run test
```

`check` runs the TypeScript compiler without output.
`test` runs the tests in `test/` with the Node.js test runner.

## Try a local copy in pi

From the root of this repository, run pi with the local source:

```sh
pi -e ./src/index.ts
```

To load the local copy in every session, install it as a local package:

```sh
pi install ./
```

## Release

`npm version` owns the version number.
Never edit the `version` field in `package.json` by hand.

Every release has a `CHANGELOG.md` entry, and the GitHub release shows that entry.
Cut a release from `main` in this order:

1. Add a `## [<version>] - <YYYY-MM-DD>` section at the top of `CHANGELOG.md`, below the intro.
2. Add a `[<version>]: <compare-url>` link at the bottom of `CHANGELOG.md`.
3. Commit the entry and push `main`.
4. Run the release command:

```sh
npm run release -- <bump>
```

`<bump>` is `patch`, `minor`, `major`, `prepatch`, `preminor`, `premajor`, `prerelease`, or an exact version such as `<MAJOR>.<MINOR>.<PATCH>`.
Add `--dry-run` to run every check and print the plan without a change.

The script refuses to start unless the branch is `main`, the working tree is clean, `main` agrees with its upstream, and `bun run check` and `bun run test` pass.
It then runs `npm version <bump>`, refuses a version that has no `CHANGELOG.md` section or is already on npm, and pushes `main` and the `v<version>` tag.
If a step after the bump fails, it resets to the starting commit and deletes only the tag that this run created.

A push of a `v*` tag starts `.github/workflows/release-npm.yml`.
The workflow refuses a tag that `main` does not hold.
It then reads the `CHANGELOG.md` section for the version, installs, type-checks, tests, reads `NPM_TOKEN` from Infisical, and publishes with provenance.
Last, it creates the GitHub release with the `CHANGELOG.md` section, followed by the notes that GitHub generates.
A version with a `-` goes to the `next` dist-tag.
A normal version goes to `latest`.

The workflow needs this one-time setup:

1. The Infisical project `lazco-pi-image-budget`, env `prod`, path `/ci`, with `NPM_TOKEN`.
2. The repo variable `INFISICAL_CI_IDENTITY_ID`.
3. The Infisical machine identity, bound to this repo.

### Pick the bump

- `patch` for a fix only.
- `minor` for new user-facing behavior, such as a new setting or command.
- `major` for a change that breaks a user setup.

### Write the changelog entry

- Write only changes that a user can see. Leave out CI, tests, and refactors.
- Group the items under `### Added`, `### Changed`, `### Fixed`, `### Removed`, or `### Docs`.
- Put each full sentence on its own line.
