'use strict'

const https = require('https')
const crypto = require('crypto')
const { Emitter } = require('atom')

// Exponential-ish backoff delays for 529 overload retries
const RETRY_DELAYS_MS = [8000, 20000, 45000]

// Concise system prompt — every token in the system prompt is re-read on each
// non-cached request, so keep it tight. The cache_control header caches it on
// the server for ~5 min, making repeated requests essentially free.
const SYSTEM_PROMPT =
  'You are Claude Code, an AI assistant embedded in the Pulsar editor. ' +
  'Help the user with their code. You are running in API-only mode (no local ' +
  'claude CLI is installed) so you cannot read or edit files directly — describe ' +
  'changes precisely so the user can apply them. Be terse and precise.'

const RESEARCH_SUFFIX =
  '\n\nRESEARCH MODE: Provide thorough, well-researched answers. ' +
  'Reason from multiple angles, cite sources and key references explicitly.'

class ClaudeAPIConnection {
  constructor() {
    this.emitter   = new Emitter()
    this.sessionId = (crypto.randomUUID ? crypto.randomUUID() : `api-${Date.now()}`)
    this.messages  = []   // full conversation history kept in memory
    this.isRunning = false
    this._req      = null // current https.ClientRequest
    this._retry    = 0
    this._pending  = null // prompt waiting for a retry
    this._research = false
    this.permissionMode = 'default'
  }

  // ── Public API (mirrors ClaudeConnection) ────────────────────────────────

  send(prompt) {
    if (this.isRunning) return
    this.messages.push({ role: 'user', content: prompt })
    this._pending = prompt
    this._retry   = 0
    this._request()
  }

  interrupt() {
    if (this._req) {
      try { this._req.destroy() } catch (_) {}
      this._req = null
    }
    this.isRunning = false
    this.emitter.emit('close', { code: null })
  }

  setPermissionMode(mode) { this.permissionMode = mode }
  setResearchMode(on)     { this._research = !!on }

  destroy() {
    this.interrupt()
    this.emitter.dispose()
  }

  // ── Events ────────────────────────────────────────────────────────────────

  onSystem(cb)            { return this.emitter.on('system', cb) }
  onDelta(cb)             { return this.emitter.on('delta', cb) }
  onThinking(cb)          { return this.emitter.on('thinking', cb) }
  onToolUse(cb)           { return this.emitter.on('tool-use', cb) }
  onToolResult(cb)        { return this.emitter.on('tool-result', cb) }
  onPermissionRequest(cb) { return this.emitter.on('permission-request', cb) }
  onResult(cb)            { return this.emitter.on('result', cb) }
  onError(cb)             { return this.emitter.on('error', cb) }
  onClose(cb)             { return this.emitter.on('close', cb) }
  onStatus(cb)            { return this.emitter.on('status', cb) }

  // ── Internal ──────────────────────────────────────────────────────────────

  _apiKey() {
    return (atom.config.get('claude-code.apiKey') || '').trim()
        || (process.env.ANTHROPIC_API_KEY || '').trim()
        || null
  }

  _model() {
    return (atom.config.get('claude-code.model') || '').trim() || 'claude-sonnet-4-6'
  }

  _systemText() {
    return this._research ? SYSTEM_PROMPT + RESEARCH_SUFFIX : SYSTEM_PROMPT
  }

  // Build the messages array with prompt-caching markers.
  // Strategy: cache the system prompt always (header below).
  // For conversation history, mark the second-to-last message as the cache
  // breakpoint so the server can reuse everything before the new exchange.
  _buildMessages() {
    if (this.messages.length === 0) return []

    const msgs = this.messages.map((m) => ({ ...m }))

    // Mark the penultimate message as a cache breakpoint (not the last one,
    // which is the brand-new user turn we're sending now).
    const cacheIdx = msgs.length - 2
    if (cacheIdx >= 0) {
      const m = msgs[cacheIdx]
      if (typeof m.content === 'string') {
        msgs[cacheIdx] = {
          role: m.role,
          content: [{ type: 'text', text: m.content, cache_control: { type: 'ephemeral' } }],
        }
      }
    }

    return msgs
  }

