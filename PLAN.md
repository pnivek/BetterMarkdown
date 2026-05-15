# Lexer-Refactor Implementation Plan

> **For Hermes:** Use subagent-driven-development skill to implement this plan task-by-task.

**Goal:** Replace the regex-based, salvage-dependent parsing with a two-pass lexer+parser architecture that uses a single stack-based tokenizer, eliminates the salvage fallback, and provides a clean foundation for future markdown extensions.

**Architecture:** A stack-based lexer walks the entire content string once, producing line-level tokens (code blocks, table rows with pre-extracted cells/leading/trailing text, plain text). A parser then walks tokens to assemble ContentBlocks. Column mismatches become natural table boundaries — the salvage fallback disappears.

**Tech Stack:** TypeScript, Vencord plugin API, React JSX (unchanged rendering layer)

---

## Problem Statement

The current `parseContentBlocks` + `parseSingleTable` approach has three pain points:

1. **Redundant backtick tracking** — `isTableRow`, `splitCells`, and the leading-text extraction loop all implement backtick awareness independently (three copies of the same logic, two different approaches: regex strip vs codeDelim pair-matching).

2. **Salvage fallback** — `parseContentBlocks` groups lines by `isTableRow()` adjacency, then discovers column counts don't match, then re-slices via the salvage path (lines 185-215). This is a bug magnet — the parser produces the wrong grouping and then patches it.

3. **Flat ContentBlock type** — `{ type: "text" }` conflates code blocks, regular text, and mixed markdown. No way to extend without breaking the type.

## Solution: Two-Pass Lexer+Parser

### Pass 1: `tokenize(content: string): LineToken[]`

One character walk across the full content. Stack-based contextual state:

```
State stack:
  []                           — top-level text
  ["code_block"]               — inside ```
  ["inline", 2]                — inside `` (2-backtick code span)
  ["code_block", "inline", 1]  — inside ``` > ` (code block > inline code)
```

Produces three token types:

```typescript
type LineToken =
    | { kind: "code_block_fence"; fence: string }
    | { kind: "table_row"; cells: string[]; leading: string; trailing: string }
    | { kind: "text"; content: string };
```

Key: **every table row token already has its cells extracted**. The parser never calls `splitCells` — cells are a property of the token, computed once by the lexer.

### Pass 2: `parse(tokens: LineToken[]): ContentBlock[]`

Walk tokens linearly. Table rows are grouped by adjacency only when column counts actually match. No salvage — mismatched columns naturally close one table and start another.

```typescript
type ContentBlock =
    | { type: "text"; text: string }
    | { type: "table"; header: string[]; body: string[][] }
    | { type: "code_block"; content: string; fence: string };
```

### What stays unchanged

- `TableComponent`, `renderContent`, `installGetter`, `handleMsg`, `processChannel`
- `Parser.parse` wrapper
- Flux event subscriptions
- `hasTableSyntax` (still used for fast bailout)

### What's removed

- `isTableRow` (replaced by lexer's inline-code-aware pipe detection)
- `isSeparator` (replaced by `isSeparatorCells(cells)`)
- `splitCells` (cells extracted by lexer)
- `parseContentBlocks` (replaced by `parse(tokens)`)
- `parseSingleTable` (replaced by table assembly in parser)
- Salvage fallback (~30 lines)
- `TABLE_ROW_RE` (replaced by character-level parsing)

### What's new

- `tokenize()` — the unified lexer
- `parse()` — token-to-block assembler
- `isSeparatorCells()` — stateless, takes pre-extracted cells
- `ContentBlock` extended with `code_block` variant

---

## Tasks

### Task 1: Add `code_block` variant to ContentBlock

**Objective:** Extend the type system to support the new block variant

**Files:**
- Modify: `index.tsx` (type definition)

**Step 1: Update `ContentBlock` type**

```typescript
type ContentBlock =
    | { type: "text"; text: string }
    | { type: "table"; header: string[]; body: string[][] }
    | { type: "code_block"; content: string; fence: string };
