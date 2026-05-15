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
 *   (code blocks). Produces line-level tokens: code_block_fence, table_row
 *   (with pre-extracted cells + leading/trailing text), or text.
 * - tryParseTableRow() — Backtick delimiter-pair matching (stack semantics)
 *   extracts cells from the original line preserving inline code content.
 * - parse() — Walks tokens, assembles ContentBlocks. Table rows group by
 *   column count match — no salvage fallback, no re-slicing.
 * - buildTables() — Column-aware table builder, splits on count mismatch.
 * - isSeparatorCells() — Stateless check on pre-extracted cell arrays.
 *
 * Benefits over the previous approach:
 * - One backtick-tracking implementation (vs 3 before)
 * - No salvage fallback (column mismatch is a natural table boundary)
 * - ContentBlock includes code_block variant for future extensibility
 */

import definePlugin from "@utils/types";
import { FluxDispatcher, Parser, React } from "@webpack/common";
import { findByPropsLazy } from "@webpack";
import { Logger } from "@utils/Logger";

const logger = new Logger("BetterMarkdown", "#a6d189");

const MessageStore = findByPropsLazy("getMessage", "getMessages");
const SelectedChannelStore = findByPropsLazy("getChannelId");

type ContentBlock =
    | { type: "text"; text: string }
    | { type: "table"; header: string[]; body: string[][] }
    | { type: "code_block"; content: string; fence: string };

type LineToken =
    | { kind: "code_block_fence"; fence: string }
    | { kind: "table_row"; cells: string[]; leading: string; trailing: string }
    | { kind: "text"; content: string };

function isSeparatorCells(cells: string[]): boolean {
    return cells.length > 0 && cells.every(c => /^:?-+:?$/.test(c));
}

// ---------------------------------------------------------------------------
// Lexer: single-pass tokenizer with stack-based code-awareness.
// Produces LineToken[] — each table_row token already has cells extracted.
// ---------------------------------------------------------------------------

function tokenize(content: string): LineToken[] {
    const lines = content.split("\n");
    const tokens: LineToken[] = [];
    const state: string[] = []; // stack: "code_block"

    for (const rawLine of lines) {
        const trimmed = rawLine.trim();
        const currentState = state[state.length - 1] ?? null;

        // Code block fences toggle state on ```
        if (trimmed.startsWith("```")) {
            if (currentState === "code_block") {
                state.pop();
            } else {
                state.push("code_block");
            }
            tokens.push({ kind: "code_block_fence", fence: trimmed });
            continue;
        }

        // Inside a code block — everything is literal text
        if (currentState === "code_block") {
            tokens.push({ kind: "text", content: rawLine });
            continue;
        }

        // Outside code — try to parse as a table row
        const row = tryParseTableRow(rawLine);
        tokens.push(row ?? { kind: "text", content: rawLine });
    }

    return tokens;
}

// Character-by-character table row parser with backtick delimiter-pair
// matching (stack semantics). Three phases:
//   1. leading — text before the first unquoted pipe
//   2. cells   — content between pipes (IS cell content)
//   3. trailing — text after the last unquoted pipe
function tryParseTableRow(raw: string): LineToken | null {
    const line = raw.trim();

    let leading = "";
    let cells: string[] = [];
    let cell = "";
    let trailing = "";
    let phase: "leading" | "cells" | "trailing" = "leading";

    // Stack-based inline code tracking:
    //   null  → not inside inline code
    //   number → inside code, opened by N consecutive backticks
    let codeDelim: number | null = null;
    let i = 0;

    while (i < line.length) {
        const ch = line[i];

        // Backtick grouping — treat consecutive backticks as a unit
        if (ch === "`") {
            let count = 1;
            while (i + count < line.length && line[i + count] === "`") count++;

            if (codeDelim === null) {
                codeDelim = count;       // entering inline code
            } else if (count === codeDelim) {
                codeDelim = null;        // exiting inline code
            }
            // Different-length group inside code = content, not delimiter

            const chunk = line.slice(i, i + count);
            if (phase === "leading") leading += chunk;
            else if (phase === "cells") cell += chunk;
            else trailing += chunk;

            i += count;
            continue;
        }

        // Pipe outside of inline code → phase transition
        if (ch === "|" && codeDelim === null) {
            if (phase === "leading") {
                leading = leading.trimEnd();
                phase = "cells";
            } else if (phase === "cells") {
                cells.push(cell.trim());
                cell = "";
            }
            // In trailing phase, a stray | is just literal text
            else {
                trailing += ch;
            }
            i++;
            continue;
        }

        // Regular character — route to current phase
        if (phase === "leading") leading += ch;
        else if (phase === "cells") cell += ch;
        else trailing += ch;
        i++;
    }

    // Never entered the cells phase → not a table row
    if (phase === "leading") return null;

    // Need at least 2 cells (single pipe produces 2 cells minimum)
    if (cells.length < 2 && cell.trim() === "") return null;

    // Push the final cell if there's residual content after the last |
    if (cell.trim() || cells.length > 0) cells.push(cell.trim());

    // If every cell is empty the line had no real table content
    if (cells.every(c => c === "")) return null;

    return {
        kind: "table_row",
        cells,
        leading: leading.trim(),
        trailing: trailing.trim(),
    };
}

