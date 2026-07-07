#!/usr/bin/env node
/**
 * cfswitch — agent-friendly Cloudflare/wrangler account switcher.
 *
 * Stores named profiles (API token + optional account id) and injects them
 * as CLOUDFLARE_API_TOKEN / CLOUDFLARE_ACCOUNT_ID when running wrangler or
 * any other command. Also supports isolated OAuth profiles via a per-profile
 * XDG_CONFIG_HOME so `wrangler login` sessions don't clobber each other.
 *
 * Design rules (agents depend on these):
 *  - Never prompts. Every input comes from argv, stdin (--token-stdin), or env.
 *  - Errors go to stderr with exit code 1; machine output supports --json.
 *  - Tokens are never printed except by explicit `env` output.
 */

import { promises as fs } from "node:fs";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { homedir } from "node:os";

const VERSION = "0.1.0";

// ---------------------------------------------------------------------------
// Config storage
// ---------------------------------------------------------------------------

interface Profile {
  /** API token (absent for OAuth profiles) */
  token?: string;
  /** Cloudflare account id, injected as CLOUDFLARE_ACCOUNT_ID */
  accountId?: string;
  /** "token" (default) or "oauth" (isolated wrangler login) */
  auth?: "token" | "oauth";
  /** free-form note, e.g. the email of the account */
  note?: string;
}

interface Config {
  version: 1;
  default?: string;
  profiles: Record<string, Profile>;
}

function configDir(): string {
  if (process.env.CFSWITCH_CONFIG_DIR) return process.env.CFSWITCH_CONFIG_DIR;
  if (process.platform === "win32") {
    return join(process.env.APPDATA ?? join(homedir(), "AppData", "Roaming"), "cfswitch");
  }
  const xdg = process.env.XDG_CONFIG_HOME;
  return join(xdg || join(homedir(), ".config"), "cfswitch");
}

const configPath = () => join(configDir(), "profiles.json");
const oauthHome = (name: string) => join(configDir(), "oauth", name);

async function loadConfig(): Promise<Config> {
  try {
    const raw = await fs.readFile(configPath(), "utf-8");
    const cfg = JSON.parse(raw) as Config;
    if (typeof cfg !== "object" || cfg === null || typeof cfg.profiles !== "object") {
      throw new Error(`corrupt config at ${configPath()}`);
    }
    return cfg;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return { version: 1, profiles: {} };
    }
    throw err;
  }
}

async function saveConfig(cfg: Config): Promise<void> {
  await fs.mkdir(configDir(), { recursive: true, mode: 0o700 });
  const tmp = configPath() + ".tmp";
  await fs.writeFile(tmp, JSON.stringify(cfg, null, 2) + "\n", { mode: 0o600 });
  await fs.rename(tmp, configPath());
}

function getProfile(cfg: Config, name: string): Profile {
  const p = cfg.profiles[name];
  if (!p) {
    fail(
      `no profile named "${name}". Available: ${Object.keys(cfg.profiles).join(", ") || "(none — run \`cfswitch add\`)"}`
    );
  }
  return p!;
}

function resolveName(cfg: Config, explicit?: string): string {
  const name = explicit ?? process.env.CFSWITCH_PROFILE ?? cfg.default;
  if (!name) {
    fail(
      "no profile specified and no default set. Use --profile <name>, set CFSWITCH_PROFILE, or run `cfswitch use <name>`."
    );
  }
  return name!;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function fail(msg: string): never {
  process.stderr.write(`cfswitch: error: ${msg}\n`);
  process.exit(1);
}

function out(s: string): void {
  process.stdout.write(s + "\n");
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf-8").trim();
}

/** Environment a profile injects. OAuth profiles isolate wrangler's config dir. */
function profileEnv(name: string, p: Profile): Record<string, string> {
  if (p.auth === "oauth") {
    return {
      XDG_CONFIG_HOME: oauthHome(name),
      // keep OAuth creds in plaintext TOML inside the isolated dir rather than
      // the OS keychain, so profiles stay independent and scriptable
      CLOUDFLARE_AUTH_USE_KEYRING: "false",
      ...(p.accountId ? { CLOUDFLARE_ACCOUNT_ID: p.accountId } : {}),
    };
  }
  return {
    CLOUDFLARE_API_TOKEN: p.token ?? "",
    ...(p.accountId ? { CLOUDFLARE_ACCOUNT_ID: p.accountId } : {}),
  };
}

function spawnInherit(cmd: string, args: string[], extraEnv: Record<string, string>): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, {
      stdio: "inherit",
      env: { ...process.env, ...extraEnv },
    });
    child.on("error", (err) => {
      process.stderr.write(`cfswitch: failed to run ${cmd}: ${err.message}\n`);
      resolve(127);
    });
    child.on("close", (code, signal) => resolve(code ?? (signal ? 1 : 0)));
  });
}

