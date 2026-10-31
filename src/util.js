import fs from 'node:fs';
import path from 'node:path';

export function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT' && fallback !== undefined) return fallback;
    throw new Error(`${file}: ${err.message}`);
  }
}

// Atomic write; keeps an existing file's mode unless one is given.
export function writeJson(file, data, mode) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  let fileMode = mode;
  if (fileMode === undefined) {
    try {
      fileMode = fs.statSync(file).mode & 0o777;
    } catch {
      fileMode = 0o600;
    }
  }
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', { mode: fileMode });
  fs.chmodSync(tmp, fileMode);
  fs.renameSync(tmp, file);
}

export const shellQuote = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const paint = (code) => (s) => (useColor ? `\x1b[${code}m${s}\x1b[0m` : String(s));
export const c = {
  bold: paint('1'),
  dim: paint('2'),
  red: paint('31'),
  green: paint('32'),
  yellow: paint('33'),
  cyan: paint('36'),
};
