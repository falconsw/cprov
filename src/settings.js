import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { catalogDefaults, getProvider } from './catalog.js';
import { shellQuote } from './util.js';
import { t } from './i18n.js';

// Env keys that decide which provider/model Claude Code talks to. `cprov use` always clears
// these before applying a profile so nothing leaks over from the previous one.
export const MANAGED_ENV = [
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_MODEL',
  'ANTHROPIC_SMALL_FAST_MODEL',
  'ANTHROPIC_DEFAULT_OPUS_MODEL',
  'ANTHROPIC_DEFAULT_SONNET_MODEL',
  'ANTHROPIC_DEFAULT_HAIKU_MODEL',
  'CLAUDE_CODE_AUTO_COMPACT_WINDOW',
];

export function resolveProvider(profile) {
  if (profile.provider === 'custom') {
    return {
      id: 'custom',
      name: profile.baseUrl,
      baseUrl: profile.baseUrl,
      mapAllTiers: true,
      models: profile.models?.length ? profile.models : [{ id: profile.model }],
    };
  }
  const provider = getProvider(profile.provider);
  if (!provider) throw new Error(t('err.unknownProvider', { id: profile.provider }));
  return provider;
}

// Absolute paths so the helper works whatever PATH Claude Code's shell ends up with. Prefer the
// `node` on PATH (e.g. /opt/homebrew/bin/node) over process.execPath, which points into a
// versioned folder that disappears on the next upgrade.
export function helperCommand(name) {
  const script = fileURLToPath(new URL('../bin/cprov.js', import.meta.url));
  const onPath = spawnSync('sh', ['-c', 'command -v node'], { encoding: 'utf8' }).stdout?.trim();
  const node = onPath && onPath.startsWith('/') ? onPath : process.execPath;
  return `${shellQuote(node)} ${shellQuote(script)} key ${shellQuote(name)}`;
}

// Settings fragment that points Claude Code at a profile. Never contains the key itself:
// `use` adds an apiKeyHelper, `run` passes the key through the child's environment.
export function buildOverlay(profile, { helper } = {}) {
  const provider = resolveProvider(profile);
  const model = provider.models.find((m) => m.id === profile.model) || {};
  const env = {
    ...(provider.native ? {} : catalogDefaults().env),
    ...provider.env,
    ...model.env,
    ...profile.env,
    ANTHROPIC_BASE_URL: provider.baseUrl,
    ANTHROPIC_MODEL: profile.model,
  };
  if (provider.mapAllTiers) {
    for (const tier of ['OPUS', 'SONNET', 'HAIKU']) env[`ANTHROPIC_DEFAULT_${tier}_MODEL`] = profile.model;
  }
  const overlay = { env };
  if (helper && profile.auth === 'key') overlay.apiKeyHelper = helper;
  if (!provider.native && provider.models.length > 1) {
    overlay.modelPicker = {
      options: provider.models.map((m) => ({
        model: m.id,
        label: m.label || m.id,
        ...(m.context && { description: [`${m.context} context`, m.note].filter(Boolean).join(' · ') }),
      })),
      replaceBuiltInOptions: true,
    };
  }
  return overlay;
}

// Applies an overlay to ~/.claude/settings.json contents, keeping everything cprov doesn't own.
export function mergeIntoSettings(settings, overlay, previouslyApplied = []) {
  const out = { ...settings };
  const env = { ...(settings.env || {}) };
  for (const key of new Set([...MANAGED_ENV, ...previouslyApplied])) delete env[key];
  Object.assign(env, overlay.env);
  out.env = env;
  delete out.apiKeyHelper;
  delete out.modelPicker;
  if (overlay.apiKeyHelper) out.apiKeyHelper = overlay.apiKeyHelper;
  if (overlay.modelPicker) out.modelPicker = overlay.modelPicker;
  return out;
}
