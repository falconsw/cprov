import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { defaultModel, getProvider, providers } from './catalog.js';
import { ping } from './doctor.js';
import { scanClaudeSettings } from './importer.js';
import { claudeDir, claudeSettingsPath } from './paths.js';
import {
  deleteProfile,
  listProfiles,
  loadProfile,
  profileExists,
  readState,
  saveProfile,
  validName,
  writeState,
} from './profiles.js';
import { confirm, input, interactive, select } from './prompt.js';
import { secretStore } from './secrets.js';
import { MANAGED_ENV, buildOverlay, helperCommand, mergeIntoSettings, resolveProvider } from './settings.js';
import { t } from './i18n.js';
import { c, readJson, writeJson } from './util.js';

const VERSION = readJson(fileURLToPath(new URL('../package.json', import.meta.url))).version;

const log = (...args) => console.error(...args);
const ok = (msg) => log(`${c.green('✓')} ${msg}`);
const bad = (msg) => log(`${c.red('✗')} ${msg}`);
const warn = (msg) => log(c.yellow(msg));

const HELP = `cprov ${VERSION} — switch Claude Code between providers

Usage
  cprov add [provider]            create a profile (interactive)
  cprov <profile> [claude args]   start Claude Code with a profile (this session only)
  cprov run <profile> [args]      same as above
  cprov use <profile>             make a profile the default for plain \`claude\`
    --env-key       also keep the key in settings.json env (apps that read it: Leftover, Cost Info…)
    --no-env-key    back to keychain-only
  cprov ls                        list profiles
  cprov current                   show the default profile
  cprov rm <profile>              delete a profile and its key
  cprov doctor [profile]          check setup, keys and endpoints
  cprov import                    turn ~/.claude/settings-*.json files into profiles
  cprov providers                 list built-in providers

add flags (for scripts)
  --model <id>  --name <name>  --base-url <url> (custom)  --subscription (anthropic)
  --key-stdin   read the key from stdin (or set CPROV_API_KEY)
  --no-verify   skip the test request      --force   overwrite an existing profile

Environment
  CPROV_LANG=tr|en   interface language     CPROV_HOME   config dir (~/.config/cprov)
`;

const VALUE_FLAGS = new Set(['model', 'name', 'base-url']);

function parse(args) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < args.length; i++) {
    const m = args[i].match(/^--([^=]+)(?:=(.*))?$/);
    if (!m) positional.push(args[i]);
    else if (m[2] !== undefined) flags[m[1]] = m[2];
    else if (VALUE_FLAGS.has(m[1])) flags[m[1]] = args[++i];
    else flags[m[1]] = true;
  }
  if (flags.y) flags.yes = true;
  return { positional, flags };
}

export async function main(argv) {
  const [cmd, ...rest] = argv;
  switch (cmd) {
    case undefined:
    case 'help':
    case '-h':
    case '--help':
      return void process.stdout.write(HELP);
    case 'version':
    case '-v':
    case '--version':
      return void console.log(VERSION);
    case 'add':
      return add(parse(rest));
    case 'run':
      return run(rest[0], rest.slice(1));
    case 'use':
      return use(parse(rest));
    case 'ls':
    case 'list':
      return list();
    case 'current':
      return current();
    case 'rm':
    case 'remove':
      return remove(parse(rest));
    case 'key':
      return printKey(rest[0]);
    case 'doctor':
      return doctor(rest[0]);
    case 'import':
      return importSettings(parse(rest));
    case 'providers':
      return listProviders();
    default:
      if (validName(cmd) && profileExists(cmd)) return run(cmd, rest);
      throw new Error(t('err.unknownCommand', { cmd }));
  }
}

// ---------------------------------------------------------------- add

