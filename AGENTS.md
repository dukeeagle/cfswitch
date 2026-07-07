# cfswitch — agent contract

`cfswitch` manages multiple Cloudflare auth profiles and injects them as `CLOUDFLARE_API_TOKEN`/`CLOUDFLARE_ACCOUNT_ID` when running wrangler or any other command. It never prompts; every command is safe to run non-interactively.

## Rules

1. **Never run bare `wrangler` when multiple Cloudflare accounts are in play.** Always go through `cfswitch wrangler -p <profile> …` or `cfswitch exec -p <profile> -- …` so the right account is explicit.
2. **Discover profiles with `cfswitch list --json`.** Fields: `name`, `auth` (`token`|`oauth`), `accountId`, `note`, `isDefault`.
3. **Before a deploy to an unfamiliar profile, run `cfswitch verify <name> --json`** (exit 0 + `"valid": true` means the token is active) and confirm the account with `cfswitch wrangler -p <name> whoami`.
4. **Adding a token: never echo it into argv if avoidable.** Prefer `printf '%s' "$TOKEN" | cfswitch add <name> --token-stdin --account-id <id>`.
5. If a token can reach several accounts, wrangler errors with "More than one account available". Fix by pinning: `cfswitch accounts <name> --json` to see IDs, then re-`add` with `--account-id`.
6. To pin an entire session/CI job to one account, set `CFSWITCH_PROFILE=<name>` and drop the `-p` flags.

## Command crib

```bash
cfswitch list --json                          # what profiles exist
cfswitch verify prod --json                   # is the token still valid (exit code matters)
cfswitch accounts prod --json                 # which account IDs the token reaches
cfswitch wrangler -p prod whoami              # confirm identity
cfswitch wrangler -p prod deploy              # deploy a Worker
cfswitch wrangler -p prod pages deploy out    # deploy Pages
cfswitch exec -p prod -- curl -s https://api.cloudflare.com/client/v4/user/tokens/verify -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN"
eval "$(cfswitch env prod)"                   # export vars into current shell
```

## Failure modes

- `cfswitch: error: no profile named "x"` → run `cfswitch list`, ask the user which account maps to which profile, or ask them to `cfswitch add`.
- `verify` exit 1 → token revoked/expired. Ask the user for a fresh token; do not retry.
- `More than one account available` from wrangler → pin `--account-id` (rule 5).
- No profiles at all → ask the user to create per-account API tokens at https://dash.cloudflare.com/profile/api-tokens ("Edit Cloudflare Workers" template) and add them.
