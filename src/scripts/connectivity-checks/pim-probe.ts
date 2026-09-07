/**
 * PIM connectivity probe.
 *
 * Answers three questions about the AtroPIM instance configured in `.env`,
 * without starting Vendure and without changing anything:
 *
 *   1. Is the PIM host reachable from wherever this is run?
 *   2. Do PIM_USER / PIM_PASSWORD authenticate against it?
 *   3. How large is the catalogue a full sync would pull?
 *
 * Deliberately standalone — it does NOT bootstrap Vendure, unlike the other
 * scripts in this folder. That is the point: it still works when the server
 * will not boot, which is exactly when connectivity is in question. Run it on
 * the production VM after a deploy to prove that host can reach the PIM.
 *
 * Safety: GET requests only. Writes nothing to the PIM and nothing to Vendure.
 * Never prints the password or the session token.
 *
 *   npm run check:pim
 *
 * Exit codes: 0 = all checks passed, 1 = a check failed, 2 = .env incomplete.
 */
import * as dotenv from 'dotenv';

dotenv.config();

const TIMEOUT_MS = 20_000;

/** Entity types worth counting before committing to a full sync. */
const CATALOGUE_ENTITIES = ['Product', 'Category', 'Attribute', 'ProductFile'] as const;

interface PimListResponse {
    total?: number;
}

/**
 * Flags characters that commonly survive a copy-paste into `.env` but change the
 * value dotenv actually produces — the usual explanation for "it works in the
 * browser but 401s here". Reports the character classes present, never the value.
 */
function describeValueRisks(value: string): string {
    const risks: string[] = [];
    if (/\s/.test(value)) risks.push('whitespace');
    if (value.includes('#')) risks.push("'#' — dotenv may treat it as a comment unless the value is quoted");
    if (value.includes('$')) risks.push("'$'");
    if (/^["'].*["']$/.test(value)) risks.push('surrounding quotes — these are stripped, so they are not part of the password');
    return risks.length ? ` — contains ${risks.join(', ')}` : '';
}

async function getWithTimeout(url: string, headers: Record<string, string>): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
        return await fetch(url, { headers, signal: controller.signal });
    } finally {
        clearTimeout(timer);
    }
}

/**
 * Runs after a failed authentication to separate the plausible causes, which look
 * identical from a bare 401:
 *
 *  - wrong API base — AtroCore moved its REST API under `/api/v1/` in later
 *    versions, while pim-sync assumes `/api/`. A newer PIM makes every path wrong.
 *  - the `Authorization-Token-Only` headers — an AtroCore extension. An instance
 *    that does not honour them can reject a request plain Basic auth would accept.
 *  - the account genuinely lacking API access, which is the one case that looks
 *    like working browser credentials but fails everywhere here.
 *
 * A 404 means the path is wrong; a 401 means the path is right and the credentials
 * are not being accepted on it.
 */
async function diagnoseAuthFailure(pimUrl: string, credential: string): Promise<void> {
    console.error('   Narrowing down the cause...\n');

    const tokenOnlyHeaders: Record<string, string> = {
        Authorization: `Basic ${credential}`,
        'Authorization-Token-Only': 'true',
        'Authorization-Token-Lifetime': '0',
        'Authorization-Token-Idletime': '0',
    };
    const plainBasicHeaders: Record<string, string> = { Authorization: `Basic ${credential}` };

    const attempts: Array<{ label: string; path: string; headers: Record<string, string> }> = [
        { label: '/api/userSession + token headers  (what pim-sync does)', path: '/api/userSession', headers: tokenOnlyHeaders },
        { label: '/api/userSession + plain Basic', path: '/api/userSession', headers: plainBasicHeaders },
        { label: '/api/v1/userSession + token headers', path: '/api/v1/userSession', headers: tokenOnlyHeaders },
        { label: '/api/v1/userSession + plain Basic', path: '/api/v1/userSession', headers: plainBasicHeaders },
        { label: '/api/App/user + plain Basic', path: '/api/App/user', headers: plainBasicHeaders },
        { label: '/api/v1/App/user + plain Basic', path: '/api/v1/App/user', headers: plainBasicHeaders },
    ];

    for (const attempt of attempts) {
        try {
            const res = await getWithTimeout(`${pimUrl}${attempt.path}`, attempt.headers);
            const marker = res.ok ? 'OK  ' : '    ';
            console.error(`   ${marker}HTTP ${res.status}  ${attempt.label}`);
        } catch (err: unknown) {
            console.error(`         ERROR  ${attempt.label} — ${(err as Error).message}`);
        }
    }

    // Server-identifying headers from an unauthenticated request often name the
    // product and version, which tells us which API layout to expect.
    try {
        const res = await getWithTimeout(`${pimUrl}/api/userSession`, {});
        const interesting = ['server', 'www-authenticate', 'x-powered-by'];
        const found = interesting
            .map(h => [h, res.headers.get(h)] as const)
            .filter((pair): pair is readonly [string, string] => pair[1] !== null);
        if (found.length) {
            console.error('\n   Server response headers:');
            for (const [name, value] of found) {
                console.error(`     ${name}: ${value}`);
            }
        }
    } catch {
        // Reachability already passed, so a failure here adds nothing.
    }

    console.error('\n   How to read this:');
    console.error('     any line OK      -> the PIM works, pim-api.service.ts needs that path/headers');
    console.error('     all 404          -> wrong API base, or not an AtroPIM/AtroCore instance');
    console.error('     all 401          -> the path is right; this account is refused over the API.');
    console.error('                         Most likely it lacks API access in the PIM, even though');
    console.error('                         it can log into the web UI. Check the user in the PIM admin');
    console.error('                         panel, or ask for an integration user with API access.');
}

