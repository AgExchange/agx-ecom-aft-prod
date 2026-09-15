# agx-aft-vendure

This project was generated with [`@vendure/create`](https://github.com/vendurehq/vendure/tree/master/packages/create).

Useful links:

- [Vendure docs](https://www.vendure.io/docs)
- [Vendure Discord community](https://www.vendure.io/community)
- [Vendure on GitHub](https://github.com/vendurehq/vendure)
- [Vendure plugin template](https://github.com/vendurehq/plugin-template)

## Directory structure

* `/src` contains the source code of your Vendure server. All your custom code and plugins should reside here.
* `/static` contains static (non-code) files such as assets (e.g. uploaded images) and email templates.

## Environments

There are two environments, and every npm script names the one it uses. `src/load-env.ts`
resolves which file to read:

| Order | File | When |
| --- | --- | --- |
| 1 | `$ENV_FILE` | Set explicitly by the npm scripts, or exported by hand |
| 2 | `.env.production` / `.env.development` | Chosen by `NODE_ENV` |
| 3 | `.env` | Plain fallback — this is the production file on the VM |

Variables already set in the real environment are never overwritten by the file, so a
systemd unit or a container `-e` flag still wins.

Nothing under `.env*` is committed. `.env.example` is the template for both:

```bash
cp .env.example .env.development
```

Three plugins — `dsv-shipping-plugin`, `dsv-sadc-plugin` and `dpo-plugin` — validate their
options and **throw at startup** if values are missing. That is deliberate (a misconfigured
deploy fails loudly rather than silently at payment time), but it means a missing env file
shows up as a plugin stack trace. The loader prints `[env] loaded <file>` on every start;
check that line first.

## Development

Requires Docker Desktop for the local Postgres.

```bash
docker compose up -d database
```

This starts `agx-aft-postgres-dev` (postgres:18.2-alpine, pinned to match production) with
database `agx_aft_dev` on port 5432, matching the defaults in `.env.example`. If something
else already owns 5432, change the host side of the port mapping in `docker-compose.yml` and
`DB_PORT` to match.

Then:

```bash
npm run dev
```

starts the Vendure server, [worker](https://www.vendure.io/docs/developer-guide/vendure-worker/)
and Dashboard against `.env.development`. Pending migrations in `src/migrations/` are applied
automatically on start by `runMigrations()` in [src/index.ts](./src/index.ts), so a fresh
database needs no extra command.

| What | Where |
| --- | --- |
| Shop API | http://localhost:3000/shop-api |
| Admin API | http://localhost:3000/admin-api |
| Dashboard | http://localhost:3000/dashboard |
| GraphiQL | http://localhost:3000/graphiql |
| Dev mailbox | http://localhost:3000/mailbox |

Sign in with the `SUPERADMIN_USERNAME` / `SUPERADMIN_PASSWORD` from your env file.

Individual processes: `npm run dev:server`, `npm run dev:worker`, `npm run dev:dashboard`.

## Build

```bash
npm run build       # against .env.development
npm run build:prod  # against .env.production, with NODE_ENV=production
```

compiles the TypeScript sources and builds the Dashboard into `/dist`.

The build needs an env file loaded, not just the runtime: the Dashboard build introspects
`vendure-config.ts`, which is where the DSV and DPO plugins validate their options.

`NODE_ENV=production` also switches the Dashboard's API target from an explicit
`http://localhost:3000` to `auto` (see [vite.config.mts](./vite.config.mts)), so it derives
the API URL from whatever server serves it. Use `build:prod` for anything deployed.

`dist/dashboard/` is not emptied between builds — `rm -rf dist/dashboard` first if stale
chunks would confuse you.

## Production

On the VM: clone the repo, create the env file by hand, then build and start.

```bash
cp .env.example .env      # then fill in real values
npm ci
npm run build:prod
npm run start:prod
```

`start:prod` sets `NODE_ENV=production`, so the loader looks for `.env.production` and falls
back to `.env`. Either filename works.

Server and worker can be run as separate processes, which is what you want under a process
manager like [pm2](https://pm2.keymetrics.io/):

```bash
npm run start:prod:server
npm run start:prod:worker
```

### Maintenance scripts

`export:variants`, `export:low-stock` and `check:pim` deliberately do **not** pin an
environment, so an ambient `ENV_FILE` retargets them:

```powershell
$env:ENV_FILE='.env.production'; npm run check:pim; Remove-Item Env:\ENV_FILE
```

```bash
ENV_FILE=.env.production npm run check:pim
```

### Using Docker

We've included a sample [Dockerfile](./Dockerfile) which you can build with the following command:

```
docker build -t vendure .
```

This builds an image and tags it with the name "vendure". We can then run it with:

```
# Run the server
docker run -dp 3000:3000 -e "DB_HOST=host.docker.internal" --name vendure-server vendure npm run start:prod:server

# Run the worker
docker run -dp 3000:3000 -e "DB_HOST=host.docker.internal" --name vendure-worker vendure npm run start:prod:worker
```

Note that `host.docker.internal` only exists in a Docker Desktop environment and so should only
be used in development. Env values passed with `-e` take precedence over the file, which is
how you override individual settings without rebuilding.

## Plugins

In Vendure, your custom functionality will live in [plugins](https://www.vendure.io/docs/plugins/).
These should be located in the `./src/plugins` directory.

To create a new plugin run:

```
npx vendure add
```

and select `[Plugin] Create a new Vendure plugin`.

## Migrations

[Migrations](https://www.vendure.io/docs/developer-guide/migrations/) allow safe updates to the database schema. Migrations
will be required whenever you make changes to the `customFields` config or define new entities in a plugin.

To generate a new migration, run:

```
npx vendure migrate
```

This runs outside the npm scripts, so it gets the loader's default: `.env.development`,
or `.env` if that does not exist. Prefix it with `ENV_FILE` to target another database.
See [docs/project-overview.md](./docs/project-overview.md) for the `mpn` index drift that
affects every generated migration.

The generated migration file will be found in the `./src/migrations/` directory, and should be committed to source control.
Next time you start the server, and outstanding migrations found in that directory will be run by the `runMigrations()`
function in the [index.ts file](./src/index.ts).

If, during initial development, you do not wish to manually generate a migration on each change to customFields etc, you
can set `dbConnectionOptions.synchronize` to `true`. This will cause the database schema to get automatically updated
on each start, removing the need for migration files. Note that this is **not** recommended once you have production
data that you cannot lose.

---

You can also run any pending migrations manually, without starting the server via the "vendure migrate" command.

---

## Troubleshooting

### Error: Could not load the "sharp" module using the \[OS\]-x\[Architecture\] runtime when running Vendure server.

- Make sure your Node version is ^18.17.0 || ^20.3.0 || >=21.0.0 to support the Sharp library.
- Make sure your package manager is up to date.
- **Not recommended**: if none of the above helps to resolve the issue, install sharp specifying your machines OS and Architecture. For example: `pnpm install sharp --config.platform=linux --config.architecture=x64` or `npm install sharp --os linux --cpu x64`
