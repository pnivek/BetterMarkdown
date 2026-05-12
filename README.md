# BetterMarkdown

A [Vencord](https://vencord.dev) plugin that renders extended markdown elements inline in Discord chat messages. Handles what Discord's native markdown parser misses.

## Features

- **Tables** — Renders markdown tables ([GFM-style](https://github.github.com/gfm/#tables-extension-)) as styled HTML tables. Supports **multi-message table chains** (auto-detects and merges table fragments split across messages by Discord's 2000-char limit).
- **Task lists** — *(planned)* Renders `- [ ]` / `- [x]` as interactive checkboxes.
- **Horizontal rules** — *(planned)* Renders `---` / `***` / `___` as visible `<hr>` elements.

## How It Works

Discord's built-in markdown parser only supports a subset of the GFM spec. Tables are the biggest gap — when an AI agent (or anyone) sends a markdown table, Discord shows raw text.

This plugin:
1. Listens for messages containing table-like content
2. Looks back through the message history to detect multi-message table chains
3. Merges the fragments and renders a proper HTML table as a **message accessory** (appears below the original message text)

## Installation

### Prerequisites

You need Vencord installed from source (dev build).

```bash
git clone https://github.com/Vendicated/Vencord
cd Vencord
pnpm install
pnpm inject
```

### Install the plugin

```bash
cd Vencord/src/userplugins
git clone https://github.com/pnivek/betterMarkdown betterMarkdown
cd ../..
pnpm build --watch
```

Then `Ctrl+R` in Discord to reload.

## Development

```bash
pnpm build --watch    # auto-rebuilds on save
# Ctrl+R in Discord to see changes
```

## License

GNU General Public License v3.0
