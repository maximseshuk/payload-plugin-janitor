# Contributing

Thanks for helping with the Janitor plugin for Payload. This guide covers the setup, the rules the code follows, and how pull requests get reviewed.

## Before you start

- For a bug, open an issue with steps to reproduce first, unless the fix is small and obvious.
- For a new feature or a change to the public options, open an issue first and describe the use case. It saves you work if the idea doesn't fit the plugin.
- For security problems, don't open an issue. Follow [SECURITY.md](SECURITY.md).

## Setup

You need Node.js 24.15+ and pnpm 12.

```bash
pnpm install
pnpm test:unit
```

The tests need no accounts and no running services. Storage is an in-memory adapter, Postgres runs in PGlite, MongoDB runs in `mongodb-memory-server`, and SQLite runs in memory.

## Commands

```bash
pnpm typecheck            # tsc on src/ and tests/
pnpm lint                 # oxlint
pnpm format               # oxfmt
pnpm test:unit            # vitest, tests/unit: no database
pnpm test:int             # vitest, tests/integration: TEST_DB=sqlite|postgres|mongodb, default sqlite
pnpm test:all             # unit, then integration on all five database setups, see below
pnpm test:stress          # opt-in run with 100 000 uploads, see below
pnpm build                # tsdown -> dist/
pnpm dev:seed && pnpm dev # dev admin at http://localhost:3000/admin
```

Run `pnpm format`, then `pnpm typecheck && pnpm lint && pnpm format:check && pnpm test:all && pnpm build` before you push. CI runs the integration tests on SQLite only, so the other four database setups are up to you.

### Databases

`TEST_DB` is `sqlite` (the default), `postgres` or `mongodb`. `BLOCKS_AS_JSON=1` turns on `blocksAsJSON`. `pnpm test:all` runs the integration tests in these five setups:

| Environment                         | Database | Blocks              |
| ----------------------------------- | -------- | ------------------- |
| `TEST_DB=sqlite`                    | SQLite   | own tables          |
| `TEST_DB=sqlite BLOCKS_AS_JSON=1`   | SQLite   | `blocksAsJSON`      |
| `TEST_DB=postgres`                  | Postgres | own tables          |
| `TEST_DB=postgres BLOCKS_AS_JSON=1` | Postgres | `blocksAsJSON`      |
| `TEST_DB=mongodb`                   | MongoDB  | inside the document |

Run one setup with `TEST_DB=postgres pnpm test:int`. Usage detection reads each database differently, so a change under `src/server/usage/` must pass all five.

### Dev admin

The test app also runs as a real Payload admin at http://localhost:3000/admin.

- `pnpm dev:seed` deletes `tests/dev.db*` and `tests/dev-media`, then fills them with sample documents and files. The seed also leaves a few stray files there, so a scan finds orphans.
- Log in as `dev@example.com` / `dev`. Open `media/1` to see the usage panel on a file used in many places.
- The dev scripts set `JANITOR_DEV=1`. With it, uploads are stored on disk under `tests/dev-media/<collection>` and listed with `localAdapter`.
- Run `pnpm dev:generate-importmap` after you add or rename a client component.

### Stress test

`pnpm test:stress` builds 100 000 uploads with one stored object each, one document that references all but three of them, and five stray objects. It then checks that the scan reports exactly those. `STRESS_SIZE` scales it down.

On SQLite in memory on a laptop, the reverse index over 100 000 uploads takes about 1.7 s and the scan about 2.3 s. Creating the uploads takes most of the 70 s run.

## Code rules

The full list is in [AGENTS.md](AGENTS.md). The ones that matter most:

- **Only `purgeApproved` deletes.** A scan writes findings and nothing else. A purge acts only on findings marked `delete` and checks each one again right before it deletes.
- **When unsure, the document is used.** A false "unused" destroys data. If usage detection can't be sure, it throws or returns `null`, never an empty list.
- **A rescan never overwrites a human decision.** It updates facts only, never `note`, `keep` or `delete`.
- **Defaults and startup checks live in `resolveOptions`**, runtime checks in `validateRuntime` (`src/server/options/`). Everything else takes `ResolvedOptions`.
- **The storage contract grows by fields, not arguments.** A storage adapter knows `list` and `delete`. `list` walks the whole prefix or throws.
- **SQL:** every identifier goes through `quote()`, every value through a placeholder. Queries from hooks pass `req.transactionID`.
- **No code comments**, except JSDoc on the plugin options types in `src/shared/types/options.ts`.
- **No new runtime dependency.** Adapters take a client the user already built.
- **Match the surrounding code.** Follow the naming and patterns already used in the file you change.

## Tests

- Add or update tests for every behavior change.
- Specs that need no database live in `tests/unit/`. Specs that boot Payload live in `tests/integration/` as `*.int.spec.ts`; each boots its own Payload on the database named by `TEST_DB` (`tests/helpers/boot.ts`).
- Name a `describe` after the function or feature under test. Start an `it` name with a present-tense verb and write it in plain English: `keeps a finding marked delete when the lookup throws`, not `should keep…`.
- A bug fix should come with a test that fails without the fix.
- Don't commit `.only`, `.skip` or placeholder tests.

## Docs

If users will notice the change, update `README.md`.

## Commits and pull requests

- Use [Conventional Commits](https://www.conventionalcommits.org/) with a short, one-line subject, for example `fix: keep the finding when the lookup throws` or `feat: add a Cloudinary adapter`. The release changelog is built from these.
- Keep each PR focused on one change. Open it against `main`, which holds `1.x` for Payload 4. The `0.x` branch (Payload 3) only takes critical and high-severity security fixes, which are cherry-picked from `main` where possible.
- Fill in the PR template: what changed, why, and how you tested it. Link the issue (`Closes #123`).
- CI must pass. It runs lint, format check, typecheck, the unit tests, the integration tests on SQLite and the build on Node 24 (`0.x`: Node 22 and 24).
- All review threads need to be resolved before merge.

## License

By contributing, you agree that your work is released under the [MIT License](LICENSE).