async function add({ positional: [providerId], flags }) {
  const tty = interactive();
  let provider;
  if (providerId === 'custom') provider = null;
  else if (providerId) provider = requireProvider(providerId);
  else {
    if (!tty) throw new Error(t('err.usage', { usage: 'cprov add <provider> [flags]' }));
    const choice = await select(t('ask.provider'), [
      ...providers().map((p) => ({ label: p.name, value: p.id })),
      { label: t('choice.custom'), value: 'custom' },
    ]);
    provider = choice === 'custom' ? null : getProvider(choice);
  }

  const profile = { provider: provider ? provider.id : 'custom' };
  if (!provider) {
    profile.baseUrl =
      flags['base-url'] ||
      (await input(t('ask.baseUrl'), { validate: (v) => (/^https?:\/\/\S+$/.test(v) ? null : t('err.badUrl')) }));
  }

  // Auth: only Anthropic itself offers a subscription sign-in.
  const keyGiven = flags['key-stdin'] || process.env.CPROV_API_KEY;
  if (provider?.native) {
    if (flags.subscription) profile.auth = 'subscription';
    else if (keyGiven || !tty) profile.auth = keyGiven ? 'key' : 'subscription';
    else
      profile.auth = await select(t('ask.auth'), [
        { label: t('auth.subscription'), value: 'subscription' },
        { label: t('auth.key'), value: 'key' },
      ]);
  } else profile.auth = 'key';

  // Model: catalog list, but any id is accepted via --model so new models work before a catalog update.
  if (flags.model) profile.model = flags.model;
  else if (!provider) profile.model = await input(t('ask.model'), { validate: (v) => (v ? null : t('err.required')) });
  else if (provider.models.length > 1 && tty) {
    const initial = Math.max(0, provider.models.findIndex((m) => m.default));
    profile.model = await select(
      t('ask.model'),
      provider.models.map((m) => ({
        label: m.label || m.id,
        hint: [m.context && `${m.context} context`, m.note].filter(Boolean).join(' · '),
        value: m.id,
      })),
      initial,
    );
  } else profile.model = defaultModel(provider);

  let key = null;
  if (profile.auth === 'key') {
    const providerName = provider ? provider.name : profile.baseUrl;
    const askKey = () =>
      input(t('ask.key', { provider: providerName }), {
        mask: true,
        validate: (v) => (v ? null : t('err.required')),
      });
    if (flags['key-stdin']) key = (await readStdin()).trim();
    else if (process.env.CPROV_API_KEY) key = process.env.CPROV_API_KEY.trim();
    else {
      if (!tty) throw new Error(t('err.needTty'));
      if (provider?.keyUrl) log(`  ${t('add.keyUrl', { url: c.cyan(provider.keyUrl) })}`);
      key = await askKey();
    }

    while (!flags['no-verify']) {
      log(c.dim(`  ${t('add.verifying')}`));
      const result = await ping(profile, key);
      if (result.ok) {
        ok(t('add.verified', { model: profile.model, ms: result.ms }));
        break;
      }
      bad(describePing(result));
      if (!tty) throw new Error(t('err.verifyFailed'));
      const next = await select(t('ask.verifyFailed'), [
        { label: t('choice.retryKey'), value: 'retry' },
        { label: t('choice.keepAnyway'), value: 'keep' },
        { label: t('choice.cancel'), value: 'cancel' },
      ]);
      if (next === 'cancel') return log(t('add.cancelled'));
      if (next === 'keep') break;
      key = await askKey();
    }
  }

  const suggested = flags.name || (provider ? provider.profileName || provider.id : hostLabel(profile.baseUrl));
  const nameProblem = (v) => {
    if (!validName(v)) return t('err.badName');
    if (profileExists(v) && !flags.force) return t('err.nameTaken', { name: v });
    return null;
  };
  let name = suggested;
  if (tty && !flags.name) name = await input(t('ask.name'), { initial: suggested, validate: nameProblem });
  else if (nameProblem(name)) throw new Error(`${name}: ${nameProblem(name)}`);

  const store = secretStore();
  if (key) store.set(name, key);
  saveProfile({ name, ...profile });
  ok(key ? t('add.saved', { name, store: store.name }) : t('add.savedNoKey', { name }));
  log(c.dim(t('add.next', { run: c.cyan(`cprov ${name}`), use: c.cyan(`cprov use ${name}`) })));
}

// ---------------------------------------------------------------- run / use

async function run(name, args) {
  if (!name) throw new Error(t('err.usage', { usage: 'cprov run <profile> [claude args]' }));
  const profile = loadProfile(name);

  const env = { ...process.env, CPROV_PROFILE: name };
  for (const k of MANAGED_ENV) delete env[k];
  if (profile.auth === 'key') {
    const key = secretStore().get(name);
    if (!key) throw new Error(t('err.noKey', { name }));
    // Through the child's environment, not --settings, so the key never appears in `ps`.
    // Anthropic wants x-api-key; compatible gateways expect a bearer token.
    env[resolveProvider(profile).native ? 'ANTHROPIC_API_KEY' : 'ANTHROPIC_AUTH_TOKEN'] = key;
  }
  warnAboutGlobalSettings(profile);

  const bin = process.env.CPROV_CLAUDE_BIN || 'claude';
  const child = spawn(bin, ['--settings', JSON.stringify(buildOverlay(profile)), ...args], {
    stdio: 'inherit',
    env,
  });
  // Ctrl-C belongs to Claude Code; we only wait for it.
  for (const sig of ['SIGINT', 'SIGQUIT']) process.on(sig, () => {});
  process.on('SIGTERM', () => child.kill('SIGTERM'));
  await new Promise((resolve, reject) => {
    child.on('error', (err) =>
      reject(err.code === 'ENOENT' ? new Error(t('doctor.claudeMissing')) : err),
    );
    child.on('exit', (code, signal) => {
      process.exitCode = signal ? 128 + (os.constants.signals[signal] || 1) : code ?? 0;
      resolve();
    });
  });
}

