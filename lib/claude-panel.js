'use strict'

const { Emitter, CompositeDisposable } = require('atom')
const ClaudeConnection = require('./connection')
const { renderMarkdown, renderToolInput, renderToolResult, escapeHtml } = require('./renderer')

const PERMISSION_MODES = [
  { id: 'acceptEdits',       label: 'Allow Edits',  title: 'Auto-accept file edits; ask for shell commands' },
  { id: 'bypassPermissions', label: 'Allow All',    title: 'Auto-accept everything including shell commands' },
  { id: 'default',           label: 'Read Only',    title: 'Deny all file writes and shell commands' },
]

class ClaudePanel {
  constructor({ sessionStore } = {}) {
    this.emitter = new Emitter()
    this.subscriptions = new CompositeDisposable()
    this.sessionStore = sessionStore
    this.connection = null
    this.messages = []
    this.attachments = []
    this.permissionMode = atom.config.get('claude-code.permissionMode') || 'acceptEdits'
    this.pendingPermission = null
    this.researchMode = false
    this.isStreaming = false
    this._thinkingEl = null
    this.currentAssistantEl = null
    this.currentTextBuffer = ''
    this.currentThinkingBuffer = ''
    this.currentToolEls = new Map()
    this._accountInfo = null
    this._usageCache = null
    this._usageCacheTime = 0

    this._buildElement()
    this._bindConnection()
    this._applyTheme()

    this.subscriptions.add(
      atom.config.onDidChange('claude-code.permissionMode', ({ newValue }) => {
        this.permissionMode = newValue
        this._updateModeUI()
      }),
      atom.config.onDidChange('claude-code.theme', () => this._applyTheme())
    )
  }

  // ── Pane item API ──────────────────────────────────────────────────────

  getTitle() { return 'Claude Code' }
  getURI() { return 'atom://claude-code' }
  getIconName() { return 'claude-code-icon' }
  getDefaultLocation() { return atom.config.get('claude-code.panelPosition') || 'right' }
  getAllowedLocations() { return ['left', 'right', 'bottom', 'center'] }

  getElement() { return this.element }

  serialize() {
    return {
      deserializer: 'ClaudePanel',
      sessionId: this.connection ? this.connection.sessionId : null,
      permissionMode: this.permissionMode,
    }
  }

  destroy() {
    this._destroyConnection()
    this.subscriptions.dispose()
    this.emitter.emit('did-destroy')
    this.emitter.dispose()
  }

  onDidDestroy(cb) { return this.emitter.on('did-destroy', cb) }

  focus() {
    this.inputEditor && this.inputEditor.element.focus()
  }

  // ── Public methods ─────────────────────────────────────────────────────

  newChat() {
    this._destroyConnection()
    this.messages = []
    this.attachments = []
    this._clearMessagesEl()
    this._showWelcome()
    this.inputEditor && this.inputEditor.setText('')
  }

  resumeSession(sessionId) {
    this._destroyConnection()
    this._bindConnection()
    if (this.connection) this.connection.sessionId = sessionId
  }

  getSessionId() {
    return this.connection ? this.connection.sessionId : null
  }

  send(text) {
    if (!text || !text.trim()) return
    this._sendPrompt(text.trim())
  }

  attachContext(ctx) {
    this.attachments.push(ctx)
    this._renderAttachments()
    this._updateSendBtn()
    this.focus()
  }

  // ── Element construction ───────────────────────────────────────────────

