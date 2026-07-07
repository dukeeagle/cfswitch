# cfswitch

Switch Cloudflare / wrangler auth between multiple accounts — built for **AI agents and CI** first, humans second.

`wrangler login` only holds one OAuth session at a time. If you (or your coding agent) juggle several Cloudflare accounts, every deploy becomes a logout/login dance. `cfswitch` fixes this with named auth profiles that are injected as environment variables (`CLOUDFLARE_API_TOKEN` / `CLOUDFLARE_ACCOUNT_ID`) — which wrangler always honors over its OAuth login, per [Cloudflare's docs](https://developers.cloudflare.com/workers/wrangler/system-environment-variables/).

Design rules:

- **Never prompts.** Every command is fully non-interactive — safe to run from any agent, script, or CI job.
- **Zero runtime dependencies.** One bundled file, Node ≥ 18. `npx cfswitch` just works.
- **`--json` on every read command**, clean exit codes, errors on stderr.
- **Tokens are never printed** except by explicit `cfswitch env`.

## Install

```bash
npm install -g cfswitch     # or: bun add -g cfswitch
# or zero-install:
npx cfswitch help
```

## Quick start

Create an API token for each account at [dash.cloudflare.com/profile/api-tokens](https://dash.cloudflare.com/profile/api-tokens) (the **"Edit Cloudflare Workers"** template covers Workers + Pages deploys). Then:

```bash
# add profiles (token via flag, stdin, or CFSWITCH_TOKEN env — never a prompt)
cfswitch add personal --token cf_xxx --account-id 6f9x...
echo "$WORK_TOKEN" | cfswitch add work --token-stdin

# sanity-check them against the Cloudflare API
cfswitch verify work
cfswitch accounts work        # list account IDs this token can reach

# run wrangler as any account, from any directory
cfswitch wrangler -p personal whoami
cfswitch wrangler -p work deploy
cfswitch wrangler -p work pages deploy out

# or set a default and stop passing -p
cfswitch use work
cfswitch wrangler d1 list
```

## Commands

| Command | What it does |
|---|---|
| `add <name> --token <T> [--account-id <ID>] [--note <s>]` | Save/update a token profile. Also accepts `--token-stdin` or `$CFSWITCH_TOKEN`. |
| `login <name>` | OAuth alternative: runs `wrangler login` inside an **isolated config dir**, so multiple OAuth sessions coexist. |
| `list [--json]` | List profiles. Tokens are never shown. |
| `use <name>` | Set the default profile. |
| `current [--json]` | Show the active profile and where it came from. |
| `remove <name>` | Delete a profile (and its isolated OAuth state, if any). |
| `verify [<name>] [--json]` | Check the token against `/user/tokens/verify` (falls back to the account-scoped endpoint for account-owned tokens). Exit 1 if invalid. |
| `accounts [<name>] [--json]` | List account IDs the token can access — use this to find the right `--account-id`. |
| `env [<name>] [--json]` | Print `export` lines: `eval "$(cfswitch env work)"`. |
| `exec [-p <name>] -- <cmd> [args…]` | Run **any** command with the profile's env injected (wrangler, terraform, curl, …). |
| `wrangler [-p <name>] [args…]` | Run wrangler as the profile. Resolves local `node_modules/.bin/wrangler`, then PATH, then `npx wrangler`. |

**Profile resolution** for commands that take an optional name: explicit arg / `-p` → `$CFSWITCH_PROFILE` env var → default set via `use`. The env var makes it trivial to pin an agent session or CI job to one account.

## Why API tokens instead of switching OAuth logins?

Rewriting wrangler's global OAuth state (`~/.config/.wrangler/config/default.toml`) to "switch" accounts is racy — two concurrent agents would fight over one global file, and newer wrangler versions move OAuth creds into the OS keychain. Environment-variable injection is Cloudflare's documented CI path, is stateless per-process, and lets any number of concurrent processes each use a different account safely.

If you really want OAuth (e.g. no permission to create API tokens), `cfswitch login <name>` gives each profile its own `XDG_CONFIG_HOME` (with `CLOUDFLARE_AUTH_USE_KEYRING=false`), so sessions live side by side and never clobber your real wrangler login.

## Security

- Profiles live in `~/.config/cfswitch/profiles.json`, created `0600` in a `0700` dir.
- Prefer scoped tokens (per-account, minimum permissions, optional TTL/IP filters) over the Global API Key.
- `list`, `current`, `verify`, and `accounts` never output token values; only `env` does, and only because that's its job.

## For AI agents

See [AGENTS.md](./AGENTS.md) — a compact, copy-pasteable contract for coding agents (Claude Code, Cursor, Codex, …). Drop it into your project or point your agent at `npx cfswitch help`, which is written to be sufficient on its own.

## Prior art

Inspired by [cfman](https://github.com/novincode/cfman), which pioneered the named-token-→-env-injection pattern with a human-friendly interactive CLI. cfswitch is the agent-native reimagining: no prompts, no dependencies, JSON output, `exec`/`env` primitives, and isolated OAuth profiles.

## License

MIT
