# Janitor for Payload

Payload 4 plugin `@seshuk/payload-plugin-janitor`. Match storage against database, find documents nothing reference, in any listed collection, upload or not. Delete only what admin approve. Features: orphan/missing/unused findings, usage panel, delete guard, purge, Payload job or inline start, dashboard widget, storage adapters (`./s3`, `./r2`, `./gcs`, `./azure`, `./bunny`, `./uploadthing`, `./vercelBlob`, `./local`).

## Environment

- pnpm 12. Node.js 24.22.1+. Payload 4.
- Shared dev config from `@seshuk/payload-plugin-tooling` (oxlint, oxfmt, tsconfig, tsdown, CI/release workflows, changelog).
- Tests need no services: in-memory storage adapter, SQLite in memory, PGlite for Postgres, `mongodb-memory-server` for Mongo, `happy-dom` for components.

## Commands

```bash
pnpm typecheck        # tsc on src/ and tests/
pnpm lint             # oxlint; lint:fix
pnpm format           # oxfmt write; format:check to verify
pnpm test:unit        # tests/unit: no DB
pnpm test:int         # tests/integration: TEST_DB=sqlite|postgres|mongodb (default sqlite), BLOCKS_AS_JSON=1
pnpm test:all         # unit + int on sqlite, sqlite json, postgres, postgres json, mongodb
pnpm test:stress      # opt-in 100 000-object run (STRESS_SIZE scales down)
pnpm build            # tsdown -> dist/

pnpm dev:seed && pnpm dev   # dev admin, dev@example.com / dev, open media/1
pnpm dev:generate-importmap # after adding or renaming client component
```

Gate: `pnpm typecheck && pnpm lint && pnpm format:check && pnpm test:all && pnpm build`. Change under `src/server/usage/` must pass all five DB runs.

## Structure

```
src/
├── index.ts          # janitor(options), joins config.storage when set, every public export
├── shared/           # isomorphic leaf, imports nothing from server/client
│   ├── constants.ts  # PLUGIN_NAME, default slugs, endpoints path, min age, widget slug
│   ├── types/        # options.ts (public JSDoc API), resolved.ts, storage.ts (adapter contract), index.ts (wire shapes)
│   └── translations/ # index.ts (label(), title()), locales/<code>.ts, en.ts = source of keys
├── adapters/         # one provider per file, one package entry each; lookup.ts = shared `keys` lookup
├── client/           # 'use client' entry: JanitorMenu/, FindingFields/, Bytes/, FieldHighlight/, UsagePanel/ (one folder per component), findingData, usageData
├── rsc/              # server components: JanitorWidget/ (widget, .css, .utils.ts = lastScan)
└── server/
    ├── options/      # resolveOptions.ts (defaults, startup throws, cleanPrefix, storedPrefix), validateRuntime.ts
    ├── collections/  # findings, runs, upload (panel + delete guard), usageField
    ├── usage/        # index (dispatch, usageDetail), sql, catalog (mayHold), candidates, paths, walk, relational, mongo, hits
    ├── scan.ts       # walk collections, list storage, write findings, dropResolved, isHeld, heartbeat
    ├── purge.ts      # purgeApproved: re-check, look up, delete or trash, set purgedBy
    ├── run.ts        # Payload task, runJanitor lock, stale runs (30 min by heartbeatAt), startJanitor
    ├── endpoints.ts  # POST scan, POST purge, GET usage/:collection/:id
    ├── openapi.ts    # custom.openapi operations for the three endpoints
    ├── tenants.ts    # hasTenantField, tenantIdsOf, sameTenants, seesAllTenants, tenantScope (memoized per req)
    └── telemetry.ts  # buildFeatures (which options set), reportJanitorTelemetry
tests/
├── vitest.config.ts  # projects: unit, int (globalSetup only for int)
├── unit/             # mirror src/ layout, not every file has spec (happy-dom for components)
├── integration/      # *.int.spec.ts: boot, client, plugin, scan, start, tenants, usage, stress
├── helpers/          # boot.ts (private Payload per spec on TEST_DB), pglite.ts, dom.ts, ui.ts (@payloadcms/ui mock, render), storage.ts (adapter fakes, contract), options.ts, collections.ts, usage.ts (unit fixtures)
└── payload.config.ts, collections/, app/, seed.ts, devSeed.ts, memoryAdapter.ts   # shared test app + dev admin
```