```

**Step 2: Build + verify**

No functional change — type only. `pnpm build` should succeed since no references to `code_block` exist yet.

**Step 3: Commit**

```bash
git add index.tsx
git commit -m "refactor: add code_block variant to ContentBlock type"
```

---

### Task 2: Implement `isSeparatorCells` (stateless replacement for `isSeparator`)

**Objective:** Replace `isSeparator(line)` with `isSeparatorCells(cells)` — takes pre-extracted cells instead of parsing a line

**Files:**
- Modify: `index.tsx`

**Step 1: Add function**

Add after `ContentBlock` type, before `isTableRow`:

```typescript
function isSeparatorCells(cells: string[]): boolean {
    return cells.length > 0 && cells.every(c => /^:?-+:?$/.test(c));
}
```

**Step 2: Rewrite `isSeparator` as compatibility wrapper**

```typescript
// Kept temporarily for existing callers — will be removed in Task 6
function isSeparator(l: string): boolean {
    return isSeparatorCells(splitCells(l));
}
```

No behavior change — just indirection through the new function.

**Step 3: Commit**

```bash
git add index.tsx
git commit -m "refactor: add stateless isSeparatorCells, delegate isSeparator"
```

---

### Task 3: Implement the lexer — `tokenize()`

**Objective:** Single character walk that produces `LineToken[]` with stack-based state

**Files:**
- Modify: `index.tsx`

**Step 1: Add `LineToken` type**

Add after `ContentBlock`:

```typescript
type LineToken =
    | { kind: "code_block_fence"; fence: string }
    | { kind: "table_row"; cells: string[]; leading: string; trailing: string }
    | { kind: "text"; content: string };
