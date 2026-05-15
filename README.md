# BetterMarkdown

A Vencord plugin that extends Discord's markdown rendering with GFM features the native parser doesn't handle.

## Features

| Feature | Syntax | Notes |
|---|---|---|
| Tables | `\| A \| B \|`<br>`\|---\|---\|`<br>`\| 1 \| 2 \|` | Full GFM spec — headers, separators, alignment, inline code awareness |
| Column alignment | `\| :--- \| :---: \| ---: \|` | Left, center, right |
| Escaped pipes | `\| a \| b \| c \|` | `\|` in table cells without breaking the column |
| Task lists | `- [ ] todo`<br>`- [x] done` | Styled checkboxes, backtick-aware |
| Horizontal rules | `---` / `***` / `___` | Themed HR element |

## How it works

Two things happen when a message with supported markdown syntax arrives:

1. **Flux interception** — Listens for message events and installs a reactive getter. The getter re-evaluates on every read, so edits, old messages on scroll, and channel switches all just work.
2. **Parser wrapper** — Wraps Discord's markdown parser so rendered elements also show up in MessageLogger edit history and anywhere else `Parser.parse` is called.

Theme-aware out of the box — uses Discord's CSS variables to match light and dark mode.

## Install

You need Vencord from source:

```bash
git clone https://github.com/Vendicated/Vencord
cd Vencord
pnpm install
pnpm inject
```

Then clone this repo into userplugins:

```bash
cd Vencord/src/userplugins
git clone https://github.com/pnivek/BetterMarkdown BetterMarkdown
cd ../..
pnpm build
```

`Ctrl+R` in Discord to reload.

## Dev

```bash
pnpm build --watch   # auto-rebuilds on save
# Ctrl+R to see changes
```

Debug logs use Vencord's `@utils/Logger` — prefixed with `[BetterMarkdown]`.

## License

GNU General Public License v3.0
