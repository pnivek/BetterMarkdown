/*
 * BetterMarkdown - Renders markdown tables inline by intercepting
 * Flux MESSAGE_CREATE, MESSAGE_UPDATE, and LOAD_MESSAGES_SUCCESS
 * events to install a reactive getter for customRenderedContent.
 */

import definePlugin from "@utils/types";
import { FluxDispatcher } from "@webpack/common";
import { findByPropsLazy } from "@webpack";
import { React } from "@webpack/common";
import { Logger } from "@utils/Logger";

const logger = new Logger("BetterMarkdown", "#a6d189");

const MessageStore = findByPropsLazy("getMessage", "getMessages");
const SelectedChannelStore = findByPropsLazy("getChannelId");

// Discord's markdown parser - find the module that has a parse function
let _parse: (text: string, inline: boolean, opts: any) => any = (t) => t;
try { const m: any = findByPropsLazy("parse"); if (m?.parse) _parse = (t, i, o) => m.parse(t, i, o); } catch {}
// If none found, _parse remains identity fallback (text won't have markdown rendering)

type ContentBlock =
    | { type: "text"; text: string }
    | { type: "table"; header: string[]; body: string[][] };

// Regex that captures the clean pipe structure and any surrounding content
// Group 1: leading text before the table structure
// Group 2: the clean pipe-delimited structure (starts and ends with |)
// Group 3: trailing text after the table structure
const TABLE_ROW_RE = /^(.*?)(\|(?:[^|]+\|)+)(.*)$/;

function isTableRow(l: string): boolean {
    const t = l.trim();
    if (!TABLE_ROW_RE.test(t)) return false;
    // Pipes inside inline code backticks shouldn't count as table syntax
    return TABLE_ROW_RE.test(t.replace(/`[^`]*`/g, ""));
}
function isSeparator(l: string): boolean {
    const cells = splitCells(l);
    return cells.length > 0 && cells.every(c => /^:?-+:?$/.test(c));
}
function splitCells(l: string): string[] {
    const m = l.trim().match(TABLE_ROW_RE);
    if (!m) return [];
    const struct = m[2];
    // Walk character by character, tracking backtick state
    // so pipes inside inline code aren't treated as cell boundaries
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
    const last = cell.trim();
    if (last) cells.push(last);
    return cells;
}
function hasTableSyntax(c: string): boolean {
    const lines = c.split("\n"); let rc = 0; let inCode = false;
    for (const l of lines) {
        if (l.trim().startsWith("```")) { inCode = !inCode; continue; }
        if (inCode) continue;
        if (isTableRow(l)) rc++;
    }
    return rc > 0; // Any pipe row counts as a table (including partial/single-row tables)
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
                const m = raw.match(TABLE_ROW_RE);
                // Only capture leading text from the first row of the table block
                if (tl.length === 0 && m?.[1]?.trim()) leading.push(m[1].trim());
                tl.push(raw);
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
            }
            else blocks.push({ type: "text", text: tl.join("\n") });
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
    const si = lines.findIndex(l => isSeparator(l));

    if (si >= 0) {
        // Full table: header + separator + body
        const h = splitCells(lines[0]);
        const b = lines.slice(si + 1).map(l => splitCells(l));
        if (h.length < 1) return null;
        if (b.length > 0 && b.some(r => r.length !== h.length)) return null;
        return { header: h, body: b };
    }

    // No separator: all rows are body (partial table continuation)
    const cellCount = splitCells(lines[0]).length;
    if (cellCount < 2) return null;
    const b = lines.map(l => splitCells(l));
    if (b.some(r => r.length !== cellCount)) return null;
    return { header: [], body: b };
}
function TableComponent({ header, body }: { header: string[]; body: string[][] }) {
    return (<div style={{ marginTop: 4, marginBottom: 4, overflow: "hidden", borderRadius: 4, border: "2px solid var(--background-surface-high)", background: "var(--background-secondary)", color: "var(--text-normal)", maxWidth: "100%" }}>
        <table style={{ borderCollapse: "collapse", width: "100%", fontSize: 13, fontFamily: "var(--font-primary)" }}>
            {header.length > 0 && <thead><tr>{header.map((c, i) => <th key={i} style={{ border: "2px solid var(--background-surface-high)", padding: "8px 12px", textAlign: "left", fontWeight: 600, background: "var(--background-surface-high)" }}>{_parse(c, true, {}) ?? c}</th>)}</tr></thead>}
            {body.length > 0 && <tbody>{body.map((row, ri) => <tr key={ri}>{row.map((c, ci) => <td key={ci} style={{ border: "2px solid var(--background-surface-high)", padding: "8px 12px", background: "var(--background-base-lowest)" }}>{_parse(c, true, {}) ?? c}</td>)}</tr>)}</tbody>}
        </table></div>);
}
function renderContent(blocks: ContentBlock[]): React.ReactNode {
    if (blocks.length === 1 && blocks[0].type === "text")
        return _parse(blocks[0].text, false, {});

    const ch: React.ReactNode[] = [];
    for (const b of blocks) {
        if (b.type === "text") {
            ch.push(React.createElement(React.Fragment, { key: ch.length },
                _parse(b.text, false, {})));
        } else {
            ch.push(React.createElement(TableComponent, { key: ch.length, header: b.header, body: b.body }));
        }
    }
    return React.createElement(React.Fragment, null, ...ch);
}

// Install reactive getter on a message so customRenderedContent always
// reflects current content (handles edits + fresh loads automatically).
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

// Handle a message or message batch from any event source
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

export default definePlugin({
    name: "BetterMarkdown",
    description: "Renders markdown tables inline via customRenderedContent",
    authors: [{ name: "pnivek", id: 400665810353389568n }],
    tags: ["Chat", "Utility"],

    _unsubs: [] as any[],

    start() {
        logger.log("start()");
        if (!FluxDispatcher) return;
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
    },
});
