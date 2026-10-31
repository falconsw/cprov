import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { buildOverlay, mergeIntoSettings } from '../src/settings.js';
import { providerForUrl } from '../src/catalog.js';
import { scanClaudeSettings } from '../src/importer.js';

const BIN = fileURLToPath(new URL('../bin/cprov.js', import.meta.url));

const roots = [];
after(() => roots.forEach((r) => fs.rmSync(r, { recursive: true, force: true })));

function sandbox() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cprov-test-'));
  roots.push(root);
  const claude = path.join(root, 'claude');
  fs.mkdirSync(claude);
  // Fake `claude` that prints what it was started with.
  const fake = path.join(root, 'fake-claude.sh');
  fs.writeFileSync(
    fake,
    '#!/bin/sh\nprintf "%s\\n" "$2" > "$CPROV_TEST_OUT"\nprintf "%s" "$ANTHROPIC_AUTH_TOKEN|$ANTHROPIC_API_KEY|$CPROV_PROFILE" >> "$CPROV_TEST_OUT"\n',
    { mode: 0o755 },
  );
  const env = {
    ...process.env,
    CPROV_HOME: path.join(root, 'cprov'),
    CLAUDE_CONFIG_DIR: claude,
    CPROV_SECRET_BACKEND: 'file',
    CPROV_CLAUDE_BIN: fake,
    CPROV_TEST_OUT: path.join(root, 'out.txt'),
    CPROV_LANG: 'en',
    ANTHROPIC_AUTH_TOKEN: 'leaked-from-shell',
  };
  const cli = (args, input) => spawnSync(process.execPath, [BIN, ...args], { env, input, encoding: 'utf8' });
  return { root, claude, env, cli };
}

test('overlay maps every tier to the model for gateways and never includes the key', () => {
  const o = buildOverlay({ name: 'glm', provider: 'zai', model: 'glm-5.3-flash[1m]', auth: 'key' });
  assert.equal(o.env.ANTHROPIC_BASE_URL, 'https://api.z.ai/api/anthropic');
  assert.equal(o.env.ANTHROPIC_DEFAULT_HAIKU_MODEL, 'glm-5.3-flash[1m]');
  assert.equal(o.env.API_TIMEOUT_MS, '3000000');
  assert.equal(o.apiKeyHelper, undefined);
  assert.equal(o.modelPicker, undefined);
  assert.ok(!JSON.stringify(o).includes('AUTH_TOKEN'));
});

test('overlay adds per-model env and a model picker when a provider has several models', () => {
  const o = buildOverlay(
    { name: 'mm', provider: 'minimax', model: 'MiniMax-M3.1-Flash-Preview[1m]', auth: 'key' },
    { helper: 'cprov key mm' },
  );
  assert.equal(o.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW, '1000000');
  assert.equal(o.apiKeyHelper, 'cprov key mm');
  assert.equal(o.modelPicker.options.length, 4);
  assert.equal(o.modelPicker.replaceBuiltInOptions, true);
});

test('native Anthropic overlay leaves tiers and defaults alone', () => {
  const o = buildOverlay({ name: 'claude', provider: 'anthropic', model: 'claude-opus-5-5', auth: 'subscription' }, { helper: 'x' });
  assert.deepEqual(o, { env: { ANTHROPIC_BASE_URL: 'https://api.anthropic.com', ANTHROPIC_MODEL: 'claude-opus-5-5' } });
});

test('merge keeps unrelated settings and clears the previous provider', () => {
  const before = {
    enabledPlugins: { 'cost-info@falconsw-mods': true },
    apiKeyHelper: 'old',
    env: {
      ANTHROPIC_BASE_URL: 'https://api.minimax.io/anthropic',
      ANTHROPIC_AUTH_TOKEN: 'secret',
      CLAUDE_CODE_AUTO_COMPACT_WINDOW: '1000000',
      API_TIMEOUT_MS: '3000000',
      MY_VAR: '1',
    },
  };
  const overlay = buildOverlay({ name: 'claude', provider: 'anthropic', model: 'claude-opus-5-5', auth: 'subscription' });
  const after = mergeIntoSettings(before, overlay, ['API_TIMEOUT_MS']);
  assert.deepEqual(after.enabledPlugins, before.enabledPlugins);
  assert.equal(after.apiKeyHelper, undefined);
  assert.deepEqual(after.env, {
    MY_VAR: '1',
    ANTHROPIC_BASE_URL: 'https://api.anthropic.com',
    ANTHROPIC_MODEL: 'claude-opus-5-5',
  });
});

