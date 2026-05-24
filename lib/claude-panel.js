'use strict'

const { Emitter, CompositeDisposable } = require('atom')
const path = require('path')
const os   = require('os')

// node-pty is bundled with Pulsar — use that copy so the native binary
// matches the Electron ABI Pulsar is running on.
// process.resourcesPath is an Electron built-in:
//   Linux  : /opt/Pulsar/resources
//   macOS  : /Applications/Pulsar.app/Contents/Resources
//   Windows: C:\Users\…\AppData\Local\Programs\Pulsar\resources
const NODE_PTY_PATH = path.join(
  process.resourcesPath ||
    path.dirname(path.dirname(path.dirname(require.resolve('atom')))),
  'app.asar.unpacked', 'node_modules', 'node-pty'
)

// Appended every turn — keep as short as possible to minimise token spend.
const EFFICIENCY_PROMPT = 'No preamble. Work silently. When done: one bullet per file changed or command run, 3 max.'

const SYSTEM_PATHS = (() => {
  if (process.platform === 'win32') {
    return ['C:\\Windows\\', 'C:\\Program Files\\', 'C:\\Program Files (x86)\\', 'C:\\ProgramData\\']
  }
  if (process.platform === 'darwin') {
    return ['/System/', '/Library/', '/usr/', '/bin/', '/sbin/', '/private/etc/', '/private/var/']
  }
  return ['/etc/', '/usr/', '/bin/', '/sbin/', '/boot/', '/sys/', '/proc/', '/dev/', '/lib/', '/lib64/', '/root/', '/snap/', '/opt/Pulsar/']
})()

const HOME_PATHS = ['.ssh/', '.gnupg/']


class TerminalPanel {
  constructor() {
    this.emitter       = new Emitter()
    this.subscriptions = new CompositeDisposable()
    this.pty           = null
    this.terminal      = null
    this.fitAddon      = null
    this._exitPending  = false

    this._buildElement()
    setTimeout(() => this._start(), 50)
  }

  // ── Pane item API ─────────────────────────────────────────────────────────

  getTitle()           { return 'Claude Code' }
  getURI()             { return 'atom://claude-code' }
  getIconName()        { return 'claude-code-icon' }
  getDefaultLocation() { return atom.config.get('claude-code.panelPosition') || 'right' }
  getAllowedLocations() { return ['left', 'right', 'bottom', 'center'] }
  getElement()         { return this.element }
  serialize()          { return { deserializer: 'ClaudePanel' } }

  destroy() {
    this._killPty()
    if (this._resizeObserver) { this._resizeObserver.disconnect(); this._resizeObserver = null }
    if (this.terminal) { try { this.terminal.dispose() } catch (_) {} this.terminal = null }
    this.subscriptions.dispose()
    this.emitter.emit('did-destroy')
    this.emitter.dispose()
  }

  onDidDestroy(cb) { return this.emitter.on('did-destroy', cb) }
  focus()          { if (this.terminal) this.terminal.focus() }

  newChat()       { this._restart() }
  showNoHistory() {}
  resumeSession() {}
  getSessionId()  { return null }
  send(text)      { if (this.pty) this.pty.write(text + '\r') }
  attachContext() {}

  // ── DOM ───────────────────────────────────────────────────────────────────

  _buildElement() {
    const el = document.createElement('div')
    el.className = 'cc-term-wrap'
    this.termContainer = document.createElement('div')
    this.termContainer.className = 'cc-term-container'
    el.appendChild(this.termContainer)
    this.element = el
  }

  // ── Init ──────────────────────────────────────────────────────────────────

