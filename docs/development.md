English | [中文](development.zh-CN.md)

# Development

## Load locally

In this repository:

```sh
pi -e ./src/index.ts
```

Or install the local plugin from another project (use the actual path):

```sh
pi install /absolute/path/to/pi-goal
```

Then start Pi; existing sessions can reload the plugin with `/reload`.

## Develop

TypeScript and pnpm; the plugin entry is `src/index.ts`. Tests live only in `e2e/` and use Node's built-in test runner, with no extra test framework.

```sh
pnpm install
pnpm check
```

Pi loads TypeScript directly, so there is no build output. `pnpm check` runs the typecheck and E2E tests; `pnpm test:e2e` runs E2E only.

## E2E coverage

`e2e/goal.test.mjs` starts the real Pi CLI from the dependency as a child process and drives the plugin through RPC commands and extension UI requests / responses, without mocking the plugin API. Each test uses its own temporary workspace and Pi agent directory, cleaned up afterwards, and every RPC wait has a timeout.

Covered today:

- Plugin loading and `/goal` command registration.
- RPC select-list fallback: current session by default, "切换到：…" scope items, the "＋ 新增目标" submenu, cross-session filtering, and read-only details for other workspaces (the TUI panel must be verified in a real terminal).
- TODO view, manual completion, and persisted completion time and verification notes.
- Cancelling with kept changes, and the rollback option.
- JSON persistence across restarts and deletion of goal files.
- S-expression export / import round trips, exclusion of private fields, TODO state reset, no automatic run after confirming, and approvals exported as suggestions and imported unapproved.
- Invalid syntax, unknown / duplicate fields, versions, complexity / size limits, malformed approvals, cancelled imports and refusing to overwrite existing exports.
- `/goal` as the single entry point: help, `/goal #<id>` opening a goal and keeping the menu after actions, unknown ids, bare numbers rejected (neither opened nor created), subcommand-like ordinary text still creating goals, invalid snippet names, aliases matching the main command; no AI turn without usable model credentials.
- `/goal status`: TODO icons, completion times and done / blocked notes, accumulated time, interrupted runs settled at their last update on load, the session summary when nothing is running, and `status` never creating a goal.
- Snippets: built-in list, extra project context, global save (with review), reuse across workspaces, user snippets overriding built-ins, refusing overwrites and invalid names, cancel creating nothing.
- Design objectives, 8 CHECK dimensions, benchmarks and bounded review rules surviving import, restart, panel view and export; unsupported priorities, duplicate dimensions and unbounded reviews are rejected.

Tests seed goal JSON and call no model or external service, so no credentials are needed. Real AI clarification, execution and rollback, terminal visuals and keyboard interaction are not covered and cannot be replaced by RPC panel tests.

## Git hooks

`prek.toml` configures pre-commit checks. After cloning, run:

```sh
prek install
```

Commits check trailing whitespace, final newlines, large files, merge conflicts and JSON / TOML / YAML syntax. Changes to sources, E2E or related configuration also run the typecheck and existing E2E tests; no file names are passed to these commands.

Check all tracked files manually:

```sh
prek run --all-files
```

No lint or format tool is configured; GitHub Actions only has `publish.yml` for releases (see below).

## Release

1. Update `version` in `package.json` and the install examples in both READMEs (`README.md`, `README.zh-CN.md`), then run `pnpm check`.
2. Commit and push `main`, then push the matching `vX.Y.Z` tag.
3. Publish a GitHub Release for the tag (notes in three parts: Changes / Validation / Install). [publish.yml](../.github/workflows/publish.yml) verifies the tag matches `package.json`, runs the typecheck and tests, and publishes to npm with provenance via OIDC; no npm token is stored in GitHub.

One-time setup by the npm package owner (needs npm 11.19+ and 2FA):

```sh
npm trust github @light4/pi-goal --repo light4/pi-goal --file publish.yml --allow-publish --yes
```

Trusted publishing can only be configured for an existing package, so v0.1.0 was published manually by the owner with `npm publish --access public` before configuring the trust above; later versions are all published through GitHub Releases. If publishing fails, fix the cause and rerun the failed GitHub Actions job; confirm both the GitHub Release and the npm version before updating consumers.

[Back to README](../README.md)
