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

  // Custom renderer to use Pulsar grammar highlighting for code blocks
  const renderer = new m.Renderer()
  renderer.code = ({ text: code, lang }) => {
    const highlighted = highlightCode(lang, code)
    const langClass = lang ? ` class="language-${escapeHtml(lang)}"` : ''
    return `<div class="claude-code-block"><div class="claude-code-block-header"><span class="claude-code-lang">${escapeHtml(lang || 'text')}</span><button class="claude-copy-btn" title="Copy">Copy</button></div><pre><code${langClass}>${highlighted}</code></pre></div>`
  }
  renderer.codespan = ({ text: code }) =>
    `<code class="claude-inline-code">${escapeHtml(code)}</code>`

  return m.parse(text, { renderer })
}

// ── Tool rendering ────────────────────────────────────────────────────────

function getToolIcon() { return '' }

function renderToolInput(name, input) {
  if (!input || typeof input !== 'object') return ''
  const lines = []

  if (name === 'Bash' && input.command) {
    lines.push(`<div class="claude-tool-cmd"><code>${escapeHtml(input.command)}</code></div>`)
  } else if ((name === 'Read' || name === 'Write' || name === 'Edit') && input.file_path) {
    lines.push(`<div class="claude-tool-path">${escapeHtml(input.file_path)}</div>`)
    if (input.new_string) {
      lines.push(`<div class="claude-tool-diff">${escapeHtml(input.new_string.slice(0, 200))}${input.new_string.length > 200 ? '…' : ''}</div>`)
    }
  } else if (name === 'WebSearch' && input.query) {
    lines.push(`<div class="claude-tool-path">${escapeHtml(input.query)}</div>`)
  } else if (name === 'WebFetch' && input.url) {
    lines.push(`<div class="claude-tool-path">${escapeHtml(input.url)}</div>`)
  } else {
    const summary = JSON.stringify(input).slice(0, 120)
    lines.push(`<div class="claude-tool-summary">${escapeHtml(summary)}</div>`)
  }

  return lines.join('')
}

function renderToolResult(content, isError) {
  if (!content) return ''
  const cls = isError ? 'claude-tool-result-error' : 'claude-tool-result-ok'
  const preview = content.length > 300 ? content.slice(0, 300) + '…' : content
  return `<div class="${cls}">${escapeHtml(preview)}</div>`
}

module.exports = { renderMarkdown, highlightCode, escapeHtml, renderToolInput, renderToolResult, getToolIcon }
