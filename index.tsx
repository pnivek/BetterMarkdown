/*
 * BetterMarkdown — Renders GFM-style markdown tables inline in Discord messages.
 *
 * Architecture (two interception points):
 * 1. Flux event interception — Listens for MESSAGE_CREATE, MESSAGE_UPDATE,
 *    LOAD_MESSAGES_SUCCESS, CHANNEL_SELECT, and CONNECTION_OPEN to install a
 *    reactive getter for customRenderedContent on messages with table syntax.
 * 2. Parser.parse wrapper — Intercepts all calls to Discord's markdown parser
 *    so tables also render in MessageLogger edit history and any other context
 *    that calls Parser.parse directly.
 *
 * Parsing strategy:
 * - Single-pass content block parser (parseContentBlocks) splits a message into
 *   alternating text and table blocks by scanning lines.
 * - Table rows are detected via regex that captures the clean pipe structure
 *   (groups 1/2/3: leading text, pipe structure, trailing text).
 * - Inline code awareness: pipes inside backtick-delimited spans are excluded
 *   from table detection via code-stripped regex testing.
 * - Salvage fallback: when column counts don't match across a table run, the
 *   salvage path re-slices the lines and tries to parse header lines as a
 *   body-only table, then separator+body as another body-only table.
 * - Column consistency is enforced: mismatched rows produce separate tables.
 *
 * TODO (future): Replace salvage fallback with a two-pass lexer + parser
 * architecture (tokenize once, parse blocks once — no re-slicing).
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
    | { type: "table"; header: string[]; body: string[][] };

// TABLE_ROW_RE captures three groups from a line containing a pipe-delimited structure:
//   [1] Leading text before the first | (may be empty)
//   [2] The clean pipe-delimited structure — from the first | to the last |  
//   [3] Trailing text after the last | (pagination markers, comments, etc.)
//
// Example: "some text | a | b | c | (1/2)"
//   [1] = "some text "
//   [2] = "| a | b | c |"
//   [3] = " (1/2)"
const TABLE_ROW_RE = /^(.*?)(\|(?:[^|]+\|)+)(.*)$/;

function isTableRow(l: string): boolean {
    const t = l.trim();
    if (!TABLE_ROW_RE.test(t)) return false;
    // Strip all inline code (paired backtick groups like ``, ``, `````) before
    // testing the regex. This prevents false positives where all visible pipes
    // are inside backtick-delimited code spans (e.g., `` `| code |` ``).
    return TABLE_ROW_RE.test(t.replace(/(`+)[\s\S]*?\1/g, ""));
}
function isSeparator(l: string): boolean {
    const cells = splitCells(l);
    return cells.length > 0 && cells.every(c => /^:?-+:?$/.test(c));
}
function splitCells(l: string): string[] {
    // Strip inline code before regex match — prevents the first | inside
    // backticks from being mistaken for the start of the table structure.
    // Since we operate on the already-stripped struct (group [2]), a simple
    // backtick toggle is sufficient — any remaining backticks are single
    // characters inside cell content, not real code delimiters.
    const clean = l.trim().replace(/(`+)[\s\S]*?\1/g, "");
    const m = clean.match(TABLE_ROW_RE);
    if (!m) return [];
    const struct = m[2];
    // Walk the struct character by character, tracking backtick state
    // so pipes inside inline code aren't treated as cell boundaries.
    // Skip index 0 (the leading |) since we only care about content.
    const cells: string[] = [];
    let cell = "";
    let inCode = false;
    for (let i = 0; i < struct.length; i++) {
        const ch = struct[i];
        if (ch === "`") {
            inCode = !inCode;
            if (i > 0) cell += ch;
        } else if (ch === "|" && !inCode && i > 0) {
            cells.push(cell.trim());
            cell = "";
        } else if (i > 0) {
            cell += ch;
        }
    }
    return cells;
}
function hasTableSyntax(c: string): boolean {
    const lines = c.split("\n"); let inCode = false;
    for (const l of lines) {
        if (l.trim().startsWith("```")) { inCode = !inCode; continue; }
        if (inCode) continue;
        if (isTableRow(l)) return true;
    }
    return false;
}
function parseContentBlocks(c: string): ContentBlock[] {
    const lines = c.split("\n"); const blocks: ContentBlock[] = []; let i = 0;
    while (i < lines.length) {
        // Code blocks: collect everything until closing ``` as one text block
        if (lines[i].trim().startsWith("```")) {
            const codeLines: string[] = [lines[i]];
            i++;
            while (i < lines.length && !lines[i].trim().startsWith("```")) { codeLines.push(lines[i]); i++; }
            if (i < lines.length) { codeLines.push(lines[i]); i++; }
            blocks.push({ type: "text", text: codeLines.join("\n") });
            continue;
        }
        if (isTableRow(lines[i])) {
            const tl: string[] = [];
            const leading: string[] = [];
            const trailing: string[] = [];
            while (i < lines.length && isTableRow(lines[i])) {
                const raw = lines[i].trim();
                // Extract leading text from the ORIGINAL line (before code stripping)
                // by walking characters with backtick delimiter-pair matching.
                // This preserves inline code content like `` ``| code |`` `` in leading
                // text, while still recognizing pipes outside of code as the boundary.
                // We only capture leading text from the first row of a table block —
                // subsequent rows within the same table don't have independent leading text.
                let lead = "";
                if (tl.length === 0) {
                    let inCode = false;
                    let codeDelim = 0;
                    for (let j = 0; j < raw.length; j++) {
                        const ch = raw[j];
                        if (ch === "`") {
                            let count = 1;
                            while (j + count < raw.length && raw[j + count] === "`") count++;
                            if (!inCode) {
                                inCode = true;
                                codeDelim = count;
                            } else if (count === codeDelim) {
                                inCode = false;
                                codeDelim = 0;
                            }
                            for (let k = 0; k < count; k++) lead += "`";
                            j += count - 1;
                        } else if (ch === "|" && !inCode) {
                            lead = lead.trimEnd();
                            break;
                        } else {
                            lead += ch;
                        }
                    }
                }
                if (lead.trim()) leading.push(lead.trim());
                tl.push(raw);
                // Trailing text via regex on code-stripped line
                const clean = raw.replace(/(`+)[\s\S]*?\1/g, "");
                const m = clean.match(TABLE_ROW_RE);
                if (m?.[3]?.trim()) trailing.push(m[3].trim());
                i++;
            }
            const p = parseSingleTable(tl);
            if (p) {
                if (leading.length > 0)
                    blocks.push({ type: "text", text: leading.join(" ") });
                blocks.push({ type: "table", header: p.header, body: p.body });
                if (trailing.length > 0)
                    blocks.push({ type: "text", text: trailing.join(" ") });
            } else {
                // Salvage: parseSingleTable returned null — column counts don't match.
                // This happens when consecutive table-like lines have different column counts
                // (e.g., a 2-cell header above a 4-cell body). Try to recover by:
                //   1. Pushing any accumulated leading text
                //   2. Parsing header lines before the separator as a body-only table
                //   3. Parsing separator+body as another body-only table
                //
                // Example: "| a | real | table |"  (2 cells)
                //          "|---|---|---|---|"      (4-cell sep — mismatch!)
                //          "| works | fine | ✅ | test |" (4 cells)
                // Produces: 2-column body table + 4-column body table
                const salSep = tl.findIndex(l => isSeparator(l));
                if (salSep >= 0) {
                    if (leading.length > 0)
                        blocks.push({ type: "text", text: leading.join(" ") });
                    if (salSep > 0) {
                        const hp = parseSingleTable(tl.slice(0, salSep));
                        if (hp) blocks.push({ type: "table", header: hp.header, body: hp.body });
                        else blocks.push({ type: "text", text: tl.slice(0, salSep).join("\n") });
                    }
                    const bp = parseSingleTable(tl.slice(salSep));
                    if (bp) {
                        blocks.push({ type: "table", header: bp.header, body: bp.body });
                        if (trailing.length > 0)
                            blocks.push({ type: "text", text: trailing.join(" ") });
                        continue;
                    }
                }
                blocks.push({ type: "text", text: tl.join("\n") });
            }
        } else {
            const tl: string[] = [];
            while (i < lines.length && !isTableRow(lines[i]) && !lines[i].trim().startsWith("```")) { tl.push(lines[i]); i++; }
            const t = tl.join("\n").trim();
            if (t) blocks.push({ type: "text", text: t });
        }
    }
    return blocks;
}
function parseSingleTable(lines: string[]): { header: string[]; body: string[][] } | null {
    if (lines.length < 1) return null;
    const sepIdx = lines.findIndex(l => isSeparator(l));

    if (sepIdx >= 0) {
        if (sepIdx === 0) {
            // Case 1: Separator-first (no header row). All subsequent lines are body.
            // Example: "|---|---|---|\n| a | b | c |"
            const b = lines.slice(1).map(l => splitCells(l));
            if (b.length === 0) return null;
            const cellCount = b[0].length;
            if (cellCount < 2 || b.some(r => r.length !== cellCount)) return null;
            return { header: [], body: b };
        }
        // Case 2: Full table with header + separator + body.
        // Example: "| A | B |\n|---|---|\n| 1 | 2 |"
        const h = splitCells(lines[0]);
        const b = lines.slice(sepIdx + 1).map(l => splitCells(l));
        if (h.length < 1) return null;
        if (b.length > 0 && b.some(r => r.length !== h.length)) return null;
        return { header: h, body: b };
    }

    // Case 3: No separator — all rows are body (partial table / continuation).
    // Example: "| 1 | 2 |\n| 3 | 4 |"
    const cellCount = splitCells(lines[0]).length;
    if (cellCount < 2) return null;
    const b = lines.map(l => splitCells(l));
    if (b.some(r => r.length !== cellCount)) return null;
    return { header: [], body: b };
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
        } else {
            ch.push(React.createElement(TableComponent, { key: ch.length, header: b.header, body: b.body }));
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
                } else {
                    ch.push(React.createElement(TableComponent, { key: ch.length, header: b.header, body: b.body }));
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
