# cprov

Switch [Claude Code](https://claude.com/claude-code) between Anthropic, Z.ai (GLM), MiniMax and any
Anthropic-compatible provider, without hand-editing `settings.json` or keeping API keys in plain text.

```console
$ cprov add
? Provider Z.ai (GLM)
  Get a key here: https://z.ai/manage-apikey/apikey-list
? Z.ai (GLM) API key › ****************************
  Checking the key…
✓ Key works (glm-5.3-flash[1m], 412 ms)
? Profile name (glm) ›
✓ Profile "glm" created. Key stored in macOS Keychain.

$ cprov glm          # this terminal talks to GLM
$ cprov opus         # another terminal talks to Claude, at the same time
```

## Install

```sh
npm install -g @falconsw/cprov
```

Node 18+ and Claude Code are required. No other dependencies.

## How it works

- **Profiles, not file copies.** A profile only stores what differs: provider, model, auth type.
  Plugins and everything else in your `~/.claude/settings.json` stay untouched.
- **Keys in the OS keychain.** macOS Keychain, Secret Service (`secret-tool`) on Linux, or a
  `0600` file as a last resort. Profile files never contain a key.
- **Per session or default.**
  - `cprov <profile>` starts `claude --settings <overlay>` with the key in the child's environment.
    Only that session is affected, so different terminals can use different providers.
  - `cprov use <profile>` writes the overlay into `~/.claude/settings.json` (backup in
    `settings.json.cprov-backup`) with an `apiKeyHelper` that reads the key from the keychain,
    so plain `claude` uses it.
  - `cprov use <profile> --env-key` also keeps the key in `settings.json` env, for apps that only
    read that file or the session's environment (Leftover, Cost Info, limit dashboards). The choice
    sticks until `--no-env-key`; `cprov doctor` flags the plain-text copy while it lasts.
- **Provider catalog.** Base URLs, model names, context sizes and model-picker entries come from
  [`providers.json`](providers.json). For gateways, all model tiers (Opus/Sonnet/Haiku) are mapped
  to the chosen model.
- **Checked up front.** `cprov add` and `cprov doctor` send a 1-token request so a wrong key,
  empty balance or wrong model name shows up immediately.
- **Other tools that want the key.** Three documented ways, best first: run the `apiKeyHelper`
  from `settings.json` (that command is `cprov key <profile>`), read the OS keychain directly
  (service `cprov`, account = profile name), or turn on `cprov use --env-key` so `settings.json`
  env carries the key the way a hand-made setup did.

## Commands

| Command | |
| --- | --- |
| `cprov add [provider]` | Create a profile (interactive) |
| `cprov <profile> [claude args]` | Start Claude Code with a profile, this session only |
| `cprov use <profile>` | Make a profile the default for plain `claude` |
| `cprov ls` / `cprov current` | List profiles / show the default |
| `cprov rm <profile>` | Delete a profile and its key |
| `cprov doctor [profile]` | Check Claude Code, stored keys, endpoints and leftover plain-text keys |
| `cprov import` | Turn existing `~/.claude/settings-*.json` files into profiles |
| `cprov providers` | List built-in providers and models |

Scripted setup:

```sh
echo "$ZAI_KEY" | cprov add zai --key-stdin --name glm
cprov add minimax --model MiniMax-M2.7 --key-stdin < key.txt
cprov add custom --base-url https://llm.example.com/anthropic --model my-model --key-stdin < key.txt
cprov add anthropic --subscription --name opus
```

## Coming from a hand-made setup?

If you switch by copying `settings-glm.json`, `settings-minimax.json`… over `settings.json`:

```sh
cprov import     # profiles from those files, keys moved to the keychain
cprov doctor     # every endpoint answers?
cprov use opus   # let cprov manage settings.json from now on
```

Then delete the old files; they still contain plain-text keys.

## Adding a provider

Edit [`providers.json`](providers.json) and open a pull request. Any Anthropic-compatible endpoint
works today through `cprov add custom`.

## Türkçe

Arayüz Türkçe sistem dilinde otomatik Türkçe açılır; zorlamak için `CPROV_LANG=tr`.
Kısaca: `cprov add` ile sağlayıcıyı seç, anahtarı yapıştır (Keychain'e gider), `cprov glm` ile o
oturumu GLM'de aç ya da `cprov use glm` ile varsayılan yap.

---

Not affiliated with Anthropic. "Claude" is a trademark of Anthropic, PBC.

MIT License