// ---------------------------------------------------------------------------
// Parser: walks tokens → ContentBlock[].
// Table rows group by column count match — no salvage fallback, no re-slicing.
// ---------------------------------------------------------------------------

function parse(tokens: LineToken[]): ContentBlock[] {
    const blocks: ContentBlock[] = [];
    let i = 0;

    while (i < tokens.length) {
        const t = tokens[i];

        if (t.kind === "code_block_fence") {
            // Collect entire code block: opening fence + content + closing fence
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
            // Collect consecutive table-row tokens
            const rows: { kind: "table_row"; cells: string[]; leading: string; trailing: string }[] = [];
            const leadingText: string[] = [];
            const trailingText: string[] = [];

            while (i < tokens.length && tokens[i].kind === "table_row") {
                const tr = tokens[i] as Extract<LineToken, { kind: "table_row" }>;
                rows.push(tr);
                if (tr.leading) leadingText.push(tr.leading);
                if (tr.trailing) trailingText.push(tr.trailing);
                i++;
            }

            // Emit leading text from the first row (existing behavior)
            if (leadingText.length > 0)
                blocks.push({ type: "text", text: leadingText[0] });

            // Build table(s) — split on column count mismatches
            buildTables(rows, blocks);

            // Emit trailing text
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

// Column-aware table builder. Groups consecutive rows into tables,
// splitting when column counts differ. Handles all three GFM cases:
//   1. separator-first → body-only table
//   2. header + separator + body → full table
//   3. no separator → body-only table
function buildTables(
    rows: { cells: string[]; leading: string; trailing: string }[],
    blocks: ContentBlock[]
): void {
    let start = 0;

    while (start < rows.length) {
        const sepIdx = rows.slice(start).findIndex(r => isSeparatorCells(r.cells));
        const absSep = sepIdx >= 0 ? start + sepIdx : -1;

        if (absSep >= 0 && absSep > start) {
            // Case 2: header + separator + body
            const header = rows[start].cells;
            const bodyRows = rows.slice(absSep + 1);

            // Column consistency: body must match header width
            const bodyOk = bodyRows.length === 0 ||
                bodyRows.every(r => r.cells.length === header.length);

            if (bodyOk && header.length >= 1) {
                blocks.push({
                    type: "table",
                    header,
                    body: bodyRows.map(r => r.cells),
                });
                start = absSep + 1 + bodyRows.length;
                continue;
            }
            // Mismatch → fall through to body-only interpretation
        }

        if (absSep === start) {
            // Case 1: separator-first — body-only table
            const bodyRows = rows.slice(absSep + 1);
            if (bodyRows.length === 0) { start++; continue; }

            const cellCount = bodyRows[0].cells.length;
            let end = start + 1;
            while (end < rows.length &&
                   rows[end].cells.length === cellCount &&
                   !isSeparatorCells(rows[end].cells)) end++;

            if (cellCount >= 2) {
                blocks.push({
                    type: "table",
                    header: [],
                    body: bodyRows.slice(0, end - (start + 1)).map(r => r.cells),
                });
            }
            start = end;
            continue;
        }

        // Case 3: no separator — body-only table
        const cellCount = rows[start].cells.length;
        if (cellCount < 2) {
            // Single cell row → treat as regular text
            blocks.push({ type: "text", text: rows[start].cells.map(c => `| ${c} |`).join(" ") });
            start++;
            continue;
        }

        let end = start + 1;
        while (end < rows.length &&
               rows[end].cells.length === cellCount &&
               !isSeparatorCells(rows[end].cells)) end++;

        blocks.push({
            type: "table",
            header: [],
            body: rows.slice(start, end).map(r => r.cells),
        });
        start = end;
    }
}
function hasTableSyntax(c: string): boolean {
    return tokenize(c).some(t => t.kind === "table_row");
}

function parseContentBlocks(c: string): ContentBlock[] {
    return parse(tokenize(c));
}
function TableComponent({ header, body }: { header: string[]; body: string[][] }) {
    const inlineOpts = { allowLinks: true, allowList: true };
    return (<div style={{ marginTop: 4, marginBottom: 4, overflow: "hidden", borderRadius: 4, border: "2px solid var(--background-surface-high)", background: "var(--background-secondary)", color: "var(--text-normal)", maxWidth: "100%" }}>
        <table style={{ borderCollapse: "collapse", width: "100%", fontSize: 13, fontFamily: "var(--font-primary)" }}>
            {header.length > 0 && <thead><tr>{header.map((c, i) => <th key={i} style={{ border: "2px solid var(--background-surface-high)", padding: "8px 12px", textAlign: "left", fontWeight: 600, background: "var(--background-surface-high)" }}>{Parser.parse(c, true, inlineOpts) ?? c}</th>)}</tr></thead>}
            {body.length > 0 && <tbody>{body.map((row, ri) => <tr key={ri}>{row.map((c, ci) => <td key={ci} style={{ border: "2px solid var(--background-surface-high)", padding: "8px 12px", background: "var(--background-base-lowest)" }}>{Parser.parse(c, true, inlineOpts) ?? c}</td>)}</tr>)}</tbody>}
        </table></div>);
}
function renderContent(blocks: ContentBlock[]): React.ReactNode {
    const textOpts = { allowHeading: true, allowLinks: true, allowList: true, allowEmojiLinks: true };

    if (blocks.length === 1 && blocks[0].type === "text")
        return Parser.parse(blocks[0].text, false, textOpts);

    const ch: React.ReactNode[] = [];
    for (const b of blocks) {
        if (b.type === "text") {
            ch.push(React.createElement(React.Fragment, { key: ch.length },
                Parser.parse(b.text, false, textOpts)));
        } else if (b.type === "table") {
            ch.push(React.createElement(TableComponent, { key: ch.length, header: b.header, body: b.body }));
        } else {
            // code_block — pass through to Discord's parser as-is
            ch.push(React.createElement(React.Fragment, { key: ch.length },
                Parser.parse(b.content, false, textOpts)));
        }
    }
    return React.createElement(React.Fragment, null, ...ch);
}

// Install a reactive getter for customRenderedContent on a message object.
// The getter re-evaluates this.content on every read, so table rendering
// automatically updates when the message is edited — no MESSAGE_UPDATE
// handler needed for the getter itself (the Flux handler still handles the
// initial detection and edge cases).
function installGetter(msg: any): boolean {
    if (!msg?.content || typeof msg.content !== "string") return false;
    if (!hasTableSyntax(msg.content)) return false;
    delete msg.customRenderedContent;
    Object.defineProperty(msg, "customRenderedContent", {
        get() {
            if (!this?.content || typeof this.content !== "string") return void 0;
            if (!hasTableSyntax(this.content)) return void 0;
            return {
                content: renderContent(parseContentBlocks(this.content)),
                hasSpoilerEmbeds: false,
                hasBailedAst: false,
            };
        },
        configurable: true,
        enumerable: false,
    });
    return true;
}

// Handle a message or message batch from any Flux event source.
// Sets customRenderedContent on the raw event data (sync — store copies this
// into the new Message object) and also installs a reactive getter on the
// stored message in MessageStore (async/microtask — in case the event data
// is a shallow copy that won't persist).
function handleMsg(channelIdIn: string, message: any, source: string) {
    const chId = channelIdIn || message?.channel_id;
    if (!chId || !message?.content || typeof message.content !== "string") return;
    if (!hasTableSyntax(message.content)) return;
    logger.log(source + ": table in msg", message.id);

    // Set on raw event data (store copies to new Message for CREATE)
    message.customRenderedContent = {
        content: renderContent(parseContentBlocks(message.content)),
        hasSpoilerEmbeds: false, hasBailedAst: false,
    };

    // Install reactive getter on stored message
    try {
        const stored = MessageStore?.getMessage(chId, message.id);
        if (stored) {
            installGetter(stored);
            logger.log(source + ": getter on stored msg", stored.id);
        }
    } catch (e: any) {
        logger.warn(source + ": getter failed:", e.message);
    }

    // Microtask fallback for CREATE
    queueMicrotask(() => {
        try {
            const stored = MessageStore?.getMessage(chId, message.id);
            if (stored) {
                const desc = Object.getOwnPropertyDescriptor(stored, "customRenderedContent");
                if (!desc) { installGetter(stored); logger.log(source + ": getter via microtask", stored.id); }
            }
        } catch {}
    });
}

// Process all messages in a channel's store (for LOAD_MESSAGES_SUCCESS, CHANNEL_SELECT)
function processChannel(chId: string, source: string) {
    const record = MessageStore?.getMessages?.(chId);
    if (!record || typeof record.toArray !== "function") {
        logger.warn(source + ": MessageStore unavailable");
        return;
    }
    const arr = record.toArray();
    let count = 0;
    for (const msg of arr) {
        if (installGetter(msg)) count++;
    }
    if (count > 0) {
        try {
            MessageStore.emitChange?.();
        } catch (e) {
            logger.warn(source + ": emitChange failed", e);
        }
    }
}

let _origParse: typeof Parser.parse | null = null;

export default definePlugin({
    name: "BetterMarkdown",
    description: "Renders markdown tables inline via customRenderedContent and wraps Parser.parse for table support in MessageLogger and other contexts",
    authors: [{ name: "pnivek", id: 400665810353389568n }],
    tags: ["Chat", "Utility"],

    _unsubs: [] as (() => void)[],

    start() {
        logger.log("start()");

        // Wrap Parser.parse so tables render anywhere Discord's markdown
        // parser is called — MessageLogger edit history, channel topics,
        // and any other context that calls Parser.parse directly.
        // Live messages use the customRenderedContent getter (above),
        // so there's no risk of double-processing.
        _origParse = Parser.parse;
        Parser.parse = function(this: any, content: string, inline: boolean, opts: any) {
            if (typeof content !== "string" || !hasTableSyntax(content)) {
                return _origParse!.call(this, content, inline, opts);
            }
            const blocks = parseContentBlocks(content);
            if (blocks.length === 1 && blocks[0].type === "text") {
                return _origParse!.call(this, content, inline, opts);
            }
            const ch: React.ReactNode[] = [];
            for (const b of blocks) {
                if (b.type === "text") {
                    ch.push(React.createElement(React.Fragment, { key: ch.length },
                        _origParse!.call(this, b.text, inline, opts)));
                } else if (b.type === "table") {
                    ch.push(React.createElement(TableComponent, { key: ch.length, header: b.header, body: b.body }));
                } else {
                    // code_block — pass through to Discord's parser
                    ch.push(React.createElement(React.Fragment, { key: ch.length },
                        _origParse!.call(this, b.content, inline, opts)));
                }
            }
            return React.createElement(React.Fragment, null, ...ch);
        };

        if (!FluxDispatcher) return;
        // Subscribe to Flux events to catch messages across all contexts.
        // MESSAGE_CREATE/UPDATE handle live and edited messages.
        // LOAD_MESSAGES_SUCCESS/CHANNEL_SELECT/CHANNEL_OPEN handle
        // already-loaded messages (scrolling, switching channels, restart).
        this._unsubs = [
            FluxDispatcher.subscribe("MESSAGE_CREATE", (d: any) => handleMsg(d.channelId, d.message, "CREATE")),
            FluxDispatcher.subscribe("MESSAGE_UPDATE", (d: any) => handleMsg(d.channelId, d.message, "UPDATE")),
            FluxDispatcher.subscribe("LOAD_MESSAGES_SUCCESS", (d: any) => {
                if (d.channelId) {
                    queueMicrotask(() => processChannel(d.channelId, "LOAD"));
                }
            }),
            FluxDispatcher.subscribe("CHANNEL_SELECT", (d: any) => {
                if (d.channelId) {
                    queueMicrotask(() => processChannel(d.channelId, "SELECT"));
                }
            }),
            FluxDispatcher.subscribe("CONNECTION_OPEN", () => {
                const chId = SelectedChannelStore?.getChannelId?.();
                if (chId) queueMicrotask(() => processChannel(chId, "CONNECT"));
            }),
        ];
    },

    stop() {
        this._unsubs.forEach(u => u());
        this._unsubs = [];
        // Restore original Parser.parse
        if (_origParse && Parser.parse !== _origParse) {
            Parser.parse = _origParse;
            _origParse = null;
        }
    },
});
