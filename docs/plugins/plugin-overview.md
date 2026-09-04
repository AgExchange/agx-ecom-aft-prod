# Plugin documentation

One Markdown file per plugin, named after the plugin's source folder.

Each document records **what the plugin needs in order to work**, not just what it does.
The failure mode this folder exists to prevent is a plugin that compiles, registers
cleanly, and is silently wrong because a dependency outside its own folder was never
brought across — a custom field, a migration, a caller script, an env var.

## Index

| Plugin | Source | Status | Notes |
| --- | --- | --- | --- |
| [shipping-by-weight](./shipping-by-weight.md) | `src/plugins/shipping-by-weight/` | Ported, verified | Depends on Logistics custom fields |
| [product-info](./product-info.md) | `src/plugins/product-info/` | Ported, runtime check outstanding | Headless; driven by `src/scripts/export-*.ts` |
| [order-metadata-ui](./order-metadata-ui.md) | `src/plugins/order-metadata-ui/` | Ported, bundle confirmed | Dashboard UI extension; 14 OrderLine custom fields |
| [contact](./contact.md) | `src/plugins/contact/` | Ported, verified | REST controller; publishes `ContactUsEvent` → email |
| [cms](./cms.md) | `src/plugins/cms/` | Ported, structural only | Needs a Payload CMS instance to test |
| [pim-sync](./pim-sync.md) | `src/plugins/pim-sync/` | Ported, structural only | Needs AtroPIM. **Read the `mpn` index drift note before running `migrate -g`** |
| [quote-plugin](./quote-plugin.md) | `src/plugins/quote-plugin/` | Ported; creation verified, send/accept blocked | First plugin with an entity (`quote_sequence`) |
| [multivendor-plugin](./multivendor-plugin.md) | `src/plugins/multivendor-plugin/` | Ported, structural only | Replaces two core strategies. **Prime suspect for the checkout hang — read the doc** |
| [payfast-plugin](./payfast-plugin.md) | `src/plugins/payfast-plugin/` | Ported, structural only | RSA payments; needs a public host for ITN |
| [dsv-shipping-plugin](./dsv-shipping-plugin.md) | `src/plugins/dsv-shipping-plugin/` | Ported, structural only | Flattened from an npm package. **Contains a live production bug — read the doc** |
| [dsv-sadc-plugin](./dsv-sadc-plugin.md) | `src/plugins/dsv-sadc-plugin/` | Ported, structural only | Flattened from an npm package. SOAP/XML; pairs with dsv-sadc-ui |
| [dsv-sadc-ui](./dsv-sadc-ui.md) | `src/plugins/dsv-sadc-ui/` | Ported, bundle confirmed | Dashboard-only; useless without dsv-sadc-plugin |
| [dpo-plugin](./dpo-plugin.md) | `src/plugins/dpo-plugin/` | Ported, structural only | Non-RSA payments. 3 entities. From an unmerged branch; its test suite was excluded |

## What each document should cover

- **Summary** — what it does, in two sentences.
- **Files** — every file, with a one-line purpose.
- **Integration points** — what it pushes onto `VendureConfig`, what API it exposes,
  what jobs it registers, what entities it owns.
- **Dependencies** — npm packages, custom fields, other plugins, env vars, and
  anything outside the plugin folder that calls into it.
- **Migrations** — which migration files belong to this plugin, or an explicit
  "none required" with the reason.
- **Configuration** — how an admin sets it up once it's running.
- **Behaviour and edge cases** — especially anything that fails *silently*.
- **Verification** — the concrete checks that prove it works end to end.
- **Port notes** — how it was integrated in `agx-stores` and where this repo differs.

## Verification gotchas

**`dist/dashboard/` is not emptied between builds.** Old hashed chunks accumulate,
so grepping the output directory can return matches from a previous build and make
a removed extension look present. Always `rm -rf dist/dashboard` before running
`npm run build:dashboard` when the grep result is the thing you are trying to
prove.

**A successful dashboard build proves nothing on its own.** The Vite plugin scans
`vendure-config.ts` for plugins with a `dashboard` property — a plugin missing from
the array builds cleanly and silently contributes nothing. Grep the bundle for a
string only that extension could produce.
