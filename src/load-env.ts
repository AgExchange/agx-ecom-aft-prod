/**
 * Environment file loader.
 *
 * Every entry point that reads `process.env` — `vendure-config.ts`, and the
 * standalone scripts under `src/scripts/` — imports this module first, so there
 * is exactly one place that decides which file the values came from.
 *
 * Resolution order, first file that exists wins:
 *
 *   1. `ENV_FILE`  — set explicitly by the npm scripts, or exported by hand to
 *                    point a maintenance script at another environment.
 *   2. `.env.production` when NODE_ENV=production, otherwise `.env.development`.
 *   3. `.env`      — plain fallback. This is the production file on the VM: clone
 *                    the repo, hand-write `.env`, run `npm run start:prod`.
 *
 * Variables already present in `process.env` are NOT overwritten. A real
 * environment variable (systemd unit, container `-e` flag) therefore beats the
 * file, which is the behaviour a deployment expects.
 *
 * Paths resolve against `process.cwd()` rather than `__dirname`: the dashboard
 * build loads `vendure-config.ts` through Vite (see `vite.config.mts`), where
 * `__dirname` is not dependable. Every npm script runs from the project root.
 */
import * as fs from 'fs';
import * as path from 'path';

import * as dotenv from 'dotenv';

/** Candidate filenames, highest precedence first. Empty entries are skipped. */
const candidates = [
    process.env.ENV_FILE,
    process.env.NODE_ENV === 'production' ? '.env.production' : '.env.development',
    '.env',
].filter((name): name is string => !!name);

const loaded = candidates
    .map(name => path.resolve(process.cwd(), name))
    .find(fullPath => fs.existsSync(fullPath));

/**
 * The env file that was actually loaded, relative to the project root, or
 * `undefined` if none was found. Exported so error messages can name the file
 * the reader needs to edit rather than guessing at `.env`.
 */
export const loadedEnvFile = loaded ? path.relative(process.cwd(), loaded) : undefined;

if (loaded) {
    // `quiet` suppresses dotenv 17's own banner, leaving the one line below as
    // the single statement of which file is in play.
    dotenv.config({ path: loaded, quiet: true });
    // Deliberately console rather than Vendure's Logger: this runs before the
    // Vendure application — and therefore its logger — exists.
    console.log(`[env] loaded ${loadedEnvFile}`);
} else {
    // Worth shouting about. Without an env file the DSV and DPO plugins throw
    // during config evaluation, and that stack trace does not mention env files
    // at all — it just looks like a broken plugin.
    console.warn(
        `[env] no environment file found. Looked for: ${candidates.join(', ')} ` +
            `(in ${process.cwd()}). Copy .env.example and fill it in.`,
    );
}