  _start() {
    let Terminal, FitAddon
    try {
      Terminal = require('@xterm/xterm').Terminal
      FitAddon = require('@xterm/addon-fit').FitAddon
    } catch (_) {
      this._showError('xterm not installed.\n\nRun: npm install  (in the package directory)')
      return
    }

    // Load xterm's own CSS from its package directory rather than inlining it,
    // so we always have the correct rules for the installed version.
    if (!document.getElementById('cc-xterm-css')) {
      try {
        const xtermPkg  = require.resolve('@xterm/xterm/package.json')
        const xtermCss  = path.join(path.dirname(xtermPkg), 'css', 'xterm.css')
        const link      = document.createElement('link')
        link.id         = 'cc-xterm-css'
        link.rel        = 'stylesheet'
        link.href       = 'file://' + xtermCss
        document.head.appendChild(link)
      } catch (_) {}
    }

    let nodePty
    try {
      nodePty = require(NODE_PTY_PATH)
    } catch (e) {
      this._showError(`node-pty could not be loaded:\n${e.message}`)
      return
    }

    this.terminal = new Terminal({
      cursorBlink:         true,
      cursorStyle:         'block',
      cursorInactiveStyle: 'block',
      fontSize:            this._fontSize(),
      fontFamily:
        atom.config.get('editor.fontFamily') ||
        '"Cascadia Code","Fira Code","JetBrains Mono","DejaVu Sans Mono",' +
        'Menlo,Consolas,"Courier New",monospace',
      scrollback:        1000,
      allowTransparency: false,
      convertEol:        true,
      unicodeVersion:    '6',
      theme:             this._buildXtermTheme(),
    })

    this.fitAddon = new FitAddon()
    this.terminal.loadAddon(this.fitAddon)
    this.terminal.open(this.termContainer)

    // Apply the exact detected background to every container layer so there
    // is no colour mismatch between the CSS variable and xterm's canvas paint.
    this._applyBg()

    // Wait for web fonts to finish loading before FitAddon measures glyph
    // widths.  If we fit before fonts are ready, xterm uses fallback metrics →
    // wrong cols/rows → Claude's TUI renders with garbled borders and the
    // input box is not at the bottom.
    const fontsReady = (typeof document !== 'undefined' && document.fonts && document.fonts.ready)
      ? document.fonts.ready
      : Promise.resolve()

    fontsReady.then(() => new Promise(resolve => requestAnimationFrame(resolve))).then(() => {
      this._applyBg()
      this._fit()

      this.subscriptions.add(
        atom.config.onDidChange('editor.fontSize',      () => this._applyFontSize()),
        atom.config.onDidChange('claude-code.fontSize', () => this._applyFontSize()),
        atom.themes.onDidChangeActiveThemes(() => this._applyThemeBg()),
      )

      const cliPath = this._cliPath()
      const cwd     = atom.project.getPaths()[0] || os.homedir()
      this._spawnClaude(nodePty, cliPath, cwd)
    })
  }

  // ── Spawn ─────────────────────────────────────────────────────────────────

