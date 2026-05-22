'use strict'

const fs = require('fs')
const path = require('path')

class SessionStore {
  constructor() {
    this.dir = path.join(atom.getConfigDirPath(), 'claude-code-sessions')
    this._ensureDir()
  }

  _ensureDir() {
    try {
      if (!fs.existsSync(this.dir)) fs.mkdirSync(this.dir, { recursive: true })
    } catch (_) {}
  }

  _filePath(sessionId) {
    return path.join(this.dir, `${sessionId}.json`)
  }

  async save(session) {
    try {
      const data = JSON.stringify(session, null, 2)
      await fs.promises.writeFile(this._filePath(session.sessionId), data, 'utf8')
    } catch (_) {}
  }

  saveSync(session) {
    try {
      const data = JSON.stringify(session, null, 2)
      fs.writeFileSync(this._filePath(session.sessionId), data, 'utf8')
    } catch (_) {}
  }

  async load(sessionId) {
    try {
      const raw = await fs.promises.readFile(this._filePath(sessionId), 'utf8')
      return JSON.parse(raw)
    } catch (_) {
      return null
    }
  }

  async list(projectPaths = []) {
    try {
      const files = await fs.promises.readdir(this.dir)
      const sessions = []
      for (const file of files) {
        if (!file.endsWith('.json')) continue
        try {
          const raw = await fs.promises.readFile(path.join(this.dir, file), 'utf8')
          const s = JSON.parse(raw)
          if (projectPaths.length === 0 || this._matchesProject(s, projectPaths)) {
            sessions.push(s)
          }
        } catch (_) {}
      }
      return sessions.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
    } catch (_) {
      return []
    }
  }

  async delete(sessionId) {
    try {
      await fs.promises.unlink(this._filePath(sessionId))
    } catch (_) {}
  }

  _matchesProject(session, projectPaths) {
    if (!session.projectPaths) return true
    return session.projectPaths.some((p) => projectPaths.includes(p))
  }

  formatForList(session) {
    const date = session.updatedAt
      ? new Date(session.updatedAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
      : '?'
    const folders = (session.projectPaths || [])
      .map((p) => path.basename(p))
      .slice(0, 2)
      .join(', ')
    const preview = session.firstMessage
      ? session.firstMessage.slice(0, 60)
      : '(empty)'
    return { label: `${date} — ${folders || 'No folder'}`, description: preview, session }
  }

  makeSessionData(sessionId, projectPaths, messages) {
    const now = Date.now()
    const first = messages.find((m) => m.role === 'user')
    return {
      sessionId,
      projectPaths: projectPaths || [],
      createdAt: now,
      updatedAt: now,
      firstMessage: first ? first.text : null,
      messageCount: messages.length,
    }
  }
}

module.exports = SessionStore