  _request(delayMs = 0) {
    const key = this._apiKey()
    if (!key) {
      this.isRunning = false
      this.emitter.emit('error', {
        type: 'auth',
        message:
          'No Anthropic API key found. Add it in package settings (claude-code.apiKey) ' +
          'or set the ANTHROPIC_API_KEY environment variable.',
      })
      return
    }

    // Emit system once per logical session (first request only)
    if (this.messages.length === 1) {
      this.emitter.emit('system', {
        sessionId: this.sessionId,
        model: this._model(),
      })
    }

    this.isRunning = true

    const fire = () => {
      const body = JSON.stringify({
        model:      this._model(),
        max_tokens: 8096,
        stream:     true,
        system: [{
          type:          'text',
          text:          this._systemText(),
          cache_control: { type: 'ephemeral' }, // cache the system prompt on the server
        }],
        messages: this._buildMessages(),
      })

      const req = https.request({
        hostname: 'api.anthropic.com',
        path:     '/v1/messages',
        method:   'POST',
        headers: {
          'x-api-key':        key,
          'anthropic-version': '2023-06-01',
          // enables prompt caching beta
          'anthropic-beta':   'prompt-caching-2024-07-31',
          'content-type':     'application/json',
          'content-length':   Buffer.byteLength(body),
        },
      }, (res) => {
        if (res.statusCode === 529) {
          req.destroy()
          this._on529()
          return
        }

        if (res.statusCode !== 200) {
          let raw = ''
          res.on('data', (c) => { raw += c })
          res.on('end', () => {
            let msg = `API error ${res.statusCode}`
            try { msg = JSON.parse(raw).error?.message || msg } catch (_) {}
            this.isRunning = false
            this.emitter.emit('error', { type: 'api', message: msg })
          })
          return
        }

        this._stream(res)
      })

      req.on('error', (err) => {
        this.isRunning = false
        this.emitter.emit('error', { type: 'network', message: err.message })
      })

      req.setTimeout(90000, () => {
        req.destroy()
        this.isRunning = false
        this.emitter.emit('error', { type: 'timeout', message: 'Request timed out after 90 s' })
      })

      this._req = req
      req.write(body)
      req.end()
    }

    delayMs > 0 ? setTimeout(fire, delayMs) : fire()
  }

  _on529() {
    if (this._retry < RETRY_DELAYS_MS.length) {
      const delay = RETRY_DELAYS_MS[this._retry++]
      const secs  = Math.round(delay / 1000)
      this.emitter.emit('status', {
        message: `Server overloaded — retrying in ${secs} s… (attempt ${this._retry}/${RETRY_DELAYS_MS.length})`,
      })
      this._request(delay)
    } else {
      this.isRunning = false
      // Remove the user message we pushed (so the user can resend without duplication)
      if (this.messages.length && this.messages[this.messages.length - 1].role === 'user') {
        this.messages.pop()
      }
      this.emitter.emit('error', {
        type: 'overloaded',
        message: 'Server overloaded (529). Max retries reached — please try again in a moment.',
      })
    }
  }

  _stream(res) {
    let buf    = ''
    let text   = ''
    let usage  = {}

    res.on('data', (chunk) => {
      buf += chunk.toString('utf8')
      const lines = buf.split('\n')
      buf = lines.pop() // keep trailing incomplete fragment

      for (const line of lines) {
        if (!line.startsWith('data: ')) continue
        const raw = line.slice(6).trim()
        if (!raw || raw === '[DONE]') continue
        let ev
        try { ev = JSON.parse(raw) } catch (_) { continue }

        switch (ev.type) {
          case 'message_start':
            if (ev.message?.usage) Object.assign(usage, ev.message.usage)
            break

          case 'content_block_delta':
            if (ev.delta?.type === 'text_delta' && ev.delta.text) {
              text += ev.delta.text
              this.emitter.emit('delta', { text: ev.delta.text, sessionId: this.sessionId })
            } else if (ev.delta?.type === 'thinking_delta' && ev.delta.thinking) {
              this.emitter.emit('thinking', { text: ev.delta.thinking, sessionId: this.sessionId })
            }
            break

          case 'message_delta':
            if (ev.usage) Object.assign(usage, ev.usage)
            break
        }
      }
    })

    res.on('end', () => {
      this.isRunning = false
      this._req = null

      if (text) this.messages.push({ role: 'assistant', content: text })

      // Approximate cost for claude-sonnet-4-6 pricing
      const inTok   = usage.input_tokens               || 0
      const outTok   = usage.output_tokens              || 0
      const cRead    = usage.cache_read_input_tokens    || 0
      const cWrite   = usage.cache_creation_input_tokens || 0
      const costUsd  = (inTok / 1e6) * 3.00
                     + (outTok / 1e6) * 15.00
                     + (cRead / 1e6)  * 0.30
                     + (cWrite / 1e6) * 3.75

      this.emitter.emit('result', {
        subtype: 'success',
        sessionId: this.sessionId,
        costUsd,
        usage: {
          input_tokens:                inTok,
          output_tokens:               outTok,
          cache_read_input_tokens:     cRead,
          cache_creation_input_tokens: cWrite,
        },
      })
      this.emitter.emit('close', { code: 0 })
    })

    res.on('error', (err) => {
      this.isRunning = false
      this.emitter.emit('error', { type: 'stream', message: err.message })
    })
  }
}

module.exports = ClaudeAPIConnection
