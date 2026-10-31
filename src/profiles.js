import fs from 'node:fs';
import path from 'node:path';
import { profilesDir, statePath } from './paths.js';
import { readJson, writeJson } from './util.js';
import { t } from './i18n.js';

export const validName = (name) => /^[a-z0-9][a-z0-9._-]{0,39}$/i.test(name);

const profilePath = (name) => path.join(profilesDir(), `${name}.json`);

export function listProfiles() {
  let files = [];
  try {
    files = fs.readdirSync(profilesDir());
  } catch {
    return [];
  }
  return files
    .filter((f) => f.endsWith('.json'))
    .sort()
    .map((f) => readJson(path.join(profilesDir(), f)));
}

export const profileExists = (name) => fs.existsSync(profilePath(name));

export function loadProfile(name) {
  if (!validName(name) || !profileExists(name)) throw new Error(t('err.noProfile', { name }));
  return readJson(profilePath(name));
}

export const saveProfile = (profile) => writeJson(profilePath(profile.name), profile, 0o600);

export const deleteProfile = (name) => fs.rmSync(profilePath(name), { force: true });

export const readState = () => readJson(statePath(), {});
export const writeState = (state) => writeJson(statePath(), state, 0o600);
