import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { home } from './paths.js';
import { readJson, writeJson } from './util.js';

const SERVICE = 'cprov';

const has = (cmd) => spawnSync('sh', ['-c', `command -v ${cmd}`]).status === 0;

// macOS Keychain. The secret goes through `security -i` on stdin so it never shows up in `ps`.
const keychain = {
  name: 'macOS Keychain',
  get(account) {
    const r = spawnSync('security', ['find-generic-password', '-a', account, '-s', SERVICE, '-w'], {
      encoding: 'utf8',
    });
    return r.status === 0 ? r.stdout.replace(/\n$/, '') : null;
  },
  set(account, secret) {
    const q = (s) => `"${s.replace(/(["\\])/g, '\\$1')}"`;
    spawnSync('security', ['-i'], {
      input: `add-generic-password -U -a ${q(account)} -s ${SERVICE} -l ${q(`cprov: ${account}`)} -w ${q(secret)}\n`,
    });
    // `security -i` exits 0 even when the command fails, so read it back.
    if (keychain.get(account) !== secret) throw new Error('could not write to the macOS Keychain');
  },
  delete(account) {
    spawnSync('security', ['delete-generic-password', '-a', account, '-s', SERVICE]);
  },
};

const libsecret = {
  name: 'Secret Service (libsecret)',
  get(account) {
    const r = spawnSync('secret-tool', ['lookup', 'service', SERVICE, 'account', account], { encoding: 'utf8' });
    return r.status === 0 && r.stdout ? r.stdout.replace(/\n$/, '') : null;
  },
  set(account, secret) {
    const r = spawnSync(
      'secret-tool',
      ['store', '--label', `cprov: ${account}`, 'service', SERVICE, 'account', account],
      { input: secret },
    );
    if (r.status !== 0) throw new Error(`secret-tool failed: ${String(r.stderr).trim()}`);
  },
  delete(account) {
    spawnSync('secret-tool', ['clear', 'service', SERVICE, 'account', account]);
  },
};

// Last resort: a 0600 JSON file next to the profiles.
const file = {
  name: 'file (0600)',
  path: () => path.join(home(), 'secrets.json'),
  get(account) {
    return readJson(file.path(), {})[account] ?? null;
  },
  set(account, secret) {
    writeJson(file.path(), { ...readJson(file.path(), {}), [account]: secret }, 0o600);
  },
  delete(account) {
    const all = readJson(file.path(), {});
    delete all[account];
    writeJson(file.path(), all, 0o600);
  },
};

export function secretStore() {
  const forced = process.env.CPROV_SECRET_BACKEND;
  if (forced === 'file') return file;
  if (forced === 'keychain') return keychain;
  if (forced === 'libsecret') return libsecret;
  if (process.platform === 'darwin') return keychain;
  if (process.platform === 'linux' && has('secret-tool')) return libsecret;
  return file;
}
