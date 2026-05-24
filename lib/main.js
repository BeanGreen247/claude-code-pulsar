'use strict'

const { CompositeDisposable } = require('atom')

module.exports = {
  subscriptions: null,
  panels: null,

  activate() {
    this.panels = new Set()
    this.subscriptions = new CompositeDisposable()

    this.subscriptions.add(
      atom.workspace.addOpener((uri) => {
        if (uri === 'atom://claude-code') return this._createPanel()
      })
    )

    this.subscriptions.add(
      atom.commands.add('atom-workspace', {
        'claude-code:open':     () => this._open(),
        'claude-code:toggle':   () => this._toggle(),
        'claude-code:new-chat': () => this._newChat(),
      })
    )
  },

  deactivate() {
    for (const panel of this.panels) panel.destroy()
    this.panels.clear()
    this.subscriptions.dispose()
  },

  serialize() { return {} },

  // ── Panel factory ─────────────────────────────────────────────────────────

  _createPanel() {
    const TerminalPanel = require('./claude-panel')
    const panel = new TerminalPanel()
    this.panels.add(panel)
    panel.onDidDestroy(() => this.panels.delete(panel))
    return panel
  },

  // ── Commands ──────────────────────────────────────────────────────────────

  async _open() {
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
    const location = atom.config.get('claude-code.panelPosition') || 'right'
    return atom.workspace.open('atom://claude-code', { location, searchAllPanes: true })
  },

  async _toggle() {
    const item = atom.workspace.paneItemForURI('atom://claude-code')
    if (item) {
      const pane = atom.workspace.paneForItem(item)
      if (pane) {
        if (pane.getActiveItem() === item) { pane.destroyItem(item); return }
        pane.activateItem(item)
        return
      }
    }
    await this._open()
  },

  async _newChat() {
    const item = await this._open()
    const panel = (item && item.newChat) ? item : Array.from(this.panels)[0]
    if (panel) panel.newChat()
  },
}