/** Locate wrangler: local node_modules/.bin, then PATH, then npx fallback. */
async function wranglerCmd(): Promise<{ cmd: string; prefix: string[] }> {
  const local = join(process.cwd(), "node_modules", ".bin", process.platform === "win32" ? "wrangler.cmd" : "wrangler");
  try {
    await fs.access(local);
    return { cmd: local, prefix: [] };
  } catch {
    /* not a local install */
  }
  const found = await new Promise<boolean>((resolve) => {
    const which = spawn(process.platform === "win32" ? "where" : "which", ["wrangler"], { stdio: "ignore" });
    which.on("error", () => resolve(false));
    which.on("close", (code) => resolve(code === 0));
  });
  if (found) return { cmd: "wrangler", prefix: [] };
  return { cmd: "npx", prefix: ["--yes", "wrangler"] };
}

const API_BASE = process.env.CLOUDFLARE_API_BASE_URL ?? "https://api.cloudflare.com/client/v4";

async function cfApi(path: string, token: string): Promise<any> {
  const res = await fetch(`${API_BASE}${path}`, {
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
  });
  return res.json();
}

// ---------------------------------------------------------------------------
// Arg parsing (tiny, flag-order-independent)
// ---------------------------------------------------------------------------

interface Parsed {
  positional: string[];
  flags: Record<string, string | boolean>;
  /** everything after a literal `--` */
  rest: string[];
}

const VALUE_FLAGS = new Set(["token", "account-id", "profile", "note", "name"]);

function parseArgs(argv: string[]): Parsed {
  const positional: string[] = [];
  const flags: Record<string, string | boolean> = {};
  const rest: string[] = [];
  let i = 0;
  while (i < argv.length) {
    const a = argv[i]!;
    if (a === "--") {
      rest.push(...argv.slice(i + 1));
      break;
    }
    if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      if (eq !== -1) {
        flags[a.slice(2, eq)] = a.slice(eq + 1);
      } else {
        const key = a.slice(2);
        if (VALUE_FLAGS.has(key) && i + 1 < argv.length && !argv[i + 1]!.startsWith("--")) {
          flags[key] = argv[++i]!;
        } else {
          flags[key] = true;
        }
      }
    } else if (a === "-p" && i + 1 < argv.length) {
      flags["profile"] = argv[++i]!;
    } else {
      positional.push(a);
    }
    i++;
  }
  return { positional, flags, rest };
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

