'use strict'

let marked = null

function getMarked() {
  if (!marked) {
    try {
      marked = require('marked')
      marked.setOptions({ breaks: true, gfm: true })
    } catch (_) {
      marked = null
    }
  }
  return marked
}

// ── Code highlighting via Pulsar grammars ─────────────────────────────────

const LANG_SCOPE = {
  js: 'source.js', javascript: 'source.js', ts: 'source.ts', typescript: 'source.ts',
  jsx: 'source.jsx', tsx: 'source.tsx',
  py: 'source.python', python: 'source.python',
  rb: 'source.ruby', ruby: 'source.ruby',
  go: 'source.go',
  rs: 'source.rust', rust: 'source.rust',
  java: 'source.java',
  c: 'source.c', cpp: 'source.cpp', 'c++': 'source.cpp',
  cs: 'source.cs', csharp: 'source.cs',
  sh: 'source.shell', bash: 'source.shell', shell: 'source.shell',
  json: 'source.json',
  yaml: 'source.yaml', yml: 'source.yaml',
  toml: 'source.toml',
  xml: 'text.xml', html: 'text.html',
  css: 'source.css', scss: 'source.css.scss', less: 'source.css.less',
  md: 'text.md', markdown: 'source.gfm',
  sql: 'source.sql',
  r: 'source.r',
  kt: 'source.kotlin', kotlin: 'source.kotlin',
  swift: 'source.swift',
  php: 'text.html.php',
  lua: 'source.lua',
  diff: 'text.git-diff',
}

function highlightCode(lang, code) {
  const scope = lang ? LANG_SCOPE[lang.toLowerCase()] : null
  if (!scope) return escapeHtml(code)

  try {
    const grammar = atom.grammars.grammarForScopeName(scope)
    if (!grammar || grammar.scopeName === 'text.plain') return escapeHtml(code)

    const lines = grammar.tokenizeLines(code)
    return lines
      .map((tokens) =>
        tokens
          .map((tok) => {
            const classes = tok.scopes
              .slice(1)
              .map((s) => 'syntax--' + s.replace(/\./g, ' syntax--'))
              .join(' ')
            return `<span class="${classes}">${escapeHtml(tok.value)}</span>`
          })
          .join('')
      )
      .join('\n')
  } catch (_) {
    return escapeHtml(code)
  }
}

function escapeHtml(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

// ── Markdown rendering ────────────────────────────────────────────────────

function renderMarkdown(text) {
  const m = getMarked()
  if (!m) return `<pre>${escapeHtml(text)}</pre>`

  // Custom renderer to use Pulsar grammar highlighting for code blocks.
  // marked v4 passes (code, lang) as plain strings; v5+ passes a single
  // object { text, lang }. Handle both so inline code doesn't show as "undefined".
  const renderer = new m.Renderer()
  renderer.code = (...args) => {
    const isObj = args[0] !== null && typeof args[0] === 'object'
    const code = isObj ? (args[0].text || '') : (args[0] || '')
    const lang = isObj ? args[0].lang : args[1]
    const highlighted = highlightCode(lang, code)
    const langClass = lang ? ` class="language-${escapeHtml(lang)}"` : ''
    return `<div class="claude-code-block"><div class="claude-code-block-header"><span class="claude-code-lang">${escapeHtml(lang || 'text')}</span><button class="claude-copy-btn" title="Copy">Copy</button></div><pre><code${langClass}>${highlighted}</code></pre></div>`
  }
  renderer.codespan = (...args) => {
    const isObj = args[0] !== null && typeof args[0] === 'object'
    const code = isObj ? (args[0].text || '') : (args[0] || '')
    return `<code class="claude-inline-code">${escapeHtml(code)}</code>`
  }

  return m.parse(text, { renderer })
}

// ── Tool rendering ────────────────────────────────────────────────────────

function getToolIcon() { return '' }

// Returns a short one-line description of a tool call for the collapsed header.
function toolSummary(name, input) {
  if (!input || typeof input !== 'object') return ''
  if (name === 'Bash')     return input.command || ''
  if (name === 'Read' || name === 'Write' || name === 'Edit' || name === 'MultiEdit')
    return input.file_path || ''
  if (name === 'WebSearch') return input.query || ''
  if (name === 'WebFetch')  return input.url   || ''
  if (name === 'Glob' || name === 'Grep') {
    const loc = input.path ? ` in ${input.path}` : ''
    return (input.pattern || '') + loc
  }
  for (const v of Object.values(input)) {
    if (typeof v === 'string') return v.slice(0, 80)
  }
  return ''
}

function renderToolInput(name, input) {
  if (!input || typeof input !== 'object') return ''
  const lines = []

  if (name === 'Bash' && input.command) {
    lines.push(`<div class="claude-tool-cmd"><code>${escapeHtml(input.command)}</code></div>`)
  } else if ((name === 'Read' || name === 'Write' || name === 'Edit' || name === 'MultiEdit') && input.file_path) {
    lines.push(`<div class="claude-tool-path">${escapeHtml(input.file_path)}</div>`)
    if (input.new_string) {
      lines.push(`<div class="claude-tool-diff">${escapeHtml(input.new_string.slice(0, 200))}${input.new_string.length > 200 ? '…' : ''}</div>`)
    }
  } else if (name === 'WebSearch' && input.query) {
    lines.push(`<div class="claude-tool-path">${escapeHtml(input.query)}</div>`)
  } else if (name === 'WebFetch' && input.url) {
    lines.push(`<div class="claude-tool-path">${escapeHtml(input.url)}</div>`)
  } else if ((name === 'Glob' || name === 'Grep') && input.pattern) {
    const loc = input.path ? ` in ${escapeHtml(input.path)}` : ''
    lines.push(`<div class="claude-tool-path">${escapeHtml(input.pattern)}${loc}</div>`)
  } else {
    // Generic fallback: show the first string value, skip empty/object values
    for (const [, v] of Object.entries(input)) {
      if (typeof v === 'string' && v) {
        lines.push(`<div class="claude-tool-summary">${escapeHtml(v.slice(0, 120))}</div>`)
        break
      }
    }
  }

  return lines.join('')
}

function renderToolResult(content, isError, toolName, debug = false) {
  if (!content) return ''
  const cls = isError ? 'claude-tool-result-error' : 'claude-tool-result-ok'

  if (!isError && toolName === 'Write') {
    const cleaned = content
      .replace(/\s*\(file state is current[^)]*\)/gi, '')
      .trim()
    return `<div class="${cls}">${escapeHtml(cleaned)}</div>`
  }

  const preview = !debug && content.length > 300 ? content.slice(0, 300) + '…' : content
  return `<div class="${cls}">${escapeHtml(preview)}</div>`
}

module.exports = { renderMarkdown, highlightCode, escapeHtml, renderToolInput, renderToolResult, toolSummary, getToolIcon }