test('provider lookup by base URL ignores trailing slashes', () => {
  assert.equal(providerForUrl('https://api.z.ai/api/anthropic/').id, 'zai');
  assert.equal(providerForUrl('https://example.com/anthropic'), undefined);
});

test('import recognises hand-made settings files and dedupes settings.json', () => {
  const { claude } = sandbox();
  const write = (f, env, extra = {}) => fs.writeFileSync(path.join(claude, f), JSON.stringify({ ...extra, env }));
  write('settings-glm.json', { ANTHROPIC_BASE_URL: 'https://api.z.ai/api/anthropic', ANTHROPIC_AUTH_TOKEN: 'k1', ANTHROPIC_MODEL: 'glm-5.3-flash[1m]' });
  write('settings-opus.json', { ANTHROPIC_MODEL: 'claude-opus-5-5' });
  write('settings-other.json', { ANTHROPIC_BASE_URL: 'https://llm.example.com/anthropic', ANTHROPIC_AUTH_TOKEN: 'k2', ANTHROPIC_MODEL: 'm1' }, {
    modelPicker: { options: [{ model: 'm1', label: 'M1' }, { model: 'm2' }] },
  });
  write('settings.json', { ANTHROPIC_MODEL: 'claude-opus-5-5' });
  write('settings-empty.json', {});

  const { items, activeName } = scanClaudeSettings(claude);
  assert.equal(activeName, 'opus');
  const byName = Object.fromEntries(items.map((i) => [i.profile.name, i]));
  assert.deepEqual(Object.keys(byName).sort(), ['glm', 'opus', 'other']);
  assert.deepEqual(byName.glm.profile, { name: 'glm', provider: 'zai', model: 'glm-5.3-flash[1m]', auth: 'key' });
  assert.equal(byName.glm.key, 'k1');
  assert.equal(byName.opus.profile.auth, 'subscription');
  assert.equal(byName.other.profile.provider, 'custom');
  assert.equal(byName.other.profile.models.length, 2);
});

