import { readFileSync } from 'node:fs';

const catalog = JSON.parse(readFileSync(new URL('../providers.json', import.meta.url), 'utf8'));

export const catalogDefaults = () => catalog.defaults;
export const providers = () => catalog.providers;
export const getProvider = (id) => catalog.providers.find((p) => p.id === id);
export const defaultModel = (provider) =>
  (provider.models.find((m) => m.default) || provider.models[0]).id;

export function providerForUrl(url) {
  const norm = (u) => {
    try {
      const x = new URL(u);
      return x.host + x.pathname.replace(/\/+$/, '');
    } catch {
      return null;
    }
  };
  const target = norm(url);
  return catalog.providers.find((p) => norm(p.baseUrl) === target);
}