const HELP = `cfswitch ${VERSION} — switch Cloudflare/wrangler auth between accounts. Built for agents: no prompts, --json output, clean exit codes.

USAGE
  cfswitch add <name> --token <T> [--account-id <ID>] [--note <text>]
  cfswitch add <name> --token-stdin [--account-id <ID>]   # echo $T | cfswitch add work --token-stdin
  cfswitch login <name> [--account-id <ID>]     # OAuth: isolated \`wrangler login\` for this profile
  cfswitch list [--json]                        # profiles (tokens never shown)
  cfswitch use <name>                           # set default profile
  cfswitch current [--json]                     # show default/active profile
  cfswitch remove <name>
  cfswitch verify [<name>] [--json]             # check token against the Cloudflare API
  cfswitch accounts [<name>] [--json]           # list account ids the token can access
  cfswitch env [<name>] [--json]                # print export lines: eval "$(cfswitch env work)"
  cfswitch exec [-p <name>] -- <cmd> [args...]  # run any command with profile env injected
  cfswitch wrangler [-p <name>] [args...]       # run wrangler as profile (npx fallback)

PROFILE RESOLUTION (for commands that take an optional name)
  explicit arg/-p/--profile  >  $CFSWITCH_PROFILE  >  default set via \`cfswitch use\`

EXAMPLES
  cfswitch add prod --token-stdin --account-id abc123 < token.txt
  cfswitch wrangler -p prod whoami
  cfswitch exec -p staging -- wrangler pages deploy out
  eval "$(cfswitch env prod)" && wrangler d1 list

Config: ${configPath()} (chmod 600). Tokens: create per-account at
https://dash.cloudflare.com/profile/api-tokens (template: "Edit Cloudflare Workers").
`;

async function cmdAdd(p: Parsed): Promise<void> {
  const name = p.positional[0] ?? (p.flags["name"] as string | undefined);
  if (!name) fail("usage: cfswitch add <name> --token <T> | --token-stdin");
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name!)) fail("profile name must match [A-Za-z0-9][A-Za-z0-9._-]*");

  let token = p.flags["token"] as string | undefined;
  if (p.flags["token-stdin"]) token = await readStdin();
  if (!token) token = process.env.CFSWITCH_TOKEN;
  if (!token) fail("no token provided. Use --token <T>, --token-stdin, or CFSWITCH_TOKEN env var.");

  const cfg = await loadConfig();
  const existed = !!cfg.profiles[name!];
  cfg.profiles[name!] = {
    token: token!.trim(),
    ...(p.flags["account-id"] ? { accountId: String(p.flags["account-id"]) } : {}),
    ...(p.flags["note"] ? { note: String(p.flags["note"]) } : {}),
  };
  if (!cfg.default) cfg.default = name!;
  await saveConfig(cfg);
  out(`${existed ? "updated" : "added"} profile "${name}"${cfg.default === name ? " (default)" : ""}`);
}

async function cmdLogin(p: Parsed): Promise<void> {
  const name = p.positional[0];
  if (!name) fail("usage: cfswitch login <name>");
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name!)) fail("profile name must match [A-Za-z0-9][A-Za-z0-9._-]*");

  const cfg = await loadConfig();
  cfg.profiles[name!] = {
    auth: "oauth",
    ...(p.flags["account-id"] ? { accountId: String(p.flags["account-id"]) } : {}),
    ...(p.flags["note"] ? { note: String(p.flags["note"]) } : {}),
  };
  if (!cfg.default) cfg.default = name!;
  await saveConfig(cfg);
  await fs.mkdir(oauthHome(name!), { recursive: true, mode: 0o700 });

  const { cmd, prefix } = await wranglerCmd();
  process.stderr.write(`cfswitch: launching \`wrangler login\` for profile "${name}" (isolated config dir)\n`);
  const code = await spawnInherit(cmd, [...prefix, "login"], profileEnv(name!, cfg.profiles[name!]!));
  process.exit(code);
}

async function cmdList(p: Parsed): Promise<void> {
  const cfg = await loadConfig();
  const names = Object.keys(cfg.profiles).sort();
  if (p.flags["json"]) {
    out(
      JSON.stringify(
        {
          default: cfg.default ?? null,
          profiles: names.map((n) => {
            const pr = cfg.profiles[n]!;
            return {
              name: n,
              auth: pr.auth ?? "token",
              accountId: pr.accountId ?? null,
              note: pr.note ?? null,
              isDefault: cfg.default === n,
            };
          }),
        },
        null,
        2
      )
    );
    return;
  }
  if (names.length === 0) {
    out("no profiles. Add one: cfswitch add <name> --token <T>");
    return;
  }
  for (const n of names) {
    const pr = cfg.profiles[n]!;
    const parts = [
      cfg.default === n ? "*" : " ",
      n.padEnd(16),
      (pr.auth ?? "token").padEnd(6),
      pr.accountId ?? "-",
      pr.note ? `(${pr.note})` : "",
    ];
    out(parts.join(" ").trimEnd());
  }
}

