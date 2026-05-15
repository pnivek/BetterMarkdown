# BetterMarkdown

A [Vencord](https://vencord.dev) plugin that renders tables, task lists, and horizontal rules inline in Discord messages.

## Features

- **Tables** — Pipe-delimited tables render as styled HTML tables inline with the message content
- **GFM table spec** — Supports headers, separators, alignment markers (`:---`, `:---:`, `---:`), and partial/continuation tables
- **Task lists** — `- [ ]` and `- [x]` render as styled checkboxes with proper styling
- **Horizontal rules** — `---`, `***`, and `___` render as visible HR elements
- **Escaped pipes** — `\|` inside table cells renders a literal pipe character without triggering a column break
- **Column-consistent parsing** — Mismatched column counts produce separate tables instead of garbled output
- **Inline code awareness** — Pipes inside backtick-delimited code spans (`` `| code |` ``) don't trigger table detection
- **Leading/trailing text** — Text before or after the pipe structure on any row is preserved and rendered naturally
- **Pagination markers** — Discord's auto-appended `(1/2)` markers render as text below the table instead of breaking it
- **Edits** — Tables update live when a message is edited (reactive getter re-evaluates on every read)
- **Old messages** — Already-sent tables render automatically on channel open, scroll, and client restart
- **MessageLogger compatible** — Tables render in MessageLogger's edit history via a `Parser.parse` wrapper
- **Full markdown in cells** — Bold, italic, inline code, links, and Discord mentions all render inside table cells
- **Markdown in mixed messages** — Headings, lists, code blocks, and links render correctly alongside tables
- **Theme-aware** — Uses Discord's CSS custom properties to match light and dark themes

## How It Works

**Two interception points:**

1. **Flux event interception** — Listens for `MESSAGE_CREATE`, `MESSAGE_UPDATE`, `LOAD_MESSAGES_SUCCESS`, `CHANNEL_SELECT`, and `CONNECTION_OPEN` to install a reactive getter for `customRenderedContent` on any message whose raw content contains pipe-delimited table rows. The getter checks `this.content` on every read, so edits automatically re-render without any special handling.

2. **`Parser.parse` wrapper** — Wraps Discord's native markdown parser so tables also render in MessageLogger edit history, channel topics, and any other context that calls `Parser.parse` directly. Live messages use the getter path, so there's no risk of double-processing.

No fragile webpack patches. Pure Flux events and `Object.defineProperty`.

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
pnpm build
```

Then `Ctrl+R` in Discord to reload.

## Development

```bash
pnpm build --watch    # auto-rebuilds on save
# Ctrl+R in Discord to see changes
```

Debug logs are prefixed with `[Vencord] BetterMarkdown` (uses Vencord's `@utils/Logger`).

## License

GNU General Public License v3.0
