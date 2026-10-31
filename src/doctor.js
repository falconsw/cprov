import { resolveProvider } from './settings.js';

// Sends the smallest possible request so a bad key, empty balance or wrong model name
// shows up now instead of in the middle of a Claude Code session.
export async function ping(profile, key, { timeoutMs = 30000 } = {}) {
  const provider = resolveProvider(profile);
  const url = `${provider.baseUrl.replace(/\/+$/, '')}/v1/messages`;
  const started = Date.now();
  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'anthropic-version': '2023-06-01',
        'x-api-key': key,
        ...(!provider.native && { authorization: `Bearer ${key}` }),
      },
      body: JSON.stringify({
        model: profile.model.replace(/\[[^\]]*\]$/, ''),
        max_tokens: 1,
        messages: [{ role: 'user', content: 'ping' }],
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    return { ok: false, kind: 'network', message: err.cause?.message || err.message };
  }
  const ms = Date.now() - started;
  const text = await res.text();
  if (res.ok) return { ok: true, ms, status: res.status };
  let message = text.slice(0, 300);
  try {
    const body = JSON.parse(text);
    message = body.error?.message || body.message || body.base_resp?.status_msg || message;
  } catch {}
  return { ok: false, ms, status: res.status, kind: classify(res.status, message), message };
}

function classify(status, message) {
  const m = message.toLowerCase();
  if (/balance|quota|insufficient|credit|billing|payment|recharge/.test(m) || status === 402) return 'billing';
  if (status === 401 || status === 403 || /api[ _-]?key|unauthori[sz]ed|authenticat|invalid (auth )?token/.test(m)) return 'auth';
  if (/model/.test(m) || status === 404) return 'model';
  if (status === 429) return 'rate';
  return 'other';
}
