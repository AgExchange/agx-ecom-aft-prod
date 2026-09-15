# agx-aft-vendure Project Instructions

This project was generated with `@vendure/create`.

## Project Layout

- Custom backend code belongs in `src/plugins`
- Runtime configuration is in `src/vendure-config.ts`
- Static assets and email templates live in `static`

## Vendure Development

- Prefer implementing custom functionality as a Vendure plugin.
- Use `npx vendure add` to scaffold plugins, entities, services, API extensions, and job queues.
- Read environment variables in `vendure-config.ts` and pass values into plugins through `Plugin.init()` options.
- Do not add `dotenv` calls to new entry points; import `src/load-env.ts` instead.
- Create job queues in `onModuleInit()` or `onApplicationBootstrap()`, then reuse the queue when adding jobs.
- Pass `RequestContext` to Vendure services and `TransactionalConnection` methods when it is available.
- Do not commit any `.env*` file or generated runtime data. `.env.example` is the only committed template.
- Do not use `dbConnectionOptions.synchronize: true` for production data.

## Environments

Two env files, never committed. `src/load-env.ts` chooses one: `ENV_FILE` if set, else
`.env.production` when `NODE_ENV=production` and `.env.development` otherwise, else plain
`.env`. Every npm script names its environment via `cross-env`, so use the scripts rather
than invoking `vendure` or `node dist/...` directly.

## Commands

- Start development: `npm run dev` (needs `docker compose up -d database` first)
- Build for dev: `npm run build`
- Build for production: `npm run build:prod`
- Start production: `npm run start:prod` (or `start:prod:server` / `start:prod:worker`)

The build loads an env file too, not just the runtime — the Dashboard build evaluates
`vendure-config.ts`, where `dsv-shipping-plugin`, `dsv-sadc-plugin` and `dpo-plugin` throw on
missing options.

## Quality Checks

- Run `npm run build` after changing backend code.
- Run targeted tests for the package or feature you changed.