## Architecture

- **Human decide, plugin never.** Scan write findings only. Only `purgeApproved` delete, only findings with status `delete`, re-check facts right before delete. Failed re-check → `keep` with note. Object already gone → `deleted`, no `freedBytes`. `missing` never deletable.
- **Orphan purge:** key inside prefix, no document or version hold it, looked up alone (`list({ keys: [key] })`; throw → finding stay `delete`, error in report), older than `minAge`.
- **Unused purge:** document exist, `createdAt` equal finding `uploadedAt` (id reuse), not trashed, `updatedAt` older than `minAge`, not used, no other document hold same file.
- **Purge pass own guard:** `payload.delete` carry `context[PLUGIN_NAME] = { collection, id }`, guard skip only that document. Guard follow `references.versions`, count every place, name only places deleting `req.user` may read (system access without user); none readable → collection names.
- **Finding key is pair** (`collectionSlug`, `objectKey`). Non-upload `unused` key `<slug>/<id>`. Upsert and drop match on pair.
- **Rescan never overwrite human decision.** Upsert update facts only, never `note`, `keep`, `delete`. Back to `found` only when kind or `documentId` change, or `deleted` seen again. `dropResolved` drop only `found` not seen again, only for (kind, collection) checked. Young items count as seen. Admin write only `status`, `note`.
- **No document cache.** Everything paged: `eachPage`, `eachVersion` (keyset by id), adapter pages. Upsert and drop per 500. `heartbeat` at most once per minute, also inside `buildUsageIndex({ onProgress })`.
- **Explicit listing only.** Nothing watched unless under `collections`. `true` = every check collection can have. `endpoints: false` → `usagePanel` off; explicit `usagePanel` without endpoints throw.
- **Key come from storage plugin, never guessed.** Prefix from `prefix` field default (`storedPrefix`). Non-empty `config.storage` → janitor add itself last to `storage` and resolve in its `init`, after every adapter. Storage plugin in `plugins` must go before janitor; `validateRuntime` throw on wrong order unless `prefix` passed. Empty default under `orphans`/`missing` → throw (`ambiguous`); explicit `prefix` there without `compositePrefixes` → throw (`notComposite`). Composite: `prefix/<doc prefix>/<_objectKey>/<filename>`. Unknown prefix → compare by key tail. Rewritten doc prefix (`isRewritten`) → match by file name. `unused` on `timestamps: false` → throw.
- **Storage is interface.** `list` and `delete` only, contract in `shared/types/storage.ts`. Contract grow by fields, never arguments. `list` walk whole prefix or throw; truncated page without cursor → throw. `delete` resolve when object gone. Nested prefixes on one adapter throw at startup, except `perCollection`.
- **Resolve options once.** Defaults and startup throws in `resolveOptions`, runtime checks in `validateRuntime`. Downstream take `ResolvedOptions`.
- **`enabled: false` keep schema.** Both collections (hidden) + `janitor-run` task with no-op handler stay. No endpoints, guard, panel, admin UI, `custom`, `onInit`.
- **Access per action.** `access` resolve to `{ read, approve, scan, purge }`. Collections: `read` → read, `approve` → update/delete. Routes: scan → `scan`, purge → `purge` + target collection `access.delete` must return `true` for every watched collection with `delete` findings, usage → `read` + `findByID` with user access (else 404) + `readableHits` filter before limit. `startJanitor`/`runJanitor`/`purgeApproved` skip access.
- **`jobs`: `false` inline, object queues.** `false` (default) run inline. Object queue on `queue` (default `'default'`); `schedule` cron go on task `schedule: [{ cron, queue }]`. No custom start function: own code call `startJanitor`/`runJanitor`.
- **`tenants` scope findings.** `missing`/`unused` copy document tenant field (relationship to tenants collection, `hasTenantField`); orphans and unscoped collections none. Sees every tenant = tenants collection `read` returns `true`. Others: findings read/update/delete AND `{ tenant: { in } }`, no tenant-less findings, no runs, no widget, scan/purge 403. Rescan reset to `found` when stored tenant set non-empty and differ. Unused purge re-check tenant set, differ → `keep` with note.
- **`admin.group: false` keep routes.** Pass `group: false` through. `hidden: true` only for `admin: false` (widget link need routes).
- **Overrides = `CollectionOverride`.** Slug from `overrides.x.slug` before build (collections reference each other). Merge `access`/`admin`/`labels` one level, `fields({ defaultFields })`.
- **Usage read database, not config.** FK (`pg_constraint`, `pragma_foreign_key_list`), `_rels`, JSON, blocks, rich text, globals, versions, Mongo candidate fields. Relationship field without visible FK → throw. Structural FK (`isStructural`) not reference. Suffixes from adapter. JSON column read only when `mayHold`. Number columns never read. SQLite blob read raw, never `CAST`. `MAX_DEPTH` 128, deeper fail closed. Identifiers through `quote()`, values through placeholders.
- **Conservative by direction.** Unsure → «used». Unsure answer = `janitor:` throw or `null` index, never empty list. Callers never read throw as «unused».

