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
| [order-metadata-ui](./order-metadata-ui.md) | `src/plugins/order-metadata-ui/` | Ported, verified | Dashboard UI extension; 14 OrderLine custom fields |
| [contact](./contact.md) | `src/plugins/contact/` | Ported, verified | REST controller; publishes `ContactUsEvent` → email |

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