```

**Step 2: Implement `tokenize()`**

Add after the new type, before existing parsing functions:

```typescript
function tokenize(content: string): LineToken[] {
    const lines = content.split("\n");
    const tokens: LineToken[] = [];
    const state: string[] = []; // stack: "code_block" | "inline:N"

    for (const rawLine of lines) {
        const trimmed = rawLine.trim();
        const currentState = state[state.length - 1] ?? null;

        // Code block fences — toggle state on ```
        if (trimmed.startsWith("```")) {
            if (currentState === "code_block") {
                state.pop();
                tokens.push({ kind: "code_block_fence", fence: trimmed });
            } else {
                state.push("code_block");
                tokens.push({ kind: "code_block_fence", fence: trimmed });
            }
            continue;
        }

        // Inside code block — everything is text
        if (currentState === "code_block") {
            tokens.push({ kind: "text", content: rawLine });
            continue;
        }

        // Outside code — try to parse as table row
        const row = tryParseTableRow(rawLine);
        if (row) {
            tokens.push(row);
        } else {
            tokens.push({ kind: "text", content: rawLine });
        }
    }

    return tokens;
}
```

**Step 3: Implement `tryParseTableRow()` — the unified backtick-aware pipe parser**

```typescript
function tryParseTableRow(raw: string): LineToken | null {
    const line = raw.trim();

    // Character walk with backtick group-pair tracking.
    // Three phases:
    //   1. Before first pipe → leading text
    //   2. Between pipes → cell content
    //   3. After last pipe → trailing text

    let leading = "";
    let cells: string[] = [];
    let cell = "";
    let trailing = "";
    let phase: "leading" | "cells" | "trailing" = "leading";

    // Stack-based inline code tracking:
    //   null → not in code
    //   number → in code, started by N backticks
    let codeDelim: number | null = null;
    let i = 0;

    while (i < line.length) {
        const ch = line[i];

        // Backtick groups — toggle code state via stack semantics
        if (ch === "`") {
            let count = 1;
            while (i + count < line.length && line[i + count] === "`") count++;

            if (codeDelim === null) {
                codeDelim = count;  // entering inline code
            } else if (count === codeDelim) {
                codeDelim = null;   // exiting inline code
            }
            // else: nested group of different length — content, not delimiter

            // Always add backticks to the current buffer
            const chunk = line.slice(i, i + count);
            if (phase === "leading") leading += chunk;
            else if (phase === "cells") cell += chunk;
            else trailing += chunk;

            i += count;
            continue;
        }

        // Pipe outside code → phase transition
        if (ch === "|" && codeDelim === null) {
            if (phase === "leading") {
                leading = leading.trimEnd();
                phase = "cells";
            } else if (phase === "cells") {
                cells.push(cell.trim());
                cell = "";
                // stay in cells phase — next | will push again
            }
            // In trailing phase: | is just regular text
            else {
                trailing += ch;
            }
            i++;
            continue;
        }

        // Regular character
        if (phase === "leading") leading += ch;
        else if (phase === "cells") cell += ch;
        else trailing += ch;
        i++;
    }

    // Not a table row if we never entered the cells phase
    if (phase === "leading") return null;

    // Need at least 2 cells (one pipe creates 2 cells)
    if (cells.length < 2 && cell.trim() === "") return null;

    // Push the final cell if there's residual content after last |
    if (cell.trim() || cells.length > 0) cells.push(cell.trim());

    // If ALL cells are empty (all content was in inline code that got stripped),
    // this isn't really a table row
    if (cells.every(c => c === "")) return null;

    return {
        kind: "table_row",
        cells,
        leading: leading.trim(),
        trailing: trailing.trim(),
    };
}
```

**Step 4: Verify the logic handles known edge cases**

Mental trace:

| Input | Expected |
|-------|----------|
| `\| a \| b \|` | 2 cells: `["a", "b"]`, no leading/trailing |
| `text \| a \| b \| (1/2)` | leading="text", 2 cells, trailing="(1/2)" |
| `` \| \`Code\` \| \`\` \`inline code\` \`\` \| `` | 2 cells: `["\`Code\`", "\`\` \`inline code\` \`\`"]` |
| `` \`\| code \|\` `` | no table (all pipes inside code → never exits leading phase) |
| `\|---|---\|` | 2 empty cells — but separator check handles this |
| `\|---\|` | separator cells: `["---"]` — handled by `isSeparatorCells`|

**Step 5: Commit**

```bash
git add index.tsx
git commit -m "feat: implement tokenize() and tryParseTableRow() lexer"
```

---

### Task 4: Implement `parse(tokens) → ContentBlock[]`

**Objective:** Token-to-block assembler that groups table rows by column count match

**Files:**
- Modify: `index.tsx`

**Step 1: Implement `parse()`**

Add after `tokenize()`:

```typescript
function parse(tokens: LineToken[]): ContentBlock[] {
    const blocks: ContentBlock[] = [];
    let i = 0;

    while (i < tokens.length) {
        const t = tokens[i];

        if (t.kind === "code_block_fence") {
            // Collect code block: opening fence, content, closing fence
            const fence = t.fence;
            const codeLines: string[] = [t.fence];
            i++;
            while (i < tokens.length && tokens[i].kind !== "code_block_fence") {
                codeLines.push(tokens[i].kind === "text" ? tokens[i].content : "");
                i++;
            }
            if (i < tokens.length) {
                codeLines.push(tokens[i].fence);
                i++;
            }
            blocks.push({ type: "code_block", content: codeLines.join("\n"), fence });
            continue;
        }

        if (t.kind === "table_row") {
            // Collect consecutive table rows into a single table.
            // Split into separate tables when column counts differ
            // (no salvage needed — the lexer already extracted cells).
            const rows: LineToken[] = [];
            const leadingText: string[] = [];
            const trailingText: string[] = [];

            while (i < tokens.length && tokens[i].kind === "table_row") {
                const tr = tokens[i] as { kind: "table_row"; cells: string[]; leading: string; trailing: string };
                rows.push(tr);
                if (tr.leading) leadingText.push(tr.leading);
                if (tr.trailing) trailingText.push(tr.trailing);
                i++;
            }

            // Push leading text (from first row only, per existing behavior)
            if (leadingText.length > 0)
                blocks.push({ type: "text", text: leadingText[0] });

            // Build table(s) from rows — split on column count changes
            buildTables(rows, blocks);

            // Push trailing text
            if (trailingText.length > 0)
                blocks.push({ type: "text", text: trailingText.join(" ") });

            continue;
        }

        // Plain text — accumulate until next non-text token
        const textLines: string[] = [];
        while (i < tokens.length && tokens[i].kind === "text") {
            textLines.push(tokens[i].content);
            i++;
        }
        const joined = textLines.join("\n").trim();
        if (joined) blocks.push({ type: "text", text: joined });
    }

    return blocks;
}
```

**Step 2: Implement `buildTables()` — column-aware table assembly**

```typescript
function buildTables(rows: { cells: string[]; leading: string; trailing: string }[], blocks: ContentBlock[]): void {
    let start = 0;

    while (start < rows.length) {
        // Find separator in this group
        const sepIdx = rows.slice(start).findIndex(r => isSeparatorCells(r.cells));
        const absSep = sepIdx >= 0 ? start + sepIdx : -1;

        if (absSep >= 0 && absSep > start) {
            // Full table: header (rows before sep) + separator + body (rows after sep)
            const header = rows[start].cells;
            const bodyRows = rows.slice(absSep + 1);

            // Check column consistency: body must match header
            const bodyOk = bodyRows.length === 0 || bodyRows.every(r => r.cells.length === header.length);

            if (bodyOk && header.length >= 1) {
                blocks.push({
                    type: "table",
                    header,
                    body: bodyRows.map(r => r.cells),
                });
                start = absSep + 1 + bodyRows.length;
                continue;
            }
            // Fall through to body-only if mismatch
        }

        if (absSep === start) {
            // Separator at start — body-only table
            const bodyRows = rows.slice(absSep + 1);
            if (bodyRows.length === 0) {
                start++;
                continue; // separator alone, skip
            }
            const cellCount = bodyRows[0].cells.length;
            const end = start + 1;
            let j = end;
            while (j < rows.length && rows[j].cells.length === cellCount && !isSeparatorCells(rows[j].cells)) j++;

            if (cellCount >= 2) {
                blocks.push({
                    type: "table",
                    header: [],
                    body: bodyRows.slice(0, j - end).map(r => r.cells),
                });
            }
            start = j;
            continue;
        }

        // No separator — body-only (all rows including current)
        const cellCount = rows[start].cells.length;
        if (cellCount < 2) {
            blocks.push({ type: "text", text: rows[start].cells.map(c => `| ${c} |`).join(" ") });
            start++;
            continue;
        }

        let end = start + 1;
        while (end < rows.length && rows[end].cells.length === cellCount && !isSeparatorCells(rows[end].cells)) end++;

        blocks.push({
            type: "table",
            header: [],
            body: rows.slice(start, end).map(r => r.cells),
        });
        start = end;
    }
}
```

**Step 3: Commit**

```bash
git add index.tsx
git commit -m "feat: implement parse() and buildTables() — token-to-block assembler"
```

---

### Task 5: Rewrite `hasTableSyntax` to use lexer

**Objective:** Replace the old `hasTableSyntax` with one that uses the lexer for consistent detection

**Files:**
- Modify: `index.tsx`

**Step 1: Rewrite `hasTableSyntax`**

```typescript
function hasTableSyntax(c: string): boolean {
    const tokens = tokenize(c);
    return tokens.some(t => t.kind === "table_row");
}
```

This replaces ~10 lines of manual code-block tracking with a single line. The lexer already handles code block awareness.

**Step 2: Commit**

```bash
git add index.tsx
git commit -m "refactor: rewrite hasTableSyntax to use tokenize()"
```

---

### Task 6: Rewrite `parseContentBlocks` to use `tokenize` + `parse`

**Objective:** Wire the new lexer+parser into the content block pipeline

**Files:**
- Modify: `index.tsx`

**Step 1: Rewrite `parseContentBlocks`**

```typescript
function parseContentBlocks(c: string): ContentBlock[] {
    return parse(tokenize(c));
}
```

**Step 2: Commit**

```bash
git add index.tsx
git commit -m "refactor: rewrite parseContentBlocks to use tokenize()+parse()"
```

---

### Task 7: Remove dead code

**Objective:** Delete all functions made obsolete by the lexer+parser

**Files:**
- Modify: `index.tsx`

**Step 1: Remove obsolete functions**

Delete:
- `isTableRow` (lines 53-60)
- `isSeparator` (the wrapper, lines 61-63 — keep `isSeparatorCells`)
- `splitCells` (lines 65-110)
- `parseSingleTable` (lines 225-255)
- `TABLE_ROW_RE` (lines 42-51)

**Step 2: Remove import if unused**

If `findByPropsLazy` was only used for old parsing, remove it. (It isn't — still used for MessageStore/SelectedChannelStore, so keep it.)

**Step 3: Commit**

```bash
git add index.tsx
git commit -m "refactor: remove dead parsing functions (isTableRow, splitCells, parseSingleTable, TABLE_ROW_RE)"
```

---

### Task 8: Update header comment and verify line count

**Objective:** Update the architecture comment block to describe the new two-pass design

**Files:**
- Modify: `index.tsx`

**Step 1: Replace the header comment**

Replace lines 1-26 with:

```typescript
/*
 * BetterMarkdown — Renders GFM-style markdown tables inline in Discord messages.
 *
 * Architecture (two interception points):
 * 1. Flux event interception — Installs a reactive getter for
 *    customRenderedContent on messages with table syntax.
 * 2. Parser.parse wrapper — Wraps Discord's markdown parser so tables
 *    render in MessageLogger edit history and any other context.
 *
 * Parsing strategy (two-pass lexer + parser):
 * - tokenize() — Single pass through content with a stack for nested state
 *   (code blocks, inline code). Produces line-level tokens: code_block_fence,
 *   table_row (with pre-extracted cells + leading/trailing text), or text.
 * - parse() — Walks tokens, assembles ContentBlocks. Table rows group by
 *   column count match — no salvage fallback, no re-slicing.
 * - isSeparatorCells() — Stateless check on pre-extracted cell arrays.
 * - buildTables() — Column-aware table builder, splits on count mismatch.
 *
 * Benefits: one backtick-tracking implementation (vs 3 before), no salvage
 * fallback, clean foundation for future markdown extensions.
 */