## Coding rules

- No code comments. Only JSDoc on plugin options types (`src/shared/types/options.ts`).
- Imports end in `.js`. `@/` (= `src/`) for any import that leave folder, `./x.js` only in same folder, no `../`. Tests import source through `@/`.
- Query from hook pass `req.transactionID`: second connection deadlock single-connection DB.
- Local API always explicit `overrideAccess`: plugin work `true`, on behalf of user `false` plus `user`. `_objectKey` reads need `showHiddenFields: true`.
- Admin CSS plain, Payload 4 tokens only (`--color-*`, `--spacer-*`, `--radius-*`).
- Translations: Payload plural pick `_one` = 1, `_two` = 2, `_few` 3–5, `_many` > 5; string must not make count agree.
- Match surrounding naming and idiom.

## Testing

- `tests/unit/` mirror `src/` layout: spec sit at its source file path, but not every file has one. No spec for types, constants, locales, barrels. DB-bound code (`scan`, `purge`, `endpoints`, `usage/` sql, relational, mongo, catalog) tested in `tests/integration/`. `tests/unit/`: no DB, no globalSetup. `tests/integration/*.int.spec.ts`: own Payload per spec via `boot()`, `versions: false` unless spec set it.
- `describe` = function or feature; `it` = present-tense verb, plain English, never `should …`.
- Bug fix come with test that fail without fix. No `.only`, `.skip`, placeholder tests.

## Docs

- User-facing change: update `README.md`.

## Branches

| Branch | Major | Payload | Node     | Takes                                                                                    |
| ------ | ----- | ------- | -------- | ---------------------------------------------------------------------------------------- |
| `main` | 1.x   | 4       | 24.22.1+ | all work; PRs target `main`                                                              |
| `0.x`  | 0.x   | 3       | 22+      | critical and high-severity security fixes only, cherry-picked from `main` where possible |

## Releases

- Bump `version`, `.github/releases/vX.Y.Z.md` for new major and its first prerelease, commit `chore(release): vX.Y.Z`, tag `vX.Y.Z`.
- Tag push run tooling release workflow: checks, git-cliff notes, GitHub Release, npm publish (OIDC; `NPM_TOKEN` first publish only). Dist-tag: prerelease id, `latest` for newest major, `latest-<major>` for older.
- Tags `v*` never move. Bad release = new version. Never publish by hand.

## Commits

- One-line Conventional Commit. Release notes come from these.
- No co-authored-by or other trailers.
- Commit locally. Push only when asked.

## Boundaries

Ask first: new runtime dependency (adapters take already-built client), public API change, large refactor.

Never: delete storage object or document outside `purgeApproved`; splice unvalidated identifier into SQL; secrets in repo; push or destructive git without request; edit `dist/` by hand.
