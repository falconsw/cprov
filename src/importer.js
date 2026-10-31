import fs from 'node:fs';
import path from 'node:path';
import { providerForUrl } from './catalog.js';
import { readJson } from './util.js';

// Turns hand-made ~/.claude/settings*.json files (the "copy a file over settings.json" setup)
// into profile candidates. Returns { items: [{ profile, key, file }], activeName } where
// activeName is the profile settings.json currently matches. Nothing is written here.
export function scanClaudeSettings(dir) {
  let files;
  try {
    files = fs.readdirSync(dir).filter((f) => /^settings(-[^.]+)?\.json$/.test(f));
  } catch {
    return { items: [], activeName: null };
  }
  // Named files first so settings.json, usually a copy of one of them, dedupes into it.
  files.sort((a, b) => (a === 'settings.json') - (b === 'settings.json') || a.localeCompare(b));

  const seen = new Map();
  const found = [];
  let activeName = null;
  for (const f of files) {
    let env;
    let picker;
    try {
      const json = readJson(path.join(dir, f));
      env = json.env || {};
      picker = json.modelPicker;
    } catch {
      continue;
    }
    const baseUrl = env.ANTHROPIC_BASE_URL;
    const key = env.ANTHROPIC_AUTH_TOKEN || env.ANTHROPIC_API_KEY || null;
    const model = env.ANTHROPIC_MODEL;
    if (!baseUrl && !model && !key) continue;

    const fingerprint = JSON.stringify([baseUrl || '', model || '', key || '']);
    const name = f === 'settings.json' ? 'default' : f.slice('settings-'.length, -'.json'.length);
    if (f === 'settings.json') activeName = seen.get(fingerprint) || name;
    if (seen.has(fingerprint)) continue;
    seen.set(fingerprint, name);

    let profile;
    if (!baseUrl || /(^|\.)anthropic\.com$/.test(safeHost(baseUrl))) {
      profile = { name, provider: 'anthropic', model: model || 'claude-opus-5-5', auth: key ? 'key' : 'subscription' };
    } else {
      const known = providerForUrl(baseUrl);
      profile = known
        ? { name, provider: known.id, model: model || known.models[0].id, auth: 'key' }
        : {
            name,
            provider: 'custom',
            baseUrl,
            model,
            auth: 'key',
            ...(picker?.options?.length && {
              models: picker.options.map((o) => ({ id: o.model, label: o.label || o.model })),
            }),
          };
    }
    found.push({ profile, key, file: path.join(dir, f) });
  }
  return { items: found, activeName };
}

function safeHost(url) {
  try {
    return new URL(url).host;
  } catch {
    return '';
  }
}
