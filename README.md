# cfswitch

Switch Cloudflare / wrangler auth between multiple accounts. Built for AI agents and CI first, humans second.

`wrangler login` only holds one OAuth session at a time. If you (or your coding agent) juggle several Cloudflare accounts, every deploy becomes a logout/login dance. `cfswitch` fixes this with named auth profiles injected as environment variables (`CLOUDFLARE_API_TOKEN` / `CLOUDFLARE_ACCOUNT_ID`), which wrangler always honors over its OAuth login, per [Cloudflare's docs](https://developers.cloudflare.com/workers/wrangler/system-environment-variables/).

Design rules:

- It never prompts. Every command is fully non-interactive, so any agent, script, or CI job can run it safely.
- No runtime dependencies. One bundled file, Node ≥ 18, so `npx cfswitch-cli` runs without installing anything.
- `--json` on every read command, clean exit codes, errors on stderr.
- Token values are only ever printed by `cfswitch env`, whose whole job is printing them.

## Install

```bash
npm install -g cfswitch-cli   # installs the `cfswitch` command (or: bun add -g cfswitch-cli)
# or zero-install:
npx cfswitch-cli help
```

## Quick start

### The wizard (easiest)

```bash
cfswitch wizard
```

This opens the Cloudflare dashboard with a pre-filled token (Workers, Pages, KV, R2, D1, routes) and watches your clipboard. You log in and click Continue to summary, Create Token, then Copy. The moment the token hits your clipboard, cfswitch verifies it, looks up which accounts it can reach, and saves a pinned profile for each. Switch dashboard accounts and repeat; Ctrl-C when done. Use `cfswitch wizard --print-url` if you just want the pre-filled URL (say, to open on another machine).

### Manual

Create an API token for each account at [dash.cloudflare.com/profile/api-tokens](https://dash.cloudflare.com/profile/api-tokens) (the **"Edit Cloudflare Workers"** template covers Workers + Pages deploys). Then:

```bash
# add profiles (token via flag, stdin, or CFSWITCH_TOKEN env; never a prompt)
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
| `wizard [--name <s>] [--print-url] [--no-browser]` | Guided setup: pre-filled dashboard URL + clipboard watch, then auto-created pinned profiles. |
| `add <name> --token <T> [--account-id <ID>] [--note <s>]` | Save/update a token profile. Also accepts `--token-stdin` or `$CFSWITCH_TOKEN`. |
| `login <name>` | OAuth alternative: runs `wrangler login` inside an **isolated config dir**, so multiple OAuth sessions coexist. |
| `list [--json]` | List profiles. Tokens are never shown. |
| `use <name>` | Set the default profile. |
| `current [--json]` | Show the active profile and where it came from. |
| `remove <name>` | Delete a profile (and its isolated OAuth state, if any). |
| `verify [<name>] [--json]` | Check the token against `/user/tokens/verify` (falls back to the account-scoped endpoint for account-owned tokens). Exit 1 if invalid. |
| `accounts [<name>] [--json]` | List account IDs the token can access; use this to find the right `--account-id`. |
| `env [<name>] [--json]` | Print `export` lines: `eval "$(cfswitch env work)"`. |
| `exec [-p <name>] -- <cmd> [args…]` | Run **any** command with the profile's env injected (wrangler, terraform, curl, …). |
| `wrangler [-p <name>] [args…]` | Run wrangler as the profile. Resolves local `node_modules/.bin/wrangler`, then PATH, then `npx wrangler`. |

Profile resolution for commands that take an optional name: explicit arg / `-p`, then the `$CFSWITCH_PROFILE` env var, then the default set via `use`. The env var lets you pin an agent session or CI job to one account.

## Why API tokens instead of switching OAuth logins?

Rewriting wrangler's global OAuth state (`~/.config/.wrangler/config/default.toml`) to "switch" accounts is racy: two concurrent agents would fight over one global file, and newer wrangler versions move OAuth creds into the OS keychain. Environment-variable injection is Cloudflare's documented CI path, is stateless per-process, and lets any number of concurrent processes each use a different account safely.

If you really want OAuth (e.g. no permission to create API tokens), `cfswitch login <name>` gives each profile its own `XDG_CONFIG_HOME` (with `CLOUDFLARE_AUTH_USE_KEYRING=false`), so sessions live side by side and never clobber your real wrangler login.

## Security

- Profiles live in `~/.config/cfswitch/profiles.json`, created `0600` in a `0700` dir.
- Prefer scoped tokens (per-account, minimum permissions, optional TTL/IP filters) over the Global API Key.
- `list`, `current`, `verify`, and `accounts` never output token values; only `env` does, and only because that's its job.

## For AI agents

There are three ways to teach an agent about cfswitch. Pick one.

### Claude Code plugin

This repo is its own plugin marketplace:

```
/plugin marketplace add dukeeagle/cfswitch
/plugin install cfswitch@cfswitch
```

### The skill installer (Claude Code, Codex, and Cursor at once)

The skill ships in [`skills/cfswitch/`](./skills/cfswitch/SKILL.md) and tells agents when and how to use cfswitch:

```bash
./install-skill.sh           # symlinks into ~/.agents/skills (hub, read by Cursor);
                             # ~/.claude/skills and ~/.codex/skills chain through it
./install-skill.sh --copy    # copy instead of symlink (survives deleting this repo)
./install-skill.sh --uninstall
```

The installer never clobbers an existing real directory at any of those paths, and re-running it is idempotent.

### Just the contract

[AGENTS.md](./AGENTS.md) is a compact, copy-pasteable ruleset. Drop it into your project, or point your agent at `npx cfswitch-cli help`, which is written to be sufficient on its own.

## Prior art

[cfman](https://github.com/novincode/cfman) had the core idea first: store named tokens, inject them as env vars. cfswitch rebuilds that idea for agents, adding JSON output, `exec`/`env` primitives, the token wizard, isolated OAuth profiles, and a no-prompts guarantee.

## License

MIT