  _buildElement() {
    const el = document.createElement('div')
    el.className = 'claude-code-panel'

    // Header
    const header = document.createElement('div')
    header.className = 'claude-code-header'
    header.innerHTML = `
      <span class="claude-code-title">
        <svg class="claude-logo" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" width="16" height="16" aria-hidden="true">
          <path d="M12 2l2 8 8 2-8 2-2 8-2-8-8-2 8-2z"/>
        </svg>
        Claude Code
      </span>
      <div class="claude-code-header-controls">
        <button class="claude-btn claude-btn-icon cc-usage-btn" id="cc-usage" title="Account &amp; usage">@</button>
        <button class="claude-btn claude-btn-icon" id="cc-about" title="About — github.com/BeanGreen247/claude-code-pulsar">?</button>
        <button class="claude-btn claude-btn-icon" id="cc-new-chat" title="New chat">+</button>
        <button class="claude-btn claude-btn-icon" id="cc-interrupt" title="Interrupt" style="display:none">■</button>
      </div>
    `
    this.usagePopover = this._buildUsagePopover()
    header.appendChild(this.usagePopover)
    el.appendChild(header)

    // Mode bar
    const modebar = document.createElement('div')
    modebar.className = 'claude-code-modebar'
    for (const mode of PERMISSION_MODES) {
      const btn = document.createElement('button')
      btn.className = 'claude-mode-btn'
      btn.dataset.mode = mode.id
      btn.textContent = mode.label
      btn.title = mode.title
      btn.addEventListener('click', () => this._setPermissionMode(mode.id))
      modebar.appendChild(btn)
    }
    // Research mode toggle — separate from permission modes
    const researchBtn = document.createElement('button')
    researchBtn.className = 'claude-mode-btn cc-research-btn'
    researchBtn.id = 'cc-research-toggle'
    researchBtn.textContent = 'Research'
    researchBtn.title = 'Research mode: deep web search, multi-source verification, cite sources'
    researchBtn.addEventListener('click', () => this._toggleResearchMode())
    modebar.appendChild(researchBtn)
    el.appendChild(modebar)

    // Messages area
    const messagesWrap = document.createElement('div')
    messagesWrap.className = 'claude-code-messages-wrap'
    this.messagesEl = document.createElement('div')
    this.messagesEl.className = 'claude-code-messages'
    messagesWrap.appendChild(this.messagesEl)
    el.appendChild(messagesWrap)

    // ── Bottom section ──────────────────────────────────────────────────────
    const inputWrap = document.createElement('div')
    inputWrap.className = 'claude-code-input-wrap'

    // Usage strip (two compact bars, always visible)
    this.usageStripEl = document.createElement('div')
    this.usageStripEl.className = 'cc-usage-strip'
    this.usageStripEl.innerHTML = '<div class="cc-strip-loading">Loading usage…</div>'
    inputWrap.appendChild(this.usageStripEl)

    // Attachments tray
    this.attachmentsEl = document.createElement('div')
    this.attachmentsEl.className = 'claude-code-attachments'
    this.attachmentsEl.style.display = 'none'
    inputWrap.appendChild(this.attachmentsEl)

    // Editor — plain textarea so height/wrapping are fully under our control
    const inputRow = document.createElement('div')
    inputRow.className = 'cc-input-row'

    const textarea = document.createElement('textarea')
    textarea.className = 'claude-code-input-editor'
    textarea.placeholder = 'Ask Claude anything…'
    textarea.rows = 3
    inputRow.appendChild(textarea)
    inputWrap.appendChild(inputRow)

    // Minimal wrapper matching the API used elsewhere in this file
    this.inputEditor = {
      element: textarea,
      getText: () => textarea.value,
      setText: (v) => { textarea.value = v; textarea.style.height = 'auto' },
      focus: () => textarea.focus(),
    }

    // Auto-grow textarea with content; update send button state
    textarea.addEventListener('input', () => {
      textarea.style.height = 'auto'
      textarea.style.height = Math.min(textarea.scrollHeight, 200) + 'px'
      this._updateSendBtn()
    })

    // Send bar — full width, below editor
    const sendBar = document.createElement('div')
    sendBar.className = 'cc-send-bar'
    this.sendBtn = document.createElement('button')
    this.sendBtn.className = 'cc-send-btn'
    this.sendBtn.textContent = 'Send'
    this.sendBtn.title = 'Send (Ctrl+Enter)'
    this.sendBtn.disabled = true
    this.sendBtn.addEventListener('click', () => this._onSend())
    sendBar.appendChild(this.sendBtn)
    inputWrap.appendChild(sendBar)

    // Attach bar
    const attachBar = document.createElement('div')
    attachBar.className = 'cc-attach-bar'
    attachBar.innerHTML = `
      <button class="cc-attach-btn" id="cc-attach-file"   title="Pick a file">+ File</button>
      <button class="cc-attach-btn" id="cc-attach-active" title="Attach active editor file">Active file</button>
      <button class="cc-attach-btn" id="cc-attach-sel"    title="Attach selected text">Selection</button>
      <button class="cc-attach-btn" id="cc-attach-img"    title="Paste image from clipboard">Paste image</button>
    `
    inputWrap.appendChild(attachBar)
    el.appendChild(inputWrap)

    this.element = el

    // Wire header buttons
    el.querySelector('#cc-new-chat').addEventListener('click', () => this.newChat())
    el.querySelector('#cc-about').addEventListener('click', () => {
      require('electron').shell.openExternal('https://github.com/BeanGreen247/claude-code-pulsar')
    })
    this.interruptBtn = el.querySelector('#cc-interrupt')
    this.interruptBtn.addEventListener('click', () => this.connection && this.connection.interrupt())

    // Usage popover hover
    const usageBtn = el.querySelector('#cc-usage')
    let _hideTimer = null
    const showUsage = () => {
      clearTimeout(_hideTimer)
      this._updateUsagePopover()
      this.usagePopover.classList.add('cc-usage-popover--visible')
    }
    const hideUsage = () => {
      _hideTimer = setTimeout(() => {
        this.usagePopover.classList.remove('cc-usage-popover--visible')
      }, 250)
    }
    usageBtn.addEventListener('mouseenter', showUsage)
    usageBtn.addEventListener('mouseleave', hideUsage)
    this.usagePopover.addEventListener('mouseenter', () => clearTimeout(_hideTimer))
    this.usagePopover.addEventListener('mouseleave', hideUsage)

    // Attach bar buttons
    el.querySelector('#cc-attach-file').addEventListener('click', () => this._pickFile())
    el.querySelector('#cc-attach-active').addEventListener('click', () => this._attachActiveFile())
    el.querySelector('#cc-attach-sel').addEventListener('click', () => this._attachCurrentSelection())
    el.querySelector('#cc-attach-img').addEventListener('click', () => this._pasteClipboardImage())

    textarea.addEventListener('keydown', (e) => {
      // Stop Pulsar from intercepting keystrokes (backspace, delete, arrows, etc.)
      e.stopPropagation()

      // Ctrl/Cmd+V — check for clipboard image first
      if ((e.ctrlKey || e.metaKey) && e.key === 'v') {
        try {
          const { clipboard } = require('electron')
          const img = clipboard.readImage()
          if (img && !img.isEmpty()) {
            e.preventDefault()
            this._saveAndAttachImage(img.toDataURL())
            return
          }
        } catch (_) {}
      }
      // Ctrl+Enter or Cmd+Enter sends; plain Enter inserts a newline (default)
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault()
        this._onSend()
      }
    })