async function cmdUse(p: Parsed): Promise<void> {
  const name = p.positional[0];
  if (!name) fail("usage: cfswitch use <name>");
  const cfg = await loadConfig();
  getProfile(cfg, name!);
  cfg.default = name!;
  await saveConfig(cfg);
  out(`default profile is now "${name}"`);
}

async function cmdCurrent(p: Parsed): Promise<void> {
  const cfg = await loadConfig();
  const envOverride = process.env.CFSWITCH_PROFILE;
  const active = envOverride ?? cfg.default ?? null;
  if (p.flags["json"]) {
    out(JSON.stringify({ active, source: envOverride ? "env:CFSWITCH_PROFILE" : cfg.default ? "config" : null }));
    return;
  }
  if (!active) fail("no default profile set. Run `cfswitch use <name>`.");
  out(active!);
}

async function cmdRemove(p: Parsed): Promise<void> {
  const name = p.positional[0];
  if (!name) fail("usage: cfswitch remove <name>");
  const cfg = await loadConfig();
  getProfile(cfg, name!);
  const wasOauth = cfg.profiles[name!]!.auth === "oauth";
  delete cfg.profiles[name!];
  if (cfg.default === name) delete cfg.default;
  await saveConfig(cfg);
  if (wasOauth) await fs.rm(oauthHome(name!), { recursive: true, force: true });
  out(`removed profile "${name}"`);
}

async function cmdVerify(p: Parsed): Promise<void> {
  const cfg = await loadConfig();
  const name = resolveName(cfg, p.positional[0] ?? (p.flags["profile"] as string | undefined));
  const prof = getProfile(cfg, name);
  if (prof.auth === "oauth") {
    // No token to verify directly; ask wrangler.
    const { cmd, prefix } = await wranglerCmd();
    const code = await spawnInherit(cmd, [...prefix, "whoami"], profileEnv(name, prof));
    process.exit(code);
  }
  const body = await cfApi("/user/tokens/verify", prof.token!).catch((e) => ({ success: false, errors: [{ message: String(e) }] }));
  const okUser = body?.success === true && body?.result?.status === "active";
  // Account-owned tokens 404 on /user/tokens/verify; fall back to the account-scoped endpoint.
  let okAccount = false;
  let accountBody: any = null;
  if (!okUser && prof.accountId) {
    accountBody = await cfApi(`/accounts/${prof.accountId}/tokens/verify`, prof.token!).catch(() => null);
    okAccount = accountBody?.success === true && accountBody?.result?.status === "active";
  }
  const ok = okUser || okAccount;
  const result = okUser ? body.result : accountBody?.result;
  if (p.flags["json"]) {
    out(
      JSON.stringify({
        profile: name,
        valid: ok,
        status: result?.status ?? null,
        tokenId: result?.id ?? null,
        expiresOn: result?.expires_on ?? null,
        errors: ok ? [] : (body?.errors ?? []).map((e: any) => e.message),
      })
    );
    process.exit(ok ? 0 : 1);
  }
  if (ok) {
    out(`profile "${name}": token is active${result?.expires_on ? ` (expires ${result.expires_on})` : ""}`);
  } else {
    const msgs = (body?.errors ?? []).map((e: any) => e.message).join("; ");
    fail(`profile "${name}": token INVALID${msgs ? ` — ${msgs}` : ""}`);
  }
}

