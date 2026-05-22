# Claude Code for Pulsar

A [Claude Code](https://claude.ai/code) integration for the [Pulsar editor](https://pulsar-edit.dev/) — bringing AI-assisted coding directly into your editor panel.

Built by [BeanGreen247](https://beangreen247.xyz).

---

## Features

- **Chat panel** — docked sidebar for ongoing conversations with Claude
- **Session history** — browse and resume previous sessions
- **Prompt history** — press `↑` / `↓` in the input box to cycle through past prompts
- **Stop generation** — cancel an in-progress response at any time with the Stop button
- **Copy messages** — hover any message to reveal a Copy button; code blocks have their own copy button
- **File & selection attachments** — attach the active file, a text selection, or an image from the clipboard
- **Research mode** — enables deep web search with source citations
- **Permission modes** — control what Claude is allowed to edit or run
- **Usage bars** — real-time token and cost tracking per message and session
- **Markdown rendering** — full markdown support with syntax-highlighted code blocks
- **Theme support** — auto follows Pulsar's UI theme, or force dark/light

## Installation

### From source

```bash
git clone https://github.com/BeanGreen247/claude-code-pulsar
cd claude-code-pulsar
ln -s "$(pwd)" ~/.pulsar/packages/claude-code
```

Then restart Pulsar and enable the package under **Settings → Packages**.

### Requirements

- [Pulsar](https://pulsar-edit.dev/) 1.100 or later
- [Claude Code CLI](https://claude.ai/code) installed and on your `PATH`
  ```bash
  npm install -g @anthropic-ai/claude-code
  ```

## Usage

| Action | How |
|--------|-----|
| Open panel | `Alt+C` or **Packages → Claude Code → Toggle** |
| Send prompt | `Ctrl+Enter` or click **Send** |
| Stop generation | Click **Stop** while Claude is responding |
| New line in input | `Enter` |
| Previous prompt | `↑` (when cursor is at start of input) |
| Next prompt | `↓` (while navigating history) |
| Attach selection | `Ctrl+Shift+A` or click **Selection** in the attach bar |
| Paste image | `Ctrl+V` in the input box, or click **Paste image** |
| Copy a message | Hover the message → click **Copy** |
| Copy a code block | Click **Copy** in the code block header |
| View account & usage | Hover the **@** button in the panel header |
| Open on GitHub | Click the **ⓘ** info button in the panel header |

## CLI vs API mode

| | CLI mode | API mode |
|---|---|---|
| **Requires** | `claude` CLI installed & logged in | Anthropic API key |
| **File editing** | Yes | No (describe changes) |
| **Shell commands** | Yes | No |
| **Speed** | Faster (local auth, no API quota) | Depends on API load |
| **Session history** | Persistent (CLI manages) | In-memory per session |

The extension **auto-detects** which mode to use on startup. CLI mode is always preferred. API mode is the automatic fallback when the CLI is not found.

The active mode is shown as a small badge in the panel header next to the "Claude Code" title:

- **`CLI`** (green) — local claude binary found; full functionality available
- **`API`** (amber) — falling back to the Anthropic API; hover the badge for details

> **Tip:** Installing the claude CLI and logging in is faster, enables file editing, and avoids API rate limits. Get it at [claude.ai/code](https://claude.ai/code).

### API key setup (API mode only)

Set your key in one of two ways:

```bash
# Option A: environment variable (recommended)
export ANTHROPIC_API_KEY=sk-ant-...

# Option B: package setting
# Settings → Packages → claude-code → API Key
```

API requests use **prompt caching** (system prompt + conversation history are cached on Anthropic's servers for ~5 minutes) and automatically retry up to 3 times with backoff when the server returns a 529 overload error.

## Configuration

Open **Settings → Packages → claude-code** to configure:

- **CLI path** — path to the `claude` executable (default: `claude`)
- **Panel position** — left, right, or bottom dock
- **Model** — override the model (e.g. `claude-opus-4-7`; defaults to `claude-sonnet-4-6` in API mode)
- **Permission mode** — Allow Edits / Allow All / Read Only (CLI mode only)
- **Theme** — auto / dark / light
- **API key** — Anthropic API key for API mode fallback

## License

MIT © [BeanGreen247](https://beangreen247.xyz)