function warnAboutGlobalSettings(profile) {
  // A settings.json key written by our own `use --env-key` is there on purpose.
  if (readState().envKey) return;
  const settings = readJson(claudeSettingsPath(), {});
  for (const key of ['ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_API_KEY']) {
    if (settings.env?.[key]) warn(t('warn.settingsKey', { key }));
  }
  if (profile.auth === 'subscription' && settings.apiKeyHelper) warn(t('warn.helper', { name: profile.name }));
}

async function use({ positional: [name], flags = {} }) {
  if (!name) throw new Error(t('err.usage', { usage: 'cprov use <profile>' }));
  const profile = loadProfile(name);
  if (profile.auth === 'key' && !secretStore().get(name)) throw new Error(t('err.noKey', { name }));

  const settingsPath = claudeSettingsPath();
  const backup = `${settingsPath}.cprov-backup`;
  if (fs.existsSync(settingsPath)) fs.copyFileSync(settingsPath, backup);

  const state = readState();
  // Apps that only read ~/.claude/settings.json or the session's environment — Leftover, Cost
  // Info, limit dashboards — lose the key when `use` keeps it in the keychain alone. `--env-key`
  // also writes it there; the choice sticks until `--no-env-key` says otherwise.
  const envKey = flags['env-key'] ? true : flags['no-env-key'] ? false : state.envKey === true;
  const overlay = buildOverlay(profile, { helper: helperCommand(name) });
  if (envKey && profile.auth === 'key') {
    // The same channel `run` uses: Anthropic wants x-api-key, compatible gateways a bearer token.
    overlay.env[resolveProvider(profile).native ? 'ANTHROPIC_API_KEY' : 'ANTHROPIC_AUTH_TOKEN'] =
      secretStore().get(name);
  }
  writeJson(settingsPath, mergeIntoSettings(readJson(settingsPath, {}), overlay, state.appliedEnvKeys));
  writeState({ ...state, active: name, appliedEnvKeys: Object.keys(overlay.env), envKey });

  ok(t('use.done', { name, provider: resolveProvider(profile).name, model: profile.model }));
  if (envKey && profile.auth === 'key') log(c.dim(t('use.envKey')));
  log(c.dim(t('use.note', { backup })));
  if (profile.auth === 'key' && /[\\/]_npx[\\/]/.test(fileURLToPath(import.meta.url))) warn(t('use.npx'));
}

// ---------------------------------------------------------------- ls / current / rm / key

function list() {
  const profiles = listProfiles();
  if (!profiles.length) return log(t('ls.empty'));
  const active = readState().active;
  const rows = profiles.map((p) => {
    let providerName = p.provider;
    try {
      providerName = resolveProvider(p).name;
    } catch {}
    return [p.name, providerName, p.model, p.auth === 'key' ? 'key' : 'subscription'];
  });
  const header = t('ls.header').split('|');
  const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i].length)));
  const fmt = (r) => r.map((cell, i) => cell.padEnd(widths[i])).join('  ').trimEnd();
  console.log(c.dim(`  ${fmt(header)}`));
  for (const [i, r] of rows.entries()) {
    const isActive = profiles[i].name === active;
    console.log(isActive ? c.green(`❯ ${fmt(r)}`) : `  ${fmt(r)}`);
  }
}

function current() {
  const { active } = readState();
  if (!active) return log(t('current.none'));
  console.log(active);
}

async function remove({ positional: [name], flags }) {
  if (!name) throw new Error(t('err.usage', { usage: 'cprov rm <profile>' }));
  loadProfile(name);
  if (interactive() && !flags.yes && !(await confirm(t('ask.remove', { name }), false))) return;
  secretStore().delete(name);
  deleteProfile(name);
  ok(t('rm.done', { name }));
  const state = readState();
  if (state.active === name) {
    writeState({ ...state, active: null });
    warn(t('rm.wasActive'));
  }
}

// Called by Claude Code through apiKeyHelper; prints only the key.
function printKey(name) {
  if (!name) throw new Error(t('err.usage', { usage: 'cprov key <profile>' }));
  loadProfile(name);
  const key = secretStore().get(name);
  if (!key) throw new Error(t('err.noKey', { name }));
  process.stdout.write(`${key}\n`);
}

