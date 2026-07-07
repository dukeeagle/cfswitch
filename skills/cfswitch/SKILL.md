---
name: cfswitch
description: Switch Cloudflare/wrangler auth between multiple Cloudflare accounts using the cfswitch CLI (named token profiles injected as CLOUDFLARE_API_TOKEN/CLOUDFLARE_ACCOUNT_ID). Use whenever running wrangler, deploying Workers/Pages, or calling the Cloudflare API for a specific account — e.g. "deploy to my work account", "switch cloudflare accounts", "wrangler whoami for staging", "which CF account am I using". Never run bare wrangler when the target account matters.
---

# cfswitch — multi-account Cloudflare auth

`cfswitch` is a global CLI that stores named Cloudflare auth profiles and injects them per-process as `CLOUDFLARE_API_TOKEN` / `CLOUDFLARE_ACCOUNT_ID` (which wrangler honors over any OAuth login). It never prompts; every command is non-interactive, with `--json` variants and real exit codes. If it's not installed: `npm install -g cfswitch`.

## Rules

1. **Never run bare `wrangler`** when the target account matters — always `cfswitch wrangler -p <profile> …` or `cfswitch exec -p <profile> -- <cmd>`.
2. Discover profiles first: `cfswitch list --json` (fields: `name`, `auth`, `accountId`, `note`, `isDefault`). If a profile is pinned to an account id, wrangler never hits "more than one account available"; if it isn't and that error appears, see rule 6.
3. Before deploying to an unfamiliar profile: `cfswitch verify <name>` (exit 1 = revoked/expired token — ask the user for a fresh one, don't retry) and confirm identity with `cfswitch wrangler -p <name> whoami`.
4. For raw Cloudflare API calls, get credentials from `cfswitch env <name> --json` (keys `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`).
5. Adding/rotating tokens: pipe, never argv — `printf '%s' "$TOKEN" | cfswitch add <name> --token-stdin --account-id <id>`. Re-adding a name updates it in place. Never print token values.
6. If a token reaches several accounts, list them with `cfswitch accounts <name> --json` and pin the right one by re-adding with `--account-id`.
7. To pin a whole session/CI job to one account, set `CFSWITCH_PROFILE=<name>` and drop the `-p` flags.
8. No profiles configured at all → tell the user to run `cfswitch wizard` **themselves, in their own interactive terminal** — do NOT run it from your sandbox: it opens their browser and watches their clipboard, so it only makes sense on the user's machine with the user present. It opens a pre-filled token-creation page; when they copy the token, verified + pinned profiles are created automatically. If they want the link without the watcher (e.g. to open on another machine), give them `cfswitch wizard --print-url`. Manual fallback: create tokens at https://dash.cloudflare.com/profile/api-tokens and `cfswitch add`. Do not create or roll tokens yourself.

## Command crib

```bash
cfswitch list --json                          # profiles + account ids
cfswitch wrangler -p work deploy              # any wrangler cmd as that account
cfswitch wrangler -p work pages deploy out
cfswitch exec -p work -- <any command>        # env-injected arbitrary command
eval "$(cfswitch env work)"                   # export into current shell
cfswitch verify work --json                   # token still valid? (exit code matters)
cfswitch accounts work                        # account ids the token reaches
```

## Caveats

- Commands that hit the Cloudflare API (`verify`, `accounts`, `whoami`, deploys) need network access; in a network-blocked sandbox they fail with `fetch failed` while `list`/`env`/`exec` still work. Do discovery in-sandbox, deploys outside.
- A permission error (code 10000) on deploy means the token lacks a permission for that product (e.g. D1, Queues) — ask the user to add it to the token in the dashboard; the secret doesn't change when scope is edited.