    // Copy button delegation
    el.addEventListener('click', (e) => {
      if (e.target.classList.contains('claude-copy-btn')) {
        const code = e.target.closest('.claude-code-block')?.querySelector('code')
        if (code) atom.clipboard.write(code.innerText)
      }
    })

    this._showWelcome()
    this._updateModeUI()
    // Fetch usage for the persistent strip (don't block UI)
    setTimeout(() => this._refreshUsageStrip(), 200)
  }

  _showWelcome() {
    const div = document.createElement('div')
    div.className = 'claude-welcome'
    div.innerHTML = `
      <div class="claude-welcome-icon">
        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" width="32" height="32" aria-hidden="true">
          <path d="M12 2l2 8 8 2-8 2-2 8-2-8-8-2 8-2z"/>
        </svg>
      </div>
      <p>Ask Claude to help with your code.</p>
      <p class="claude-welcome-hint">Press <kbd>Ctrl+Enter</kbd> to send · <kbd>Enter</kbd> for new line</p>
    `
    this.messagesEl.appendChild(div)
  }

  _clearMessagesEl() {
    while (this.messagesEl.firstChild) this.messagesEl.removeChild(this.messagesEl.firstChild)
  }

  // ── Connection ─────────────────────────────────────────────────────────

  _bindConnection() {
    this.connection = new ClaudeConnection()

    this.subscriptions.add(
      this.connection.onSystem((ev) => this._onSystem(ev)),
      this.connection.onDelta((ev) => this._onDelta(ev)),
      this.connection.onThinking((ev) => this._onThinking(ev)),
      this.connection.onToolUse((ev) => this._onToolUse(ev)),
      this.connection.onToolResult((ev) => this._onToolResult(ev)),
      this.connection.onPermissionRequest((ev) => this._onPermissionRequest(ev)),
      this.connection.onResult((ev) => this._onResult(ev)),
      this.connection.onError((ev) => this._onConnectionError(ev)),
      this.connection.onClose(() => this._onConnectionClose()),
    )
  }

  _destroyConnection() {
    this._clearThinking()
    if (this.connection) {
      this.connection.destroy()
      this.connection = null
    }
    this.isStreaming = false
    this.currentAssistantEl = null
    this.currentTextBuffer = ''
    this.currentThinkingBuffer = ''
    this.currentToolEls.clear()
  }

  // ── Sending ────────────────────────────────────────────────────────────

  _onSend() {
    const text = this.inputEditor.getText().trim()
    if (!text || this.isStreaming) return

    let prompt = text
    if (this.attachments.length > 0) {
      const attachBlock = this._buildAttachBlock()
      prompt = attachBlock + '\n\n' + text
      this.attachments = []
      this.attachmentsEl.style.display = 'none'
      this.attachmentsEl.innerHTML = ''
    }

    this.inputEditor.setText('')
    this._sendPrompt(prompt, text)
  }

  _sendPrompt(prompt, displayText) {
    if (!this.connection) this._bindConnection()
    if (!displayText) displayText = prompt

    // Clear welcome message on first send
    const welcome = this.messagesEl.querySelector('.claude-welcome')
    if (welcome) welcome.remove()

    this._appendUserMessage(displayText)
    this._setStreaming(true)
    this._showThinking()

    this.connection.setPermissionMode(this.permissionMode)
    this.connection.setResearchMode(this.researchMode)
    this.connection.send(prompt)
  }

  _buildAttachBlock() {
    return this.attachments
      .map((a) => {
        if (a.type === 'image') {
          return `<attachment>\n<file_path>${a.filePath}</file_path>\n<type>image</type>\n</attachment>`
        }
        if (a.type === 'selection' && a.text) {
          const lang = a.filePath ? a.filePath.split('.').pop() : ''
          return `<attachment>\n<file_path>${a.filePath || ''}</file_path>\n<selection>\n\`\`\`${lang}\n${a.text}\n\`\`\`\n</selection>\n</attachment>`
        }
        if (a.type === 'file') {
          return `<attachment>\n<file_path>${a.filePath}</file_path>\n</attachment>`
        }
        return ''
      })
      .filter(Boolean)
      .join('\n')
  }

  // ── Connection event handlers ──────────────────────────────────────────

  _onSystem(ev) {
    this.connection.sessionId = ev.sessionId
    const sessionEl = document.createElement('div')
    sessionEl.className = 'claude-session-info'
    sessionEl.textContent = `Session ${ev.sessionId.slice(0, 8)} · ${ev.model}`
    this.messagesEl.appendChild(sessionEl)
  }

  _onDelta(ev) {
    this._clearThinking()
    this.currentTextBuffer += ev.text
    if (!this.currentAssistantEl) this.currentAssistantEl = this._appendAssistantMessage()
    const textEl = this.currentAssistantEl.querySelector('.claude-msg-text')
    if (textEl) textEl.innerHTML = renderMarkdown(this.currentTextBuffer)
    this._scrollToBottom()
  }

  _onThinking(ev) {
    this._clearThinking()
    this.currentThinkingBuffer += ev.text
    if (!this.currentAssistantEl) this.currentAssistantEl = this._appendAssistantMessage()
    let thinkEl = this.currentAssistantEl.querySelector('.claude-thinking')
    if (!thinkEl) {
      thinkEl = document.createElement('details')
      thinkEl.className = 'claude-thinking'
      thinkEl.innerHTML = '<summary>Thinking…</summary><div class="claude-thinking-body"></div>'
      this.currentAssistantEl.insertBefore(thinkEl, this.currentAssistantEl.firstChild)
    }
    const body = thinkEl.querySelector('.claude-thinking-body')
    if (body) body.textContent = this.currentThinkingBuffer
  }

  _onToolUse(ev) {
    this._clearThinking()
    if (!this.currentAssistantEl) this.currentAssistantEl = this._appendAssistantMessage()

    const toolEl = document.createElement('details')
    toolEl.className = 'claude-tool-use'
    toolEl.open = true  // auto-expand so content is visible without clicking
    toolEl.dataset.toolId = ev.id

    const inputHtml = renderToolInput(ev.name, ev.input)
    toolEl.innerHTML = `
      <summary class="claude-tool-summary-header">
        <span class="claude-tool-name">${escapeHtml(ev.name)}</span>
        <span class="claude-tool-status claude-tool-status-running">running</span>
      </summary>
      <div class="claude-tool-body">
        <div class="claude-tool-input">${inputHtml}</div>
        <div class="claude-tool-result-wrap"></div>
      </div>
    `

    this.currentAssistantEl.appendChild(toolEl)
    this.currentToolEls.set(ev.id, toolEl)
    this._scrollToBottom()
  }

  _onToolResult(ev) {
    const toolEl = this.currentToolEls.get(ev.toolUseId)
    if (!toolEl) return

    const statusEl = toolEl.querySelector('.claude-tool-status')
    if (statusEl) {
      statusEl.textContent = ev.isError ? 'error' : 'done'
      statusEl.className = `claude-tool-status ${ev.isError ? 'claude-tool-status-error' : 'claude-tool-status-done'}`
    }

    const resultWrap = toolEl.querySelector('.claude-tool-result-wrap')
    if (resultWrap) {
      resultWrap.innerHTML = renderToolResult(ev.content, ev.isError)
    }
    this._scrollToBottom()
  }

  _onPermissionRequest(ev) {
    this.pendingPermission = ev
    this._showPermissionPrompt(ev)
  }

  _showPermissionPrompt(ev) {
    const div = document.createElement('div')
    div.className = 'claude-permission-prompt'
    div.innerHTML = `
      <div class="claude-permission-title">Permission: ${escapeHtml(ev.toolName)}</div>
      <div class="claude-permission-input">${escapeHtml(JSON.stringify(ev.input, null, 2))}</div>
      <div class="claude-permission-buttons">
        <button class="claude-btn claude-btn-allow">Allow</button>
        <button class="claude-btn claude-btn-deny">Deny</button>
      </div>
    `

    div.querySelector('.claude-btn-allow').addEventListener('click', () => {
      this.connection && this.connection.respondPermission(true)
      div.remove()
      this.pendingPermission = null
    })
    div.querySelector('.claude-btn-deny').addEventListener('click', () => {
      this.connection && this.connection.respondPermission(false)
      div.remove()
      this.pendingPermission = null
    })

    this.messagesEl.appendChild(div)
    this._scrollToBottom()
  }

  _onResult(ev) {
    this._clearThinking()
    this._setStreaming(false)
    this.currentAssistantEl = null
    this.currentTextBuffer = ''
    this.currentThinkingBuffer = ''
    this.currentToolEls.clear()

    if (ev.costUsd != null) {
      const u = ev.usage || {}
      const inNew    = u.input_tokens || 0
      const inCache  = (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0)
      const outTok   = u.output_tokens || 0
      const cost     = ev.costUsd < 0.0001 ? '<$0.0001' : `$${ev.costUsd.toFixed(4)}`

      const parts = []
      parts.push(`<span class="cc-usage-label">in</span> <span class="cc-usage-val">${this._fmtTokens(inNew)}</span>`)
      if (inCache > 0) {
        parts.push(`<span class="cc-usage-label">cached</span> <span class="cc-usage-val">${this._fmtTokens(inCache)}</span>`)
      }
      parts.push(`<span class="cc-usage-label">out</span> <span class="cc-usage-val">${this._fmtTokens(outTok)}</span>`)
      parts.push(`<span class="cc-usage-cost">${cost}</span>`)

      const usageEl = document.createElement('div')
      usageEl.className = 'claude-usage'
      usageEl.innerHTML = parts.join('<span class="cc-usage-sep"> · </span>')
      this.messagesEl.appendChild(usageEl)
    }

    // Persist session
    if (ev.sessionId && this.sessionStore) {
      const data = this.sessionStore.makeSessionData(ev.sessionId, atom.project.getPaths(), this.messages)
      this.sessionStore.save(data)
    }

    this._scrollToBottom()
  }

  _onConnectionError(ev) {
    this._clearThinking()
    this._setStreaming(false)
    this._appendSystemMessage(`Error: ${ev.message}`, 'error')
  }

  _onConnectionClose() {
    this._clearThinking()
    if (this.isStreaming) {
      this._setStreaming(false)
      if (this.currentAssistantEl && this.currentTextBuffer) {
        const textEl = this.currentAssistantEl.querySelector('.claude-msg-text')
        if (textEl) textEl.innerHTML = renderMarkdown(this.currentTextBuffer)
      }
      this.currentAssistantEl = null
      this.currentTextBuffer = ''
      this.currentThinkingBuffer = ''
      this.currentToolEls.clear()
    }
  }

  // ── Message DOM helpers ────────────────────────────────────────────────

  _appendUserMessage(text) {
    const msg = {
      role: 'user',
      text,
      timestamp: Date.now(),
    }
    this.messages.push(msg)

    const el = document.createElement('div')
    el.className = 'claude-msg claude-msg-user'
    el.innerHTML = `
      <div class="claude-msg-header">
        <span class="claude-msg-role">You</span>
        <span class="claude-msg-time">${this._fmtTime(msg.timestamp)}</span>
      </div>
      <div class="claude-msg-body">${escapeHtml(text)}</div>
    `
    this.messagesEl.appendChild(el)
    this._scrollToBottom()
    return el
  }

  _appendAssistantMessage() {
    const el = document.createElement('div')
    el.className = 'claude-msg claude-msg-assistant'
    el.innerHTML = `
      <div class="claude-msg-header">
        <span class="claude-msg-role claude-msg-role-assistant">Claude</span>
        <span class="claude-streaming-indicator"></span>
      </div>
      <div class="claude-msg-text"></div>
    `
    this.messagesEl.appendChild(el)
    this._scrollToBottom()
    return el
  }

  _appendSystemMessage(text, type = 'info') {
    const el = document.createElement('div')
    el.className = `claude-msg claude-msg-system claude-msg-system-${type}`
    el.textContent = text
    this.messagesEl.appendChild(el)
    this._scrollToBottom()
    return el
  }

  _scrollToBottom() {
    const wrap = this.element.querySelector('.claude-code-messages-wrap')
    if (wrap) wrap.scrollTop = wrap.scrollHeight
  }

  // ── Attachments ────────────────────────────────────────────────────────

  _renderAttachments() {
    if (this.attachments.length === 0) {
      this.attachmentsEl.style.display = 'none'
      this.attachmentsEl.innerHTML = ''
      return
    }
    this.attachmentsEl.style.display = 'flex'
    this.attachmentsEl.innerHTML = ''

    for (let i = 0; i < this.attachments.length; i++) {
      const a = this.attachments[i]
      const chip = document.createElement('span')
      chip.className = 'claude-attachment-chip'

      const idx = i
      let label = ''
      if (a.type === 'selection' && a.filePath) {
        label = `${require('path').basename(a.filePath)}${a.text ? ':selection' : ''}`
      } else if (a.type === 'file') {
        label = require('path').basename(a.filePath)
      } else {
        label = a.type
      }

      if (a.type === 'image' && a.dataUrl) {
        chip.innerHTML = `<img class="cc-attach-thumb" src="${a.dataUrl}" alt="image"> <span class="claude-attachment-remove">×</span>`
      } else {
        chip.innerHTML = `${escapeHtml(label)} <span class="claude-attachment-remove">×</span>`
      }
      chip.querySelector('.claude-attachment-remove').addEventListener('click', () => {
        this.attachments.splice(idx, 1)
        this._renderAttachments()
        this._updateSendBtn()
      })
      this.attachmentsEl.appendChild(chip)
    }
  }

  // ── Mode / state ───────────────────────────────────────────────────────

  _applyTheme() {
    const theme = atom.config.get('claude-code.theme') || 'auto'
    this.element.classList.remove('cc-theme-dark', 'cc-theme-light')
    if (theme === 'dark') this.element.classList.add('cc-theme-dark')
    else if (theme === 'light') this.element.classList.add('cc-theme-light')
  }

  _setPermissionMode(mode) {
    this.permissionMode = mode
    atom.config.set('claude-code.permissionMode', mode)
    this._updateModeUI()
    if (this.connection) this.connection.setPermissionMode(mode)
  }

  _updateModeUI() {
    this.element.querySelectorAll('.claude-mode-btn').forEach((btn) => {
      if (btn.id === 'cc-research-toggle') {
        btn.classList.toggle('active', this.researchMode)
      } else {
        btn.classList.toggle('active', btn.dataset.mode === this.permissionMode)
      }
    })
  }

  _toggleResearchMode() {
    this.researchMode = !this.researchMode
    this._updateModeUI()
  }

  _showThinking() {
    this._clearThinking()
    this._thinkingEl = document.createElement('div')
    this._thinkingEl.className = 'cc-thinking-row'
    this._thinkingEl.innerHTML = '<span class="cc-thinking-dots"><span></span><span></span><span></span></span>'
    this.messagesEl.appendChild(this._thinkingEl)
    this._scrollToBottom()
  }

  _clearThinking() {
    if (this._thinkingEl) {
      this._thinkingEl.remove()
      this._thinkingEl = null
    }
  }

  _setStreaming(val) {
    this.isStreaming = val
    this._updateSendBtn()
    if (this.interruptBtn) this.interruptBtn.style.display = val ? 'inline-flex' : 'none'
    const indicators = this.element.querySelectorAll('.claude-streaming-indicator')
    indicators.forEach((el) => {
      el.style.display = val ? 'inline-block' : 'none'
    })
  }

  _updateSendBtn() {
    if (!this.sendBtn) return
    const hasText = (this.inputEditor?.getText() || '').trim().length > 0
    const hasAttachments = (this.attachments || []).length > 0
    this.sendBtn.disabled = this.isStreaming || (!hasText && !hasAttachments)
  }

  // ── Utilities ──────────────────────────────────────────────────────────

  _fmtTime(ts) {
    return new Date(ts).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
  }

  _fmtTokens(n) {
    if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
    if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`
    return String(n)
  }

  // ── Attach helpers ─────────────────────────────────────────────────────

  _attachActiveFile() {
    const editor = atom.workspace.getActiveTextEditor()
    if (!editor || !editor.getPath()) {
      atom.notifications.addWarning('No active file to attach', { dismissable: true })
      return
    }
    this.attachContext({ type: 'file', filePath: editor.getPath() })
  }

  _attachCurrentSelection() {
    const editor = atom.workspace.getActiveTextEditor()
    if (!editor) return
    const text = editor.getSelectedText()
    if (!text) {
      atom.notifications.addWarning('No text selected', { dismissable: true })
      return
    }
    this.attachContext({
      type: 'selection',
      text,
      filePath: editor.getPath(),
      range: editor.getSelectedBufferRange(),
    })
  }

  _pickFile() {
    try {
      let dialog
      try { dialog = require('@electron/remote').dialog } catch (_) {}
      if (!dialog) dialog = require('electron').remote?.dialog
      if (!dialog) throw new Error('dialog unavailable')
      dialog.showOpenDialog({ properties: ['openFile', 'multiSelections'] }).then((result) => {
        if (!result.canceled) {
          result.filePaths.forEach((f) => this.attachContext({ type: 'file', filePath: f }))
        }
      })
    } catch (_) {
      atom.notifications.addInfo('Use the tree-view context menu to attach files', { dismissable: true })
    }
  }

  _pasteClipboardImage() {
    try {
      const { clipboard } = require('electron')
      const img = clipboard.readImage()
      if (!img || img.isEmpty()) {
        atom.notifications.addWarning('No image in clipboard', { dismissable: true })
        return
      }
      const dataUrl = img.toDataURL()
      this._saveAndAttachImage(dataUrl)
    } catch (err) {
      atom.notifications.addError('Could not read clipboard image', { description: err.message, dismissable: true })
    }
  }

  _handlePastedImage(file) {
    if (!file) return
    const reader = new FileReader()
    reader.onload = (ev) => this._saveAndAttachImage(ev.target.result)
    reader.readAsDataURL(file)
  }

  _saveAndAttachImage(dataUrl) {
    const base64 = dataUrl.replace(/^data:image\/\w+;base64,/, '')
    const tmpPath = require('path').join(require('os').tmpdir(), `cc_img_${Date.now()}.png`)
    require('fs').writeFileSync(tmpPath, Buffer.from(base64, 'base64'))
    this.attachContext({ type: 'image', filePath: tmpPath, dataUrl })
  }

  // ── Usage strip (persistent bars above input) ───────────────────────────

  _refreshUsageStrip() {
    const stale = Date.now() - this._usageCacheTime > 60000
    if (this._usageCache && !stale) {
      this._renderUsageStrip(this._usageCache)
      return
    }
    this._fetchUsage().then((data) => {
      this._usageCache = data
      this._usageCacheTime = Date.now()
      this._renderUsageStrip(data)
    })
  }

  _renderUsageStrip(data) {
    const el = this.usageStripEl
    if (!el) return
    if (!data) { el.innerHTML = ''; return }

    let html = ''
    if (data.five_hour) html += this._stripBarHtml('Session', data.five_hour)
    if (data.seven_day)  html += this._stripBarHtml('Week',    data.seven_day)
    el.innerHTML = html
  }

  _stripBarHtml(label, bucket) {
    const pct  = Math.min(100, Math.round(bucket.utilization || 0))
    const fcls = pct >= 85 ? 'cc-strip-fill-danger' : pct >= 65 ? 'cc-strip-fill-warn' : ''
    const tcls = pct >= 85 ? 'cc-strip-pct-danger'  : pct >= 65 ? 'cc-strip-pct-warn'  : ''
    const reset = bucket.resets_at ? this._fmtReset(bucket.resets_at) : '—'
    return `<div class="cc-strip-row">
      <span class="cc-strip-label">${label}</span>
      <div class="cc-strip-track"><div class="cc-strip-fill ${fcls}" style="width:${pct}%"></div></div>
      <span class="cc-strip-meta ${tcls}">${pct}%</span>
      <span class="cc-strip-reset">${reset}</span>
    </div>`
  }

  // ── Account & usage popover ────────────────────────────────────────────

  _buildUsagePopover() {
    const div = document.createElement('div')
    div.className = 'cc-usage-popover'
    div.innerHTML = `
      <div class="cc-up-header">
        <span class="cc-up-dot"></span>
        <span class="cc-up-email">—</span>
        <span class="cc-up-plan">—</span>
      </div>
      <div class="cc-up-body">
        <div class="cc-up-loading">Loading…</div>
      </div>
    `
    return div
  }

  _updateUsagePopover() {
    const pop = this.usagePopover
    if (!pop) return

    // Account header — fetch once
    if (this._accountInfo) {
      this._renderHeader(pop)
    } else {
      this._fetchAccountInfo().then(() => this._renderHeader(pop))
    }

    // Usage bars — shared cache with the strip
    const stale = Date.now() - this._usageCacheTime > 60000
    if (this._usageCache && !stale) {
      this._renderBars(pop, this._usageCache)
    } else {
      pop.querySelector('.cc-up-body').innerHTML = '<div class="cc-up-loading">Loading…</div>'
      this._fetchUsage().then((data) => {
        this._usageCache = data
        this._usageCacheTime = Date.now()
        this._renderBars(pop, data)
        this._renderUsageStrip(data)
      })
    }
  }

  _renderHeader(pop) {
    const info = this._accountInfo || {}
    pop.querySelector('.cc-up-dot').classList.toggle('cc-up-dot--online', !!info.loggedIn)
    pop.querySelector('.cc-up-email').textContent = info.email || (info.loggedIn ? 'Logged in' : 'Not logged in')
    const planMap = { pro: 'Claude Pro', max: 'Claude Max', free: 'Free', default_claude_ai: 'Claude.ai' }
    pop.querySelector('.cc-up-plan').textContent = planMap[info.subscriptionType] || info.subscriptionType || ''
  }

  _renderBars(pop, data) {
    const body = pop.querySelector('.cc-up-body')
    if (!data) {
      body.innerHTML = '<div class="cc-up-error">Usage data unavailable</div>'
      return
    }

    const MODEL_LABELS = {
      seven_day_opus:    'Opus (weekly)',
      seven_day_sonnet:  'Sonnet (weekly)',
      seven_day_omelette:'Claude 3 (weekly)',
      seven_day_oauth_apps: 'OAuth apps (weekly)',
    }

    let html = ''
    if (data.five_hour) html += this._barHtml('Current session', data.five_hour)
    if (data.seven_day)  html += this._barHtml('This week', data.seven_day)
    for (const [key, label] of Object.entries(MODEL_LABELS)) {
      const b = data[key]
      if (b && b.resets_at) html += this._barHtml(label, b)
    }

    body.innerHTML = html || '<div class="cc-up-error">No limit data for this plan</div>'
  }

  _barHtml(label, bucket) {
    const pct  = Math.min(100, Math.round(bucket.utilization || 0))
    const cls  = pct >= 85 ? 'cc-up-fill-danger' : pct >= 65 ? 'cc-up-fill-warn' : ''
    const tcls = pct >= 85 ? 'cc-up-pct-danger'  : pct >= 65 ? 'cc-up-pct-warn'  : ''
    const reset = bucket.resets_at ? this._fmtReset(bucket.resets_at) : '—'
    return `
      <div class="cc-up-bar-block">
        <div class="cc-up-bar-row">
          <span class="cc-up-bar-label">${label}</span>
          <span class="cc-up-pct ${tcls}">${pct}%</span>
        </div>
        <div class="cc-up-track"><div class="cc-up-fill ${cls}" style="width:${pct}%"></div></div>
        <div class="cc-up-reset-label">Resets ${reset}</div>
      </div>
    `
  }

  _fmtReset(iso) {
    const d   = new Date(iso)
    const ms  = d - Date.now()
    if (ms <= 0) return 'soon'
    const h = Math.floor(ms / 3600000)
    const m = Math.floor((ms % 3600000) / 60000)
    if (h < 24) return h > 0 ? `in ${h}h ${m}m` : `in ${m}m`
    return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
  }

  _fetchUsage() {
    return new Promise((resolve) => {
      try {
        const https   = require('https')
        const path    = require('path')
        const os      = require('os')
        const fs      = require('fs')
        const creds   = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.claude', '.credentials.json'), 'utf8'))
        const token   = creds.claudeAiOauth?.accessToken
        if (!token) return resolve(null)

        // Detect CLI version from its install path for the User-Agent
        let version = '2'
        try {
          const verDir = path.join(os.homedir(), '.local', 'share', 'claude', 'versions')
          const entries = fs.readdirSync(verDir).filter((f) => /^\d/.test(f))
          if (entries.length) version = entries[entries.length - 1]
        } catch (_) {}

        const req = https.request({
          hostname: 'claude.ai',
          path: '/api/oauth/usage',
          method: 'GET',
          headers: {
            'Authorization': `Bearer ${token}`,
            'User-Agent': `claude-code/${version}`,
          },
        }, (res) => {
          let raw = ''
          res.on('data', (c) => { raw += c })
          res.on('end', () => {
            try { resolve(JSON.parse(raw)) } catch (_) { resolve(null) }
          })
        })
        req.on('error', () => resolve(null))
        req.setTimeout(6000, () => { req.destroy(); resolve(null) })
        req.end()
      } catch (_) {
        resolve(null)
      }
    })
  }

  _fetchAccountInfo() {
    if (this._accountInfo) return Promise.resolve(this._accountInfo)
    return new Promise((resolve) => {
      const { exec } = require('child_process')
      const cliPath = atom.config.get('claude-code.cliPath') || 'claude'
      exec(`${JSON.stringify(cliPath)} auth status`, { timeout: 5000 }, (err, stdout) => {
        try {
          const data = JSON.parse((stdout || '').trim())
          this._accountInfo = { loggedIn: data.loggedIn, email: data.email,
            subscriptionType: data.subscriptionType, authMethod: data.authMethod }
        } catch (_) {
          try {
            const p = require('path'), o = require('os'), f = require('fs')
            const c = JSON.parse(f.readFileSync(p.join(o.homedir(), '.claude', '.credentials.json'), 'utf8'))
            const oauth = c.claudeAiOauth || {}
            this._accountInfo = { loggedIn: true, email: null,
              subscriptionType: oauth.subscriptionType, authMethod: 'claude.ai' }
          } catch (_2) {
            this._accountInfo = { loggedIn: false }
          }
        }
        resolve(this._accountInfo)
      })
    })
  }
}

module.exports = ClaudePanel