```

**Step 2: Verify total line count dropped significantly**

Run: `wc -l index.tsx`

Target: ~340 lines (down from 441 — ~100 lines removed from dead code + salvage + duplicate backtick logic, offset by ~50 new lines in lexer/parser).

**Step 3: Commit**

```bash
git add index.tsx
git commit -m "docs: update header comment for two-pass lexer+parser architecture"
```

---

### Task 9: Full integration test — verify all existing test cases pass

**Objective:** Ensure the refactor doesn't regress any known behavior

**Files:**
- No changes (test validation only)

**Step 1: Build**

```bash
pnpm build
```
Expected: no errors.

**Step 2: Manual test matrix** (Kevin runs these in Discord)

| # | Test case | Expected behavior |
|---|-----------|------------------|
| 1 | `\| A \| B \|\n\|-\|-\|\n\| 1 \| 2 \|` | 2-col table with header |
| 2 | `\|-\|-\|\n\| a \| b \|` | Body-only table |
| 3 | `\| 1 \| 2 \|\n\| 3 \| 4 \|` | Body-only (no sep) |
| 4 | `text \| A \| B \|` | "text" before 2-col table |
| 5 | `\| A \| B \| (1/2)` | Table with "(1/2)" as trailing text |
| 6 | `` \`\| code \|\` `` | No table (pipe in code) |
| 7 | `` \| \`Code\` \| stuff \| `` | 2 cells, cell[0] = "\`Code\`" |
| 8 | `\| **Bold** \| *Italic* \|` | Bold/italic in cells |
| 9 | `\| a \| real \| table \|\n\|-\|-\|-\|-\|\n\| works \| fine \| test \|` | 2-col body table + 3-col body table (column mismatch) |
| 10 | `## Heading\n\n\| A \| B \|\n\|-\|-\|\n\| 1 \| 2 \|` | Heading renders above table |
| 11 | Table in MessageLogger edit history | Renders correctly |

