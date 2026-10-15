# glaude

Run **Claude Code** and **Codex** on [Gloo AI](https://docs.gloo.com) models.

> Unofficial community project. Not affiliated with or endorsed by Gloo.

- `glaude`: Claude Code, backed by Gloo's Claude models
- `godex`: Codex, backed by any Gloo model

Both commands start a small local proxy on demand (`127.0.0.1:8787`). It translates Claude Code's Anthropic Messages API into Gloo's Direct Responses API, and cleans up Codex's Responses requests so Gloo accepts them.

## Install

Requires macOS or Linux, Node.js 24+, git, and a [Gloo AI API key](https://docs.gloo.com/studio/manage-api-credentials).

```bash
curl -fsSL https://raw.githubusercontent.com/matthewmichel/glaude/main/install.sh | bash
```

The installer asks for your API key and saves it to `~/.config/glaude/env` (mode 600). To install without the prompt, pass the key in the environment: `curl ... | GLOO_API_KEY=sk_... bash`.

You also need the agent CLIs themselves:

- [Claude Code](https://code.claude.com/docs/en/setup) for `glaude`
- `npm install -g @openai/codex` for `godex`

## Use

```bash
glaude                    # any claude flags work, e.g. glaude -p "explain this repo"
godex                     # any codex flags work, e.g. godex exec "fix the tests"
godex -m gloo-openai-gpt-5-mini
```

Both commands also take these flags:

| Flag | What it does |
| --- | --- |
| `--update` | Pull the latest version and restart the proxy |
| `--proxy-log` | Follow the proxy log |
| `--stop-proxy` | Stop the background proxy |

Gloo publishes its list of model IDs at <https://platform.ai.gloo.com/platform/v2/models>.

## Configuration

Settings live in `~/.config/glaude/env`:

| Variable | Default | Purpose |
| --- | --- | --- |
| `GLOO_API_KEY` | | Your Gloo key |
| `PORT` | `8787` | Local proxy port |
| `GODEX_MODEL` | `gloo-anthropic-claude-sonnet-4.6` | Codex model when `-m` is not given |
| `GLOO_DEFAULT_MODEL` | | Fallback when a Claude model id has no Gloo equivalent |
| `GLOO_MODEL_MAP` | `{}` | JSON object of exact model-id overrides |
| `GLOO_CACHE_TTL` | `auto` | Anthropic prompt caching: `auto`, `5m`, `1h`, `off` |
| `GLOO_PROXY_DEBUG` | `false` | Log full translated requests and stream events |

After editing this file, run `glaude --stop-proxy`. The next command starts the proxy with the new settings.

## Known limitations

- Gloo returns no reasoning for Claude models, so extended thinking does not show up.
- Gloo can't run hosted web search, so Claude Code's WebSearch tool and Codex's `web_search` are removed from requests.
- `count_tokens` is an estimate, because Gloo has no token-counting endpoint.

## Uninstall

```bash
curl -fsSL https://raw.githubusercontent.com/matthewmichel/glaude/main/install.sh | bash -s -- --uninstall
```

## Development

```bash
npm install && npm test && npm run typecheck
cp .env.example .env && npm start   # run the proxy in the foreground
```
