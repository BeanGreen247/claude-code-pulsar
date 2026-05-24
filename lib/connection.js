'use strict'

const { spawn, spawnSync } = require('child_process')
const { Emitter } = require('atom')

const State = Object.freeze({
  IDLE: 'idle',
  RUNNING: 'running',
  STOPPING: 'stopping',
  ERROR: 'error',
})

class ClaudeConnection {
  constructor() {
    this.emitter = new Emitter()
    this.state = State.IDLE
    this.sessionId = null
    this.process = null
    this.buffer = ''
    this.currentMessageId = null
    this.currentTextBlocks = new Map()
    this.currentToolBlocks = new Map()
    this.permissionMode = atom.config.get('claude-code.permissionMode') || 'acceptEdits'
    this.researchMode = false
    this.debugMode = false
    this.model = atom.config.get('claude-code.model') || null
    this.cliPath = atom.config.get('claude-code.cliPath') || 'claude'

    this.cliAvailable = this._detectCLI()
  }

  // ── CLI detection ─────────────────────────────────────────────────────────

  _detectCLI() {
    try {
      const r = spawnSync(this.cliPath, ['--version'], {
        timeout: 2500,
        encoding: 'utf8',
        windowsHide: true,
      })
      return !r.error && (r.status === 0 || r.status === 1)
    } catch (_) {
      return false
    }
  }

  // ── Public API ────────────────────────────────────────────────────────────

  send(prompt) {
    if (this.state === State.RUNNING) return
    this._spawn(prompt)
  }

  interrupt() {
    if (this.process && this.state === State.RUNNING) {
      this.process.kill('SIGINT')
    }
  }

  respondPermission(allow) {
    if (!this.process || this.state !== State.RUNNING) return
    try {
      this.process.stdin.write((allow ? 'yes' : 'no') + '\n')
    } catch (_) {}
  }

  setPermissionMode(mode) {
    this.permissionMode = mode
  }

  setResearchMode(enabled) {
    this.researchMode = !!enabled
  }

  setDebugMode(enabled) {
    this.debugMode = !!enabled
  }

  destroy() {
    this._kill()
    this.emitter.dispose()
  }

  // ── Events ────────────────────────────────────────────────────────────────

  onSystem(cb)            { return this.emitter.on('system', cb) }
  onDelta(cb)             { return this.emitter.on('delta', cb) }
  onThinking(cb)          { return this.emitter.on('thinking', cb) }
  onToolUse(cb)           { return this.emitter.on('tool-use', cb) }
  onToolResult(cb)        { return this.emitter.on('tool-result', cb) }
  onPermissionRequest(cb) { return this.emitter.on('permission-request', cb) }
  onStatus(cb)            { return this.emitter.on('status', cb) }
  onResult(cb) { return this.emitter.on('result', cb) }
  onError(cb) { return this.emitter.on('error', cb) }
  onClose(cb) { return this.emitter.on('close', cb) }

  // ── Process lifecycle ─────────────────────────────────────────────────────

  _spawn(prompt) {
    const cliPath = atom.config.get('claude-code.cliPath') || 'claude'
    const model = atom.config.get('claude-code.model') || null
    const permMode = this.permissionMode

    // Core: --verbose is required for stream-json to emit events
    const args = ['-p', '--output-format', 'stream-json', '--verbose']

    if (this.sessionId) args.push('--resume', this.sessionId)
    if (model) args.push('--model', model)
    if (permMode && permMode !== 'default') {
      args.push('--permission-mode', permMode)
    }

    // Restrict to editor-relevant tools (drops ~25 unused tool definitions).
    const tools = permMode === 'default'
      ? 'Read,Glob,Grep,WebSearch,WebFetch'
      : 'Read,Write,Edit,Bash,Glob,Grep,WebSearch,WebFetch'
    args.push('--tools', tools)

    // Better prompt-cache reuse across calls.
    args.push('--exclude-dynamic-system-prompt-sections')

    if (this.researchMode) {
      args.push('--max-turns', '50')
      args.push(
        '--append-system-prompt',
        'RESEARCH MODE: You are a deep research assistant. Use WebSearch and WebFetch extensively — search multiple queries, read primary sources, cross-reference facts. Always cite your sources with URLs. Prioritise accuracy over brevity. Summarise findings clearly with source links at the end.'
      )
    } else {
      args.push(
        '--append-system-prompt',
        'Do the work silently. When finished, write a brief completion summary: what files were changed, commands run, or results found — one item per line, 2-5 lines max. No preamble. No "I will" or "Let me". Start directly with what was done.'
      )
    }

    // Pass the prompt as a positional arg so the CLI doesn't need stdin EOF to
    // start processing. Stdin stays open so respondPermission() can write 'yes'/'no'.
    args.push(prompt)

    const cwd = (atom.project.getPaths()[0]) || require('os').homedir()

    try {
      this.process = spawn(cliPath, args, {
        cwd,
        env: { ...process.env },
        stdio: ['pipe', 'pipe', 'pipe'],
      })
    } catch (err) {
      this._handleSpawnError(err)
      return
    }

    this.state = State.RUNNING
    this.buffer = ''
    this.currentTextBlocks.clear()
    this.currentToolBlocks.clear()

    this.process.stdout.on('data', (chunk) => {
      this.buffer += chunk.toString('utf8')
      this._drainBuffer()
    })

    this.process.stderr.on('data', (chunk) => {
      const text = chunk.toString('utf8').trim()
      if (!text) return
      const isNoise = text.startsWith('Using') || text.startsWith('[')
      if (this.debugMode) {
        // Show all stderr as status (not error) so debug output doesn't look alarming
        this.emitter.emit('status', { message: `[debug] ${text}` })
      } else if (!isNoise) {
        this.emitter.emit('error', { type: 'stderr', message: text })
      }
    })

    this.process.on('error', (err) => {
      this.state = State.ERROR
      this._handleSpawnError(err)
    })

    this.process.on('close', (code) => {
      this.state = State.IDLE
      this.process = null
      this.emitter.emit('close', { code })
    })

    // stdin stays open so respondPermission() can write 'yes'/'no' later.
    // The prompt is passed as a positional CLI argument (see args.push above).
  }