**Step 3: Fix any regressions**

If test case 9 breaks (column mismatch), adjust `buildTables()` logic.

**Step 4: Commit any fixes**

```bash
git add index.tsx
git commit -m "fix: address integration test regressions"
```

---

### Task 10: Push to remote

**Objective:** Push the lexer-refactor branch

```bash
git push origin lexer-refactor
```

---

## Summary of changes

| Metric | Before | After |
|--------|--------|-------|
| Backtick parsing implementations | 3 (isTableRow, splitCells, leading text) | 1 (tryParseTableRow) |
| Salvage fallback | 30 lines | 0 lines |
| Total lines | 441 | ~340 |
| Parsing functions | 5 (isTableRow, isSeparator, splitCells, parseContentBlocks, parseSingleTable) | 4 (tokenize, tryParseTableRow, parse, buildTables) |
| Function cohesion | Mixed regex + char-walk + salvage | Stack-based lexer + linear parser |
| Extensibility | Hard (parseContentBlocks knows about tables only) | Easy (add token type + block type + parser branch) |

---

## Post-refactor: next steps

After the lexer refactor is stable, future markdown features attach cleanly:

- **Task lists** `- [ ] item` → add `task_list_item` token type
- **Horizontal rules** `---` → detect in lexer (not table separator)
- **Footnotes** `[^1]` → add `footnote_ref` token
- **Definition lists** `: term` → add `definition` token type

Each is a new token kind + a new branch in `parse()` + a new React component. No shotgun surgery.