test('use --env-key keeps the key in settings.json env until --no-env-key', () => {
  const { claude, cli } = sandbox();
  let r = cli(['add', 'zai', '--key-stdin', '--no-verify'], 'zai-secret\n');
  assert.equal(r.status, 0, r.stderr);

  r = cli(['use', 'glm', '--env-key']);
  assert.equal(r.status, 0, r.stderr);
  let settings = JSON.parse(fs.readFileSync(path.join(claude, 'settings.json'), 'utf8'));
  assert.equal(settings.env.ANTHROPIC_AUTH_TOKEN, 'zai-secret');
  assert.match(settings.apiKeyHelper, /cprov\.js' key 'glm'$/);

  // The choice sticks: a later plain `use` keeps writing it, so env-reading apps stay working.
  r = cli(['use', 'glm']);
  assert.equal(r.status, 0, r.stderr);
  settings = JSON.parse(fs.readFileSync(path.join(claude, 'settings.json'), 'utf8'));
  assert.equal(settings.env.ANTHROPIC_AUTH_TOKEN, 'zai-secret');

  // --no-env-key takes it back out; the keychain helper stays.
  r = cli(['use', 'glm', '--no-env-key']);
  assert.equal(r.status, 0, r.stderr);
  settings = JSON.parse(fs.readFileSync(path.join(claude, 'settings.json'), 'utf8'));
  assert.equal(settings.env.ANTHROPIC_AUTH_TOKEN, undefined);
  assert.ok(settings.apiKeyHelper);

  // Plain `use` after --no-env-key keeps it out.
  r = cli(['use', 'glm']);
  assert.equal(r.status, 0, r.stderr);
  settings = JSON.parse(fs.readFileSync(path.join(claude, 'settings.json'), 'utf8'));
  assert.equal(settings.env.ANTHROPIC_AUTH_TOKEN, undefined);
});

test('end to end: add, ls, run, use, rm', () => {
  const { claude, env, cli } = sandbox();
  fs.writeFileSync(path.join(claude, 'settings.json'), JSON.stringify({ enabledPlugins: { x: true }, env: { MY_VAR: '1' } }));

  let r = cli(['add', 'zai', '--key-stdin', '--no-verify'], 'zai-secret\n');
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /Profile "glm" created/);
  assert.ok(!fs.readFileSync(path.join(env.CPROV_HOME, 'profiles', 'glm.json'), 'utf8').includes('zai-secret'));

  r = cli(['add', 'zai', '--key-stdin', '--no-verify'], 'x\n');
  assert.notEqual(r.status, 0, 'duplicate name must be refused');

  r = cli(['add', 'anthropic', '--subscription', '--name', 'opus']);
  assert.equal(r.status, 0, r.stderr);

  r = cli(['ls']);
  assert.match(r.stdout, /glm\s+Z\.ai \(GLM\)\s+glm-5\.3-flash\[1m\]\s+key/);

  r = cli(['key', 'glm']);
  assert.equal(r.stdout, 'zai-secret\n');

  // `cprov glm` runs claude with the overlay; the shell's stray token is replaced.
  r = cli(['glm', '-p', 'hi']);
  assert.equal(r.status, 0, r.stderr);
  const [settingsArg, envLine] = fs.readFileSync(env.CPROV_TEST_OUT, 'utf8').split('\n');
  assert.equal(JSON.parse(settingsArg).env.ANTHROPIC_BASE_URL, 'https://api.z.ai/api/anthropic');
  assert.equal(envLine, 'zai-secret||glm');

  r = cli(['opus']);
  assert.equal(fs.readFileSync(env.CPROV_TEST_OUT, 'utf8').split('\n')[1], '||opus');

  r = cli(['use', 'glm']);
  assert.equal(r.status, 0, r.stderr);
  let settings = JSON.parse(fs.readFileSync(path.join(claude, 'settings.json'), 'utf8'));
  assert.deepEqual(settings.enabledPlugins, { x: true });
  assert.equal(settings.env.MY_VAR, '1');
  assert.equal(settings.env.ANTHROPIC_MODEL, 'glm-5.3-flash[1m]');
  assert.match(settings.apiKeyHelper, /cprov\.js' key 'glm'$/);
  assert.ok(!settings.apiKeyHelper.includes('/Cellar/'));
  assert.ok(fs.existsSync(path.join(claude, 'settings.json.cprov-backup')));
  assert.equal(cli(['current']).stdout.trim(), 'glm');

  // The helper command written into settings.json must actually print the key.
  const helper = spawnSync('/bin/sh', ['-c', settings.apiKeyHelper], { env, encoding: 'utf8' });
  assert.equal(helper.stdout, 'zai-secret\n');

  r = cli(['use', 'opus']);
  settings = JSON.parse(fs.readFileSync(path.join(claude, 'settings.json'), 'utf8'));
  assert.equal(settings.apiKeyHelper, undefined);
  assert.equal(settings.env.API_TIMEOUT_MS, undefined);
  assert.equal(settings.env.ANTHROPIC_DEFAULT_OPUS_MODEL, undefined);
  assert.equal(settings.env.MY_VAR, '1');

  r = cli(['rm', 'glm', '--yes']);
  assert.equal(r.status, 0, r.stderr);
  assert.notEqual(cli(['key', 'glm']).status, 0);
  assert.match(cli(['nope']).stderr, /unknown command or profile/);
});
