# Claude Code for Pulsar

> **Pulsar setup & performance tweaks:** see [tweaks.md](tweaks.md) for install commands, disabled packages, config.cson, init.js, and the Electron/Wayland launch wrapper.

> [!WARNING]
> **As for Anthropics latest controversy, there are severe penalties for developers.**
> The main issue lies in pricing and understanding what Anthropic allows its users to do with their tool.
> To avoid the risk of being hit with a 200$+ bill, I've decided to strip down this claude integration to its most basic form.
> The integration does work and there is no need to worry if it will keep on working, it is just stripped down.
>
> Video for reference https://youtu.be/131yAOjxHHQ?si=yYRr2lFikxu0P31j
>
> Other links:
>
> https://x.com/ClaudeDevs/status/2054610152817619388
> https://x.com/ClaudeDevs/status/2054639777685934564
> https://x.com/noahzweben/status/2054615670684619255
> https://x.com/mattpocockuk/status/2040536403289764275
>
> And to quote a fellow user who wants to see Claude improve : "I have never before experienced, from any developer tool, such a frustrating lack of clarity over the basic terms of usage."

A [Claude Code](https://claude.ai/code) integration for the [Pulsar editor](https://pulsar-edit.dev/) — embeds a full Claude Code terminal directly in an editor panel.

Built by [BeanGreen247](https://beangreen247.xyz).

---

## How it works

Opening the panel spawns an interactive `claude` process inside an [xterm.js](https://xtermjs.org/) terminal. You get the full Claude Code TUI — tool use, file editing, shell commands, web search — exactly as you would in a standalone terminal, but docked inside Pulsar.

---

## Requirements

- [Pulsar](https://pulsar-edit.dev/) 1.100 or later
- [Claude Code CLI](https://claude.ai/code) installed and authenticated

### Install and log in to the CLI

**macOS / Linux / WSL**
```bash
curl -fsSL https://claude.ai/install.sh | bash
claude login
```

**Windows (PowerShell)**
```powershell
irm https://claude.ai/install.ps1 | iex
claude login
```

`claude login` opens a browser to authenticate with your Anthropic account. It writes credentials to `~/.claude/.credentials.json`. The extension reads that file automatically — no extra setup required.

---

## Installation

```bash
git clone https://github.com/BeanGreen247/claude-code-pulsar
cd claude-code-pulsar
ln -s "$(pwd)" ~/.pulsar/packages/claude-code
```

Then restart Pulsar and enable the package under **Settings → Packages**.

### Native dependencies (xterm.js + node-pty)

Run once from the package directory:

```bash
/opt/Pulsar/resources/app/ppm/bin/node \
  /opt/Pulsar/resources/app/ppm/node_modules/.bin/npm install
```

This installs `@xterm/xterm` and `@xterm/addon-fit` against Pulsar's bundled Node. `node-pty` is already bundled with Pulsar and is used directly from there.

---

## Usage

| Action | How |
|--------|-----|
| Open / show panel | `Ctrl+Alt+C` or **Packages → Claude Code → Toggle** |
| New Claude session | `Ctrl+Alt+N` or **Packages → Claude Code → New Chat** |
| Restart after exit | Press any key when `[press any key to restart]` appears |
| All Claude features | Use Claude normally — tool use, `/commands`, file editing, etc. |

The panel is a real terminal. Everything you can do in `claude` in a standalone terminal works here.

---

## Configuration

Open **Settings → Packages → claude-code**:

| Setting | Default | Description |
|---------|---------|-------------|
| **CLI path** | `claude` | Path to the `claude` executable if it is not on `PATH` |
| **Panel position** | `right` | Dock position: `left`, `right`, or `bottom` |
| **Protect system files** | `true` | Block writes to `/etc`, `/usr`, `/bin`, `/lib`, `~/.ssh`, `~/.gnupg`, etc. Disable only if you need to edit system configuration. |

---

## Account info in the header

After the welcome banner is suppressed, the panel writes a one-line header:

```
/path/to/project  ·  pro  ·  default_claude_ai
```

Fields are read directly from `~/.claude/.credentials.json` (created by `claude login`):

| Field | Source |
|-------|--------|
| Working directory | Active Pulsar project path |
| Subscription tier | `claudeAiOauth.subscriptionType` |
| Rate-limit tier | `claudeAiOauth.rateLimitTier` |

If the credentials file does not exist or a field is missing, that part of the header is omitted silently.

---

## Preventing AI co-author entries in git

Claude Code can append `Co-Authored-By:` trailers to commit messages, causing AI accounts to appear in your repository's contributor list on GitHub.

To strip them automatically on every commit:

```bash
mkdir -p ~/.config/git/hooks

cat > ~/.config/git/hooks/commit-msg << 'EOF'
#!/bin/sh
sed -i '/^[Cc]o-[Aa]uthor/d' "$1"
EOF

chmod +x ~/.config/git/hooks/commit-msg
git config --global core.hooksPath ~/.config/git/hooks
```

---

## Changelog

### 28.05.24
- addded tweaks.md file to give advice on how to get the most out of the Pulsar editor
- Scrolling is still not fixed, seems to be a permanent issue, most likey an implementation issue

### 26.05.24
- Fixed white borders appearing around the terminal panel
- ~~Fixed scrolling — wheel-scroll through history now works (xterm scrollback re-enabled; scrollbar remains hidden)~~

---

## License

MIT © [BeanGreen247](https://beangreen247.xyz)
