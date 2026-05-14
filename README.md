# BetterMarkdown

A [Vencord](https://vencord.dev) plugin that renders GFM-style markdown tables inline in Discord messages.

## Features

- **Tables** — Renders pipe-delimited tables as styled HTML tables, inline with the message content
- **Partial tables** — Single rows and fragments are rendered as body-only tables (no header)
- **Edits** — Table updates live when a message is edited
- **Old messages** — Already-sent tables render automatically on channel open and on client restart
- **Code block awareness** — Pipe characters inside triple-backtick code blocks are ignored
- **Theme-aware** — Uses Discord's CSS custom properties (`--background-surface-high`, `--background-base-lowest`, `--text-normal`, etc.) to match light and dark themes

## How It Works

Discord exposes a property, `customRenderedContent`, on each message object. If present, the message renderer uses it instead of Discord's normal markdown parser. BetterMarkdown listens for Flux events (`MESSAGE_CREATE`, `MESSAGE_UPDATE`, `LOAD_MESSAGES_SUCCESS`, `CHANNEL_SELECT`) and installs a reactive getter for `customRenderedContent` on any message whose raw content contains pipe-delimited table rows.

The getter checks the message's current content on every read, so edits automatically update without any special handling. For already-loaded messages (on restart or channel switch), the plugin iterates the message store and forces a re-render via `MessageStore.emitChange()`.

No modifications to Discord's markdown parser. No fragile webpack patches.

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
git clone https://github.com/pnivek/BetterMarkdown BetterMarkdown
cd ../..
pnpm build --watch
```

Then `Ctrl+R` in Discord to reload.

## Development

```bash
pnpm build --watch    # auto-rebuilds on save
# Ctrl+R in Discord to see changes
```

Debug logs in the console are prefixed with `[BetterMarkdown]`.

## License

GNU General Public License v3.0