  _kill() {
    if (this.process) {
      this.state = State.STOPPING
      try { this.process.stdin.end() } catch (_) {}
      try { this.process.kill('SIGTERM') } catch (_) {}
      this.process = null
    }
    this.state = State.IDLE
  }

  // ── Stream parsing ────────────────────────────────────────────────────────

  _drainBuffer() {
    const lines = this.buffer.split('\n')
    this.buffer = lines.pop() // keep incomplete trailing fragment
    for (const line of lines) {
      const trimmed = line.trim()
      if (!trimmed) continue
      try {
        const event = JSON.parse(trimmed)
        this._handleEvent(event)
      } catch (_) {
        // non-JSON diagnostic output – ignore silently
      }
    }
  }

  _handleEvent(ev) {
    switch (ev.type) {
      case 'system':
        this._onSystem(ev)
        break
      case 'assistant':
        this._onAssistant(ev)
        break
      case 'user':
        this._onUser(ev)
        break
      case 'result':
        this._onResult(ev)
        break
      case 'permission_request':
        this._onPermissionRequest(ev)
        break
      default:
        break
    }
  }

  _onPermissionRequest(ev) {
    this.emitter.emit('permission-request', {
      id: ev.id || ev.uuid,
      toolName: ev.tool_name || ev.tool || ev.name || 'Unknown',
      input: ev.input || ev.tool_input || {},
      sessionId: ev.session_id,
    })
  }

  _onSystem(ev) {
    if (ev.subtype === 'init') {
      this.sessionId = ev.session_id
      this.emitter.emit('system', {
        sessionId: ev.session_id,
        model: ev.model,
        permissionMode: ev.permissionMode,
        tools: ev.tools || [],
      })
    }
  }

  _onAssistant(ev) {
    if (!ev.message || !Array.isArray(ev.message.content)) return
    for (const block of ev.message.content) {
      this._handleContentBlock(block, ev.session_id)
    }
  }

  _handleContentBlock(block, sessionId) {
    switch (block.type) {
      case 'text':
        this.emitter.emit('delta', { text: block.text, sessionId })
        break
      case 'thinking':
        this.emitter.emit('thinking', { text: block.thinking, sessionId })
        break
      case 'tool_use':
        this.emitter.emit('tool-use', {
          id: block.id,
          name: block.name,
          input: block.input || {},
          sessionId,
        })
        break
      default:
        break
    }
  }

  _onUser(ev) {
    if (!ev.message || !Array.isArray(ev.message.content)) return
    for (const block of ev.message.content) {
      if (block.type === 'tool_result') {
        const content = Array.isArray(block.content)
          ? block.content.map((b) => b.text || '').join('\n')
          : String(block.content || '')
        this.emitter.emit('tool-result', {
          toolUseId: block.tool_use_id,
          content,
          isError: !!block.is_error,
          sessionId: ev.session_id,
        })
      }
    }
  }

  _onResult(ev) {
    this.emitter.emit('result', {
      subtype: ev.subtype,
      result: ev.result,
      sessionId: ev.session_id,
      costUsd: ev.total_cost_usd,
      durationMs: ev.duration_ms,
      usage: ev.usage || {},
    })
  }

  _handleSpawnError(err) {
    let message
    if (err.code === 'ENOENT') {
      message = `Claude CLI not found at "${this.cliPath}". Install it with: npm install -g @anthropic-ai/claude-code`
    } else if (err.code === 'EACCES' || err.code === 'EPERM') {
      message = `Permission denied running "${this.cliPath}". Check the path in settings.`
    } else {
      message = `Failed to start Claude CLI: ${err.message}`
    }
    this.emitter.emit('error', { type: 'spawn', message })
    const notif = atom.notifications.addError('Claude Code', {
      description: message,
      dismissable: true,
      buttons: [{
        text: 'Open Settings',
        onDidClick: () => {
          atom.workspace.open('atom://config/packages/claude-code')
          notif.dismiss()
        },
      }],
    })
  }
}

module.exports = ClaudeConnection
