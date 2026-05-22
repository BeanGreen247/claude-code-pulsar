'use strict'

const { CompositeDisposable } = require('atom')

module.exports = {
  subscriptions: null,
  panels: null,
  sessionStore: null,
  historyList: null,

  activate(_state) {
    this.panels = new Set()
    this.subscriptions = new CompositeDisposable()

    const SessionStore = require('./session-store')
    this.sessionStore = new SessionStore()

    // URI opener — returns the pane item for atom://claude-code
    this.subscriptions.add(
      atom.workspace.addOpener((uri) => {
        if (uri === 'atom://claude-code') {
          return this._createPanel()
        }
      })
    )

    // Workspace-level commands
    this.subscriptions.add(
      atom.commands.add('atom-workspace', {
        'claude-code:open': () => this._open(),
        'claude-code:toggle': () => this._toggle(),
        'claude-code:new-chat': () => this._newChat(),
        'claude-code:open-latest': () => this._openLatest(),
        'claude-code:history': () => this._openHistory(),
        'claude-code:settings': () => atom.workspace.open('atom://config/packages/claude-code'),
        'claude-code:check-cli': () => this._checkCli(),
        'claude-code:update-cli': () => this._updateCli(),
      })
    )

    // Editor context commands
    this.subscriptions.add(
      atom.commands.add('atom-text-editor', {
        'claude-code:attach-selection': () => this._attachSelection(),
        'claude-code:attach-file': () => this._attachFile(),
      })
    )

    // Tree-view context command
    this.subscriptions.add(
      atom.commands.add('.tree-view', {
        'claude-code:attach-path': () => this._attachTreePaths(),
      })
    )
  },

  deactivate() {
    for (const panel of this.panels) panel.destroy()
    this.panels.clear()
    this.subscriptions.dispose()
    if (this.historyList) this.historyList.destroy()
  },

  serialize() { return {} },

  // ── Panel factory ────────────────────────────────────────────────────────

  _createPanel() {
    const ClaudePanel = require('./claude-panel')
    const panel = new ClaudePanel({ sessionStore: this.sessionStore })
    this.panels.add(panel)
    panel.onDidDestroy(() => this.panels.delete(panel))
    return panel
  },

  _getOrCreatePanel() {
    if (this.panels.size > 0) return Array.from(this.panels)[this.panels.size - 1]
    return this._createPanel()
  },

  // ── Commands ─────────────────────────────────────────────────────────────

  async _open() {
    const location = atom.config.get('claude-code.panelPosition') || 'right'

    // If already open, just focus it
    const existing = atom.workspace.paneContainerForURI('atom://claude-code')
    if (existing) {
      const item = atom.workspace.paneItemForURI('atom://claude-code')
      if (item) {
        const pane = atom.workspace.paneForItem(item)
        if (pane) pane.activateItem(item)
        item.focus && item.focus()
        return item
      }
    }

    return atom.workspace.open('atom://claude-code', { location, searchAllPanes: true })
  },

  async _toggle() {
    const item = atom.workspace.paneItemForURI('atom://claude-code')
    if (item) {
      const pane = atom.workspace.paneForItem(item)
      if (pane) {
        if (pane.getActiveItem() === item) {
          pane.destroyItem(item)
          return
        }
        pane.activateItem(item)
        return
      }
    }
    await this._open()
  },

  async _newChat() {
    const item = await this._open()
    const panel = item && item.newChat ? item : Array.from(this.panels)[0]
    if (panel) panel.newChat()
  },

  async _openLatest() {
    const sessions = await this.sessionStore.list(atom.project.getPaths())
    const panel = await this._open()
    if (sessions.length > 0 && panel && panel.resumeSession) {
      panel.resumeSession(sessions[0].sessionId)
    }
  },

  async _openHistory() {
    if (!this.historyList) {
      const HistoryList = require('./history-list')
      this.historyList = new HistoryList({
        sessionStore: this.sessionStore,
        onSelect: async (session) => {
          const panel = await this._open()
          if (panel && panel.resumeSession) panel.resumeSession(session.sessionId)
        },
      })
    }
    await this.historyList.show()
  },

  // ── Editor context helpers ───────────────────────────────────────────────

  _attachSelection() {
    const editor = atom.workspace.getActiveTextEditor()
    if (!editor) return

    const text = editor.getSelectedText()
    const filePath = editor.getPath()
    const range = editor.getSelectedBufferRange()

    this._ensurePanelAndAttach({
      type: 'selection',
      text: text || null,
      filePath,
      range: text ? range : null,
    })
  },

  _attachFile() {
    const editor = atom.workspace.getActiveTextEditor()
    if (!editor || !editor.getPath()) return
    this._ensurePanelAndAttach({ type: 'file', filePath: editor.getPath() })
  },

  _attachTreePaths() {
    const treeView = this._getService('tree-view')
    if (!treeView) return
    const selectedPaths = treeView.selectedPaths ? treeView.selectedPaths() : []
    for (const p of selectedPaths) {
      this._ensurePanelAndAttach({ type: 'file', filePath: p })
    }
  },

  async _ensurePanelAndAttach(ctx) {
    let panel = Array.from(this.panels)[0]
    if (!panel) {
      panel = await this._open()
    }
    if (panel && panel.attachContext) panel.attachContext(ctx)
  },

  // ── CLI utilities ─────────────────────────────────────────────────────────

  _checkCli() {
    const { exec } = require('child_process')
    const cliPath = atom.config.get('claude-code.cliPath') || 'claude'
    exec(`${JSON.stringify(cliPath)} --version`, (err, stdout, stderr) => {
      if (err) {
        atom.notifications.addError('Claude Code CLI not found', {
          description: `Could not run \`${cliPath}\`. Install with: npm install -g @anthropic-ai/claude-code`,
          dismissable: true,
        })
      } else {
        atom.notifications.addSuccess('Claude Code CLI found', {
          description: `Version: ${(stdout || stderr).trim()}`,
          dismissable: true,
        })
      }
    })
  },

  _updateCli() {
    const { exec } = require('child_process')
    const notif = atom.notifications.addInfo('Updating Claude Code CLI…', { dismissable: true })
    exec('npm install -g @anthropic-ai/claude-code', (err, stdout, stderr) => {
      notif.dismiss()
      if (err) {
        atom.notifications.addError('Update failed', { description: stderr, dismissable: true })
      } else {
        atom.notifications.addSuccess('Claude Code CLI updated', { dismissable: true })
      }
    })
  },

  // ── Service registry ──────────────────────────────────────────────────────

  _treeViewService: null,

  consumeTreeView(service) {
    this._treeViewService = service
    return new (require('atom').Disposable)(() => { this._treeViewService = null })
  },

  _getService(name) {
    if (name === 'tree-view') return this._treeViewService
    return null
  },

  // Service provider for other packages
  provideClaudeCode() {
    return {
      getSessionId: () => {
        for (const p of this.panels) return p.getSessionId()
        return null
      },
      sendPrompt: (text) => {
        for (const p of this.panels) { p.send(text); return }
        this._open().then(() => {
          for (const p of this.panels) { p.send(text); return }
        })
      },
      attachContext: (ctx) => {
        for (const p of this.panels) { p.attachContext(ctx); return }
      },
    }
  },
}