  _spawnClaude(nodePty, cliPath, cwd) {
    const cols = Math.max(this.terminal ? this.terminal.cols : 80, 80)
    const rows = Math.max(this.terminal ? this.terminal.rows : 24, 24)

    // COLORFGBG is the standard env var apps use to detect terminal dark/light.
    // Format: "fg_index;bg_index" — 0=black 15=white.
    // Dark terminal → light fg on dark bg → "15;0"
    // Light terminal → dark fg on light bg → "0;15"
    const dark = this._isDark(this._editorBg())

    const env = {
      ...process.env,
      TERM:                                     'xterm-256color',
      COLORTERM:                                'truecolor',
      COLORFGBG:                                dark ? '15;0' : '0;15',
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
      CLAUDE_CODE_DISABLE_TERMINAL_TITLE:       '1',
      CLAUDE_CODE_HIDE_CWD:                     '1',
    }

    try {
      this.pty = nodePty.spawn(cliPath, this._spawnArgs(), {
        name: 'xterm-256color',
        cols,
        rows,
        cwd,
        env,
      })
    } catch (err) {
      this.terminal.writeln(`\x1b[31merror: could not start '${cliPath}': ${err.message}\x1b[0m`)
      this.terminal.writeln(`\x1b[33mInstall:  npm install -g @anthropic-ai/claude-code\x1b[0m`)
      this.terminal.writeln(`\x1b[33mLog in:   claude login\x1b[0m`)
      return
    }

    this.pty.onData((data) => { if (this.terminal) this.terminal.write(data) })
    this.pty.onExit(({ exitCode }) => { this._onPtyExit(exitCode) })
    this.terminal.onData((data) => this._onTermData(data))

    if (!this._resizeObserver) {
      this._resizeObserver = new ResizeObserver(() => this._fit())
      this._resizeObserver.observe(this.termContainer)
    }

    this.terminal.focus()
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  _cliPath() {
    const configured = atom.config.get('claude-code.cliPath') || 'claude'
    // npm-installed CLIs on Windows are .cmd wrappers
    if (process.platform === 'win32' && !path.extname(configured)) {
      return configured + '.cmd'
    }
    return configured
  }

  _spawnArgs() {
    const args = [
      '--tools', 'Read,Write,Edit,MultiEdit,Bash,Glob,Grep,WebSearch,WebFetch,TodoRead,TodoWrite',
      '--exclude-dynamic-system-prompt-sections',
    ]

    const model    = atom.config.get('claude-code.model')
    const maxTurns = atom.config.get('claude-code.maxTurns') || 25
    if (model) args.push('--model', model)
    args.push('--max-turns', String(maxTurns))

    const protect = atom.config.get('claude-code.protectSystemFiles') !== false
    if (protect) {
      const home    = os.homedir()
      const blocked = [
        ...SYSTEM_PATHS,
        ...HOME_PATHS.map(p => path.join(home, p) + path.sep),
      ]
      const pat = blocked.map(p => `${p}*`).join(',')
      args.push('--disallowedTools', `Write(${pat}),Edit(${pat}),MultiEdit(${pat})`)
    }

    args.push('--append-system-prompt', EFFICIENCY_PROMPT)

    return args
  }

  _onTermData(data) {
    if (this._exitPending) { this._exitPending = false; this._restart(); return }
    if (this.pty) this.pty.write(data)
  }

  _onPtyExit(exitCode) {
    if (!this.terminal) return
    this.terminal.writeln(`\r\n\x1b[2m[process exited: ${exitCode}]\x1b[0m`)
    this.terminal.writeln(`\x1b[2m[press any key to restart]\x1b[0m`)
    this._exitPending = true
    this.pty = null
  }

  _editorBg() {
    // Priority 1: a live atom-text-editor element — has the syntax theme fully applied.
    for (const sel of ['atom-text-editor.is-focused', 'atom-text-editor']) {
      try {
        const el = document.querySelector(sel)
        if (el) {
          const hex = this._rgbToHex(getComputedStyle(el).backgroundColor)
          if (hex) return hex
        }
      } catch (_) {}
    }
    // Priority 2: probe a .cc-term-wrap div inside atom-workspace so the full
    // style cascade (including @syntax-background-color) is applied.
    try {
      const root  = document.querySelector('atom-workspace') || document.body
      const probe = document.createElement('div')
      probe.className = 'cc-term-wrap'
      probe.style.cssText = 'position:absolute;top:-9999px;width:1px;height:1px;visibility:hidden'
      root.appendChild(probe)
      const hex = this._rgbToHex(getComputedStyle(probe).backgroundColor)
      root.removeChild(probe)
      if (hex) return hex
    } catch (_) {}
    return '#1e1e1e'
  }

  _rgbToHex(rgb) {
    const m = (rgb || '').match(/[\d.]+/g)
    if (!m || m.length < 3) return null
    const a = m.length >= 4 ? +m[3] : 1
    if (a === 0) return null               // fully transparent — no colour info
    const hex = [+m[0], +m[1], +m[2]]
      .map(n => Math.round(n).toString(16).padStart(2, '0')).join('')
    if (hex === '000000') return null      // pure black is usually "no style applied"
    return '#' + hex
  }

  _applyThemeBg() {
    if (!this.terminal) return
    this.terminal.options.theme = this._buildXtermTheme()
    this._applyBg()
  }

  // Set background on every container layer using the same colour that xterm
  // uses for theme.background — eliminates any mismatch between the Less
  // @syntax-background-color variable and the live computed style.
  _applyBg() {
    const bg = this._editorBg()
    if (this.element)        this.element.style.background        = bg
    if (this.termContainer)  this.termContainer.style.background  = bg
    // Also patch the xterm-viewport if it exists, for the scrollbar-gutter area.
    if (this.terminal && this.terminal.element) {
      const vp = this.terminal.element.querySelector('.xterm-viewport')
      if (vp) vp.style.backgroundColor = bg
    }
  }

  _buildXtermTheme() {
    const bg   = this._editorBg()
    const fg   = this._probeFg(bg)
    const dark = this._isDark(bg)

    if (dark) {
      // Pulsar One Dark palette
      return {
        background:          bg,
        foreground:          fg,
        cursor:              '#528bff',
        cursorAccent:        bg,
        selectionBackground: 'rgba(255,255,255,0.15)',
        black:               bg,        brightBlack:   '#5c6370',
        red:                 '#e06c75', brightRed:     '#e06c75',
        green:               '#98c379', brightGreen:   '#98c379',
        yellow:              '#e5c07b', brightYellow:  '#e5c07b',
        blue:                '#61afef', brightBlue:    '#61afef',
        magenta:             '#c678dd', brightMagenta: '#c678dd',
        cyan:                '#56b6c2', brightCyan:    '#56b6c2',
        white:               fg,        brightWhite:   '#ffffff',
      }
    } else {
      // Pulsar One Light palette
      return {
        background:          bg,
        foreground:          fg,
        cursor:              '#526fff',
        cursorAccent:        bg,
        selectionBackground: 'rgba(0,0,0,0.12)',
        black:               fg,        brightBlack:   '#a0a1a7',
        red:                 '#e45649', brightRed:     '#e45649',
        green:               '#50a14f', brightGreen:   '#50a14f',
        yellow:              '#c18401', brightYellow:  '#c18401',
        blue:                '#4078f2', brightBlue:    '#4078f2',
        magenta:             '#a626a4', brightMagenta: '#a626a4',
        cyan:                '#0184bc', brightCyan:    '#0184bc',
        white:               bg,        brightWhite:   bg,
      }
    }
  }

  _probeFg(bg) {
    try {
      const el = atom.workspace.getActiveTextEditor()?.getElement()
               || document.querySelector('atom-text-editor')
      if (el) {
        const hex = this._rgbToHex(getComputedStyle(el).color)
        if (hex) return hex
      }
    } catch (_) {}
    return this._isDark(bg) ? '#abb2bf' : '#383a42'
  }

  _isDark(hex) {
    if (!hex || hex.length < 7) return true
    const r = parseInt(hex.slice(1, 3), 16)
    const g = parseInt(hex.slice(3, 5), 16)
    const b = parseInt(hex.slice(5, 7), 16)
    return (0.299 * r + 0.587 * g + 0.114 * b) < 128
  }

  _fontSize() {
    const explicit = atom.config.get('claude-code.fontSize')
    return (explicit && explicit > 0) ? explicit : (atom.config.get('editor.fontSize') || 13)
  }

  _applyFontSize() {
    if (!this.terminal) return
    this.terminal.options.fontSize = this._fontSize()
    this._fit()
  }

  _fit() {
    if (!this.terminal || !this.fitAddon) return
    try {
      this.fitAddon.fit()
      if (this.pty) this.pty.resize(Math.max(this.terminal.cols, 20), Math.max(this.terminal.rows, 5))
    } catch (_) {}
  }

  _restart() {
    this._exitPending = false
    this._killPty()
    if (this.terminal) this.terminal.clear()
    let nodePty
    try { nodePty = require(NODE_PTY_PATH) } catch (_) { return }
    this._spawnClaude(nodePty, this._cliPath(), atom.project.getPaths()[0] || os.homedir())
  }

  _killPty() {
    if (this.pty) { try { this.pty.kill() } catch (_) {} this.pty = null }
  }

  _showError(msg) {
    const pre = document.createElement('pre')
    pre.style.cssText =
      'margin:0;padding:16px;font-family:monospace;font-size:13px;' +
      'color:#f44747;background:#1e1e1e;height:100%;box-sizing:border-box;white-space:pre-wrap;'
    pre.textContent = msg
    this.termContainer.appendChild(pre)
  }
}

module.exports = TerminalPanel