async function cmdAccounts(p: Parsed): Promise<void> {
  const cfg = await loadConfig();
  const name = resolveName(cfg, p.positional[0] ?? (p.flags["profile"] as string | undefined));
  const prof = getProfile(cfg, name);
  if (prof.auth === "oauth") fail(`profile "${name}" is OAuth; use \`cfswitch wrangler -p ${name} whoami\` instead.`);
  const body = await cfApi("/accounts", prof.token!).catch((e) => ({ success: false, errors: [{ message: String(e) }] }));
  if (body?.success !== true) {
    fail(`could not list accounts: ${(body?.errors ?? []).map((e: any) => e.message).join("; ") || "unknown error"}`);
  }
  const accounts = (body.result ?? []).map((a: any) => ({ id: a.id, name: a.name }));
  if (p.flags["json"]) {
    out(JSON.stringify({ profile: name, accounts }, null, 2));
    return;
  }
  if (accounts.length === 0) {
    out("(token can access no accounts — it may be user-scoped only)");
    return;
  }
  for (const a of accounts) out(`${a.id}  ${a.name}`);
  if (!prof.accountId && accounts.length > 1) {
    process.stderr.write(
      `hint: token sees ${accounts.length} accounts; pin one with \`cfswitch add ${name} --token ... --account-id <id>\`\n`
    );
  }
}

async function cmdEnv(p: Parsed): Promise<void> {
  const cfg = await loadConfig();
  const name = resolveName(cfg, p.positional[0] ?? (p.flags["profile"] as string | undefined));
  const prof = getProfile(cfg, name);
  const env = profileEnv(name, prof);
  if (p.flags["json"]) {
    out(JSON.stringify(env));
    return;
  }
  for (const [k, v] of Object.entries(env)) {
    out(`export ${k}='${v.replace(/'/g, `'\\''`)}'`);
  }
}

async function cmdExec(p: Parsed): Promise<void> {
  const cfg = await loadConfig();
  const name = resolveName(cfg, (p.flags["profile"] as string | undefined) ?? undefined);
  const prof = getProfile(cfg, name);
  if (p.rest.length === 0) fail("usage: cfswitch exec [-p <name>] -- <command> [args...]");
  const [cmd, ...args] = p.rest;
  const code = await spawnInherit(cmd!, args, profileEnv(name, prof));
  process.exit(code);
}

async function cmdWrangler(argv: string[]): Promise<void> {
  // Parse only our own leading flags (-p/--profile); pass everything else through verbatim.
  let profileName: string | undefined;
  let i = 0;
  while (i < argv.length) {
    if ((argv[i] === "-p" || argv[i] === "--profile") && i + 1 < argv.length) {
      profileName = argv[i + 1];
      argv.splice(i, 2);
    } else if (argv[i]!.startsWith("--profile=")) {
      profileName = argv[i]!.slice("--profile=".length);
      argv.splice(i, 1);
    } else {
      i++;
    }
  }
  const cfg = await loadConfig();
  const name = resolveName(cfg, profileName);
  const prof = getProfile(cfg, name);
  const { cmd, prefix } = await wranglerCmd();
  const code = await spawnInherit(cmd, [...prefix, ...argv], profileEnv(name, prof));
  process.exit(code);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  // Exit quietly when output is piped to a consumer that closes early (grep -q, head).
  process.stdout.on("error", (err: NodeJS.ErrnoException) => {
    if (err.code === "EPIPE") process.exit(0);
    throw err;
  });

  const [command, ...restArgv] = process.argv.slice(2);

  if (!command || command === "help" || command === "--help" || command === "-h") {
    out(HELP);
    return;
  }
  if (command === "--version" || command === "-v" || command === "version") {
    out(VERSION);
    return;
  }
  if (command === "wrangler") return cmdWrangler(restArgv); // raw passthrough parsing

  const p = parseArgs(restArgv);
  switch (command) {
    case "add":
      return cmdAdd(p);
    case "login":
      return cmdLogin(p);
    case "list":
    case "ls":
      return cmdList(p);
    case "use":
      return cmdUse(p);
    case "current":
      return cmdCurrent(p);
    case "remove":
    case "rm":
      return cmdRemove(p);
    case "verify":
      return cmdVerify(p);
    case "accounts":
      return cmdAccounts(p);
    case "env":
      return cmdEnv(p);
    case "exec":
      return cmdExec(p);
    default:
      fail(`unknown command "${command}". Run \`cfswitch help\`.`);
  }
}

main().catch((err) => {
  process.stderr.write(`cfswitch: error: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
