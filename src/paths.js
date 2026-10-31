import os from 'node:os';
import path from 'node:path';

// Functions rather than constants so tests can point everything at a temp dir via env.
export const home = () =>
  process.env.CPROV_HOME ||
  path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'cprov');
export const profilesDir = () => path.join(home(), 'profiles');
export const statePath = () => path.join(home(), 'state.json');
export const claudeDir = () => process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
export const claudeSettingsPath = () => path.join(claudeDir(), 'settings.json');
