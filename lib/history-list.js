'use strict'

const { Disposable } = require('atom')

// Minimal select-list for session history (uses Pulsar's built-in SelectListView)
class HistoryList {
  constructor({ sessionStore, onSelect, onEmpty }) {
    this.sessionStore = sessionStore
    this.onSelect = onSelect
    this.onEmpty = onEmpty
    this.selectList = null
    this.panel = null
  }

  async show() {
    const sessions = await this.sessionStore.list(atom.project.getPaths())

    if (sessions.length === 0) {
      this.onEmpty && this.onEmpty()
      return
    }

    // Use Pulsar's built-in atom-select-list if available, else fall back to quick notification
    try {
      const SelectListView = require('atom-select-list')
      this.selectList = new SelectListView({
        items: sessions.map((s) => this.sessionStore.formatForList(s)),
        elementForItem: (item) => {
          const li = document.createElement('li')
          li.className = 'two-lines'
          li.innerHTML = `<div class="primary-line">${escapeHtml(item.label)}</div><div class="secondary-line">${escapeHtml(item.description)}</div>`
          return li
        },
        didConfirmSelection: (item) => {
          this._close()
          this.onSelect && this.onSelect(item.session)
        },
        didCancelSelection: () => this._close(),
      })

      this.panel = atom.workspace.addModalPanel({ item: this.selectList })
      this.selectList.focus()
    } catch (_) {
      // Fallback: just open latest
      if (sessions.length > 0 && this.onSelect) this.onSelect(sessions[0])
    }
  }

  _close() {
    if (this.panel) {
      this.panel.destroy()
      this.panel = null
    }
    if (this.selectList) {
      this.selectList.destroy && this.selectList.destroy()
      this.selectList = null
    }
  }

  destroy() { this._close() }
}

function escapeHtml(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

module.exports = HistoryList