function listProviders() {
  for (const p of providers()) {
    console.log(`${c.bold(p.id.padEnd(10))} ${p.name}`);
    for (const m of p.models) console.log(c.dim(`${' '.repeat(11)}${m.id}${m.default ? '  (default)' : ''}`));
  }
  console.log(`${c.bold('custom'.padEnd(10))} ${t('choice.custom')}`);
}

// ---------------------------------------------------------------- doctor

async function doctor(only) {
  let problems = 0;
  const fail = (msg) => {
    problems++;
    bad(msg);
  };

  const v = spawnSync(process.env.CPROV_CLAUDE_BIN || 'claude', ['--version'], { encoding: 'utf8' });
  if (v.status === 0) ok(`${t('doctor.claude')}: ${v.stdout.trim()}`);
  else fail(t('doctor.claudeMissing'));
  ok(`${t('doctor.store')}: ${secretStore().name}`);

  for (const file of claudeSettingsFiles()) {
    const env = readJson(file, {}).env || {};
    const key = ['ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_API_KEY'].find((k) => env[k]);
    if (!key) continue;
    if (path.basename(file) === 'settings.json') {
      // With `use --env-key` the plaintext copy is the user's own choice: say it, don't fail on it.
      if (readState().envKey) warn(t('doctor.plainKeyCompat', { file, key }));
      else fail(t('doctor.plainKey', { file, key }));
    }
    if (fs.statSync(file).mode & 0o044) fail(t('doctor.readable', { file }));
  }

  const profiles = only ? [loadProfile(only)] : listProfiles();
  for (const p of profiles) {
    const label = `${c.bold(p.name)} ${c.dim(`${p.model}`)}`;
    if (p.auth !== 'key') {
      ok(`${label}: ${t('doctor.subscription')}`);
      continue;
    }
    const key = secretStore().get(p.name);
    if (!key) {
      fail(`${label}: ${t('doctor.noKey')}`);
      continue;
    }
    const result = await ping(p, key);
    if (result.ok) ok(`${label}: ${t('ping.ok', { ms: result.ms })}`);
    else fail(`${label}: ${describePing(result)}`);
  }

  log(problems ? c.red(t('doctor.problems', { n: problems })) : c.green(t('doctor.ok')));
  if (problems) process.exitCode = 1;
}

function claudeSettingsFiles() {
  try {
    return fs
      .readdirSync(claudeDir())
      .filter((f) => /^settings.*\.json$/.test(f))
      .map((f) => path.join(claudeDir(), f));
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------- import

async function importSettings({ flags }) {
  const dir = claudeDir();
  const { items, activeName } = scanClaudeSettings(dir);
  if (!items.length) return log(t('import.none', { dir }));

  log(t('import.found', { dir }));
  const todo = [];
  for (const item of items) {
    const { profile } = item;
    const exists = profileExists(profile.name) && !flags.force;
    const desc = `${c.bold(profile.name.padEnd(10))} ${resolveProvider(profile).name} · ${profile.model}`;
    log(`  ${path.basename(item.file).padEnd(22)} → ${desc}${exists ? c.dim(`  ${t('import.exists')}`) : ''}`);
    if (!exists) todo.push(item);
  }
  if (!todo.length) return;
  if (interactive() && !flags.yes && !(await confirm(t('ask.import', { n: todo.length })))) return;

  const store = secretStore();
  for (const { profile, key } of todo) {
    if (key) store.set(profile.name, key);
    saveProfile(profile);
  }
  ok(t('import.done', { n: todo.length, store: store.name }));
  if (activeName && profileExists(activeName)) log(t('import.useHint', { name: activeName }));
  // settings.json itself gets cleaned by `cprov use`; only the copies are left to delete.
  const withKeys = items.filter((i) => i.key && path.basename(i.file) !== 'settings.json').map((i) => i.file);
  if (withKeys.length) warn(t('import.cleanup', { files: withKeys.join('\n  ') }));
}

// ---------------------------------------------------------------- helpers

function requireProvider(id) {
  const p = getProvider(id);
  if (!p) throw new Error(t('err.unknownProvider', { id, known: [...providers().map((x) => x.id), 'custom'].join(', ') }));
  return p;
}

function describePing(r) {
  const detail = [r.status, r.message].filter(Boolean).join(' ');
  return `${t(`ping.${r.kind}`)}${detail ? c.dim(` (${detail})`) : ''}`;
}

function hostLabel(url) {
  try {
    return new URL(url).hostname.replace(/^api\./, '').split('.')[0] || 'custom';
  } catch {
    return 'custom';
  }
}

async function readStdin() {
  let data = '';
  for await (const chunk of process.stdin) data += chunk;
  return data;
}
