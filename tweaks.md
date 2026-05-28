# Pulsar editor tweaks (Debian / Ubuntu)

All commands assume Pulsar is already installed. Close Pulsar before running
the config/init file steps — Pulsar overwrites those files on launch.

---

## 1. Install community packages

```bash
pulsar -p install git-plus
```

---

## 2. Disable unused / performance-hurting bundled packages

```bash
pulsar -p disable \
    github \
    open-on-github \
    metrics \
    exception-reporting \
    dev-live-reload \
    deprecation-cop \
    autocomplete-atom-api \
    package-generator \
    timecop \
    styleguide \
    spell-check \
    welcome \
    about \
    background-tips \
    keybinding-resolver
```

---

## 3. Write `~/.pulsar/config.cson`

```bash
mkdir -p ~/.pulsar
cat > ~/.pulsar/config.cson << 'EOF'
"*":
  core:
    disabledPackages: [
      "github"
      "open-on-github"
      "dev-live-reload"
      "deprecation-cop"
      "autocomplete-atom-api"
      "package-generator"
      "timecop"
      "styleguide"
      "spell-check"
      "welcome"
      "about"
      "background-tips"
      "keybinding-resolver"
    ]
    excludeVcsIgnoredPaths: true
    followSymlinks: false
    ignoredNames: [
      ".git"
      "node_modules"
      "dist"
      "build"
      ".next"
      "venv"
      ".venv"
      "__pycache__"
      "*.pyc"
      "*.o"
      "*.a"
      "target"
    ]
  editor:
    softWrap: false
    showIndentGuide: false
    scrollPastEnd: false
  "autocomplete-plus":
    minimumWordLength: 3
    autoActivationDelay: 300
  "fuzzy-finder":
    ignoredNames: [
      "node_modules/**"
      "dist/**"
      "build/**"
      ".git/**"
      "__pycache__/**"
      "venv/**"
      ".venv/**"
      "target/**"
    ]
  autosave:
    enabled: true
EOF
```

---

## 4. Write `~/.pulsar/init.js` — auto-reload on external file change

Pulsar silently reloads clean (unsaved) buffers already. This snippet also
handles the conflict case: unsaved edits + external change → reverts to disk.

```bash
cat > ~/.pulsar/init.js << 'EOF'
atom.workspace.observeTextEditors(function (editor) {
  editor.getBuffer().onDidConflict(function () {
    editor.getBuffer().revert();
  });
});
EOF
```

---

## 5. Write a performance launch wrapper at `~/.local/bin/pulsar`

Injects Electron/V8 flags without touching `/usr/bin/pulsar`, so package
upgrades don't clobber the flags.

```bash
mkdir -p ~/.local/bin
cat > ~/.local/bin/pulsar << 'EOF'
#!/usr/bin/env bash
export UV_THREADPOOL_SIZE="$(nproc)"
export NODE_ENV=production
exec /usr/bin/pulsar \
    --js-flags="--max-old-space-size=8192 --turbo-fast-api-calls" \
    --disable-renderer-backgrounding \
    --disable-backgrounding-occluded-windows \
    --enable-features=UseOzonePlatform,WaylandWindowDecorations,VaapiVideoDecoder,CanvasOopRasterization \
    --disable-features=TranslateUI,AutofillServerCommunication \
    --ozone-platform=wayland \
    --ignore-gpu-blocklist \
    --enable-gpu-rasterization \
    --enable-zero-copy \
    --enable-native-gpu-memory-buffers \
    --num-raster-threads="$(nproc)" \
    "$@"
EOF
chmod +x ~/.local/bin/pulsar
```

> **X11 users:** remove `--ozone-platform=wayland` and the `UseOzonePlatform,WaylandWindowDecorations` features.

---

## 6. Override the `.desktop` entry to use the wrapper

Makes the app launcher (KDE, GNOME, etc.) also go through the wrapper.
Survives Pulsar package upgrades.

```bash
mkdir -p ~/.local/share/applications
cat > ~/.local/share/applications/pulsar.desktop << EOF
[Desktop Entry]
Name=Pulsar
Exec=$HOME/.local/bin/pulsar %U
Terminal=false
Type=Application
Icon=pulsar
StartupWMClass=Pulsar
Comment=A Community-led Hyper-Hackable Text Editor
Categories=Development;
EOF
update-desktop-database ~/.local/share/applications/ 2>/dev/null || true
```

---

## Summary

| Step | What it does |
|------|-------------|
| 1    | Installs `claude-chat` and `git-plus` packages |
| 2    | Disables 13 unused/telemetry/perf-hurting bundled packages |
| 3    | `config.cson` — disabledPackages, ignore patterns, autosave, autocomplete tuning |
| 4    | `init.js` — auto-revert conflicting buffers to disk version |
| 5    | Launch wrapper — Electron/V8/GPU flags, Wayland, thread pool |
| 6    | `.desktop` override — app launcher uses the wrapper |
