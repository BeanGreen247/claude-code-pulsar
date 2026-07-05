'use strict'

const { CompositeDisposable } = require('atom')

module.exports = {
  subscriptions: null,
  panels: null,

  activate() {
    this.panels = new Set()
    this.watchedBuffers = new Map() // TextBuffer -> Disposable (onDidConflict sub)
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

    this._watchForExternalEdits()
  },

  deactivate() {
    for (const panel of this.panels) panel.destroy()
    this.panels.clear()
    for (const disposable of this.watchedBuffers.values()) disposable.dispose()
    this.watchedBuffers.clear()
    this.subscriptions.dispose()
  },

  serialize() { return {} },

  // ── External-edit auto-reload ───────────────────────────────────────────

  // If a file open in the editor changes on disk while the buffer has
  // unsaved edits (e.g. after Claude Code writes it), Pulsar leaves the
  // buffer in a conflict state instead of reloading it. Resolve that here so
  // the editor always reflects what's on disk.
  _watchForExternalEdits() {
    this.subscriptions.add(
      atom.workspace.observeTextEditors((editor) => {
        const buffer = editor.getBuffer()
        if (this.watchedBuffers.has(buffer)) return

        const conflictSub = buffer.onDidConflict(() => {
          if (atom.config.get('claude-code.autoReloadEditedFiles') === false) return

          const hadUnsavedChanges = buffer.isModified()
          buffer.reload()

          if (hadUnsavedChanges) {
            atom.notifications.addInfo('Claude Code: file reloaded from disk', {
              description: `\`${buffer.getBaseName()}\` changed on disk while it had unsaved edits — it was reloaded to match disk, and the unsaved edits were discarded.`,
              dismissable: true,
            })
          }
        })

        const destroySub = buffer.onDidDestroy(() => {
          conflictSub.dispose()
          this.watchedBuffers.delete(buffer)
        })
        this.watchedBuffers.set(buffer, conflictSub)
      })
    )
  },

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
