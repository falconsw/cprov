import readline from 'node:readline';
import { c } from './util.js';
import { t } from './i18n.js';

// Tiny dependency-free prompts so `npx cprov` installs nothing.

const out = process.stderr;
export const interactive = () => Boolean(process.stdin.isTTY && out.isTTY);

function rawSession(onData) {
  return new Promise((resolve, reject) => {
    const { stdin } = process;
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');
    const done = (fn, value) => {
      stdin.off('data', handler);
      stdin.setRawMode(false);
      stdin.pause();
      fn(value);
    };
    const handler = (chunk) => {
      if (chunk === '\u0003') {
        out.write('\x1b[?25h\n');
        process.exit(130);
      }
      onData(chunk, (v) => done(resolve, v), (e) => done(reject, e));
    };
    stdin.on('data', handler);
  });
}

export async function select(question, choices, initial = 0) {
  if (!interactive()) throw new Error(t('err.needTty'));
  let index = initial;
  const render = (first) => {
    if (!first) out.write(`\x1b[${choices.length}A`);
    for (const [i, ch] of choices.entries()) {
      const line = i === index ? c.cyan(`❯ ${ch.label}`) : `  ${ch.label}`;
      out.write(`\x1b[2K${line}${ch.hint ? c.dim(`  ${ch.hint}`) : ''}\n`);
    }
  };
  out.write(`${c.green('?')} ${c.bold(question)}\n\x1b[?25l`);
  render(true);
  const value = await rawSession((chunk, resolve) => {
    if (chunk === '\x1b[A' || chunk === 'k') index = (index - 1 + choices.length) % choices.length;
    else if (chunk === '\x1b[B' || chunk === 'j') index = (index + 1) % choices.length;
    else if (/^[1-9]$/.test(chunk) && Number(chunk) <= choices.length) index = Number(chunk) - 1;
    else if (chunk === '\r' || chunk === '\n') return resolve(choices[index].value);
    else return;
    render(false);
  });
  out.write(`\x1b[${choices.length}A\x1b[J\x1b[1A\x1b[2K${c.green('?')} ${c.bold(question)} ${c.cyan(choices[index].label)}\n\x1b[?25h`);
  return value;
}

export async function input(question, { initial = '', mask = false, validate } = {}) {
  if (!interactive()) throw new Error(t('err.needTty'));
  for (;;) {
    const hint = initial ? c.dim(` (${initial})`) : '';
    out.write(`${c.green('?')} ${c.bold(question)}${hint} › `);
    let value = await (mask ? readMasked() : readLine());
    value = value.trim() || initial;
    const problem = validate?.(value);
    if (!problem) return value;
    out.write(`  ${c.red(problem)}\n`);
  }
}

function readLine() {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: out, terminal: true });
    rl.once('line', (line) => {
      rl.close();
      resolve(line);
    });
  });
}

function readMasked() {
  let value = '';
  return rawSession((chunk, resolve) => {
    // Pastes arrive as one chunk; walk it character by character.
    for (const ch of chunk.replace(/\x1b\[20[01]~/g, '')) {
      if (ch === '\r' || ch === '\n') {
        out.write('\n');
        return resolve(value);
      }
      if (ch === '\u007f' || ch === '\b') {
        if (value) {
          value = value.slice(0, -1);
          out.write('\b \b');
        }
      } else if (ch >= ' ') {
        value += ch;
        out.write('*');
      }
    }
  });
}

export async function confirm(question, initial = true) {
  const answer = await input(`${question} ${c.dim(initial ? '[Y/n]' : '[y/N]')}`);
  if (!answer) return initial;
  return /^(y|yes|e|evet)$/i.test(answer);
}