async function probe(): Promise<number> {
    const pimUrl = (process.env.PIM_URL ?? '').replace(/\/$/, '');
    const pimUser = process.env.PIM_USER ?? '';
    const pimPassword = process.env.PIM_PASSWORD ?? '';

    const missing = [
        !pimUrl && 'PIM_URL',
        !pimUser && 'PIM_USER',
        !pimPassword && 'PIM_PASSWORD',
    ].filter(Boolean);

    if (missing.length) {
        console.error(`Missing in .env: ${missing.join(', ')}`);
        return 2;
    }

    console.log(`PIM_URL      : ${pimUrl}`);
    console.log(`PIM_USER     : ${pimUser}`);
    console.log(`PIM_PASSWORD : (${pimPassword.length} chars)${describeValueRisks(pimPassword)}`);
    console.log('');

    // 1 — reachability. An unauthenticated call is enough to prove DNS, TLS and
    // firewall; a 401 here is a pass, not a failure.
    console.log('1. Reachability');
    try {
        const res = await getWithTimeout(`${pimUrl}/api/userSession`, {});
        console.log(`   reached — HTTP ${res.status}\n`);
    } catch (err: unknown) {
        const e = err as Error;
        console.error(`   FAILED — ${e.name}: ${e.message}`);
        console.error('   Host unreachable from this machine (DNS, firewall, TLS or timeout).');
        console.error('   If it is reachable from the VM but not here, run the sync on the VM.');
        return 1;
    }

    // 2 — authentication. Mirrors pim-api.service.ts authenticate() exactly, so a
    // pass here means the plugin will authenticate too.
    console.log('2. Authentication');
    const credential = Buffer.from(`${pimUser}:${pimPassword}`).toString('base64');
    const authRes = await getWithTimeout(`${pimUrl}/api/userSession`, {
        Authorization: `Basic ${credential}`,
        'Authorization-Token-Only': 'true',
        'Authorization-Token-Lifetime': '0',
        'Authorization-Token-Idletime': '0',
    });
    const rawBody = await authRes.text();

    if (!authRes.ok) {
        console.error(`   FAILED — HTTP ${authRes.status}`);
        console.error(`   ${rawBody.slice(0, 300)}\n`);
        await diagnoseAuthFailure(pimUrl, credential);
        return 1;
    }

    let token: string | undefined;
    try {
        token = (JSON.parse(rawBody) as { authorizationToken?: string }).authorizationToken;
    } catch {
        console.error('   FAILED — response was not JSON.');
        console.error('   This may not be an AtroPIM instance; pim-sync speaks AtroPIM only.');
        console.error(`   ${rawBody.slice(0, 300)}`);
        return 1;
    }

    if (!token) {
        console.error('   FAILED — no authorizationToken in the response.');
        console.error(`   ${rawBody.slice(0, 300)}`);
        return 1;
    }
    console.log('   OK — session token received\n');

    // 3 — catalogue size, so the scale of a full sync is known before triggering one.
    console.log('3. Catalogue size');
    const authHeader = { Authorization: `Basic ${token}` };
    let failures = 0;

    for (const entity of CATALOGUE_ENTITIES) {
        const label = entity.padEnd(12);
        try {
            const res = await getWithTimeout(`${pimUrl}/api/${entity}?maxSize=1`, authHeader);
            if (!res.ok) {
                console.log(`   ${label}: HTTP ${res.status}`);
                failures++;
                continue;
            }
            const data = JSON.parse(await res.text()) as PimListResponse;
            console.log(`   ${label}: ${data.total ?? 'unknown'} records`);
        } catch (err: unknown) {
            console.log(`   ${label}: ERROR ${(err as Error).message}`);
            failures++;
        }
    }

    console.log(
        failures === 0
            ? '\nAll checks passed. Nothing was written to the PIM or to Vendure.'
            : `\n${failures} entity check(s) failed — auth works but some endpoints did not respond.`,
    );
    return failures === 0 ? 0 : 1;
}

if (require.main === module) {
    // Set exitCode rather than calling process.exit(): forcing an exit while Node's
    // fetch still holds an open socket trips a libuv assertion on Windows
    // ("!(handle->flags & UV_HANDLE_CLOSING)"). Letting the event loop drain
    // avoids that noise, and the exit code is still honoured.
    probe()
        .then(code => {
            process.exitCode = code;
        })
        .catch((err: unknown) => {
            const e = err as Error;
            console.error(`Probe crashed: ${e.message}`);
            console.error(e.stack);
            process.exitCode = 1;
        });
}
