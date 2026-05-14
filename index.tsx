/*
 * BetterMarkdown - Renders markdown tables inline by intercepting
 * Flux MESSAGE_CREATE, MESSAGE_UPDATE, and LOAD_MESSAGES_SUCCESS
 * events to install a reactive getter for customRenderedContent.
 */

import { Devs } from "@utils/constants";
import definePlugin from "@utils/types";
import { FluxDispatcher } from "@webpack/common";
import { findByPropsLazy } from "@webpack";
import { React } from "@webpack/common";

const MessageStore = findByPropsLazy("getMessage", "getMessages");
const SelectedChannelStore = findByPropsLazy("getChannelId");

type ContentBlock =
    | { type: "text"; text: string }
    | { type: "table"; header: string[]; body: string[][] };

function isTableRow(l: string): boolean {
    const t = l.trim();
    return t.startsWith("|") && t.endsWith("|") && t.length > 2;
}
function isSeparator(l: string): boolean {
    return /^\|[\s\-:|]+\|$/.test(l.trim());
}
function splitCells(l: string): string[] {
    return l.split("|").slice(1, -1).map(c => c.trim());
}
function hasTableSyntax(c: string): boolean {
    const lines = c.split("\n"); let rc = 0;
    for (const l of lines) {
        if (isTableRow(l)) { rc++; if (rc >= 2) return true; }
        if (rc === 1 && isSeparator(l)) return true;
    }
    return false;
}
function parseContentBlocks(c: string): ContentBlock[] {
    const lines = c.split("\n"); const blocks: ContentBlock[] = []; let i = 0;
    while (i < lines.length) {
        if (isTableRow(lines[i])) {
            const tl: string[] = [];
            while (i < lines.length && isTableRow(lines[i])) { tl.push(lines[i].trim()); i++; }
            const p = parseSingleTable(tl);
            if (p) blocks.push({ type: "table", header: p.header, body: p.body });
            else blocks.push({ type: "text", text: tl.join("\n") });
        } else {
            const tl: string[] = [];
            while (i < lines.length && !isTableRow(lines[i])) { tl.push(lines[i]); i++; }
            const t = tl.join("\n").trim();
            if (t) blocks.push({ type: "text", text: t });
        }
    }
    return blocks;
}
function parseSingleTable(lines: string[]): { header: string[]; body: string[][] } | null {
    if (lines.length < 2) return null;
    const si = lines.findIndex(l => isSeparator(l));
    if (si <= 0) return null;
    const h = splitCells(lines[0]); const b = lines.slice(si + 1).map(l => splitCells(l));
    if (b.length === 0 || b.some(r => r.length !== h.length)) return null;
    return { header: h, body: b };
}
function TableComponent({ header, body }: { header: string[]; body: string[][] }) {
    return (<div style={{ marginTop: 4, marginBottom: 4, borderRadius: 8, overflow: "hidden", border: "1px solid #3f4147", background: "#2b2d31", color: "#dbdee1", maxWidth: "100%" }}>
        <table style={{ borderCollapse: "collapse", width: "100%", fontSize: 13, fontFamily: "var(--font-primary)" }}>
            <thead><tr>{header.map((c, i) => <th key={i} style={{ border: "1px solid #3f4147", padding: "8px 12px", textAlign: "left", fontWeight: 600, background: "#1e1f22" }}>{c}</th>)}</tr></thead>
            <tbody>{body.map((row, ri) => <tr key={ri}>{row.map((c, ci) => <td key={ci} style={{ border: "1px solid #3f4147", padding: "8px 12px", background: ri % 2 === 0 ? "#2b2d31" : "#313338" }}>{c}</td>)}</tr>)}</tbody>
        </table></div>);
}
function renderContent(blocks: ContentBlock[]): React.ReactNode {
    if (blocks.length === 1 && blocks[0].type === "text") return blocks[0].text;
    const ch: React.ReactNode[] = [];
    for (const b of blocks) {
        if (b.type === "text") ch.push(React.createElement("span", { key: ch.length }, b.text));
        else ch.push(React.createElement(TableComponent, { key: ch.length, header: b.header, body: b.body }));
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
    console.log("[BM] " + source + ": table in msg", message.id);

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
            console.log("[BM] " + source + ": getter on stored msg", stored.id);
        }
    } catch (e: any) {
        console.warn("[BM] " + source + ": getter failed:", e.message);
    }

    // Microtask fallback for CREATE
    queueMicrotask(() => {
        try {
            const stored = MessageStore?.getMessage(chId, message.id);
            if (stored) {
                const desc = Object.getOwnPropertyDescriptor(stored, "customRenderedContent");
                if (!desc) { installGetter(stored); console.log("[BM] " + source + ": getter via microtask", stored.id); }
            }
        } catch {}
    });
}

// Process all messages in a channel's store (for LOAD_MESSAGES_SUCCESS, CHANNEL_SELECT)
function processChannel(chId: string, source: string) {
    console.log("[BM] " + source + ": processChannel called for chId=", chId);
    const record = MessageStore?.getMessages?.(chId);
    console.log("[BM] " + source + ": getMessages returned", !!record, "toArray?", typeof record?.toArray);
    if (!record || typeof record.toArray !== "function") {
        console.log("[BM] " + source + ": bailing - no record or no toArray");
        return;
    }
    const arr = record.toArray();
    let count = 0;
    for (const msg of arr) {
        if (installGetter(msg)) count++;
    }
    console.log("[BM] " + source + ": installed getters on", count, "of", arr.length, "msgs");
    if (count > 0) {
        // Force store to re-emit so React re-renders messages
        try {
            MessageStore.emitChange?.();
            console.log("[BM] " + source + ": emitChange ok");
        } catch (e) {
            console.warn("[BM] " + source + ": emitChange failed", e);
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
        console.log("[BM] start()");
        if (!FluxDispatcher) return;
        this._unsubs = [
            FluxDispatcher.subscribe("MESSAGE_CREATE", (d: any) => handleMsg(d.channelId, d.message, "CREATE")),
            FluxDispatcher.subscribe("MESSAGE_UPDATE", (d: any) => {
                if (d._bm) return; // our own synthetic dispatch to force re-render
                handleMsg(d.channelId, d.message, "UPDATE");
            }),
            // Install getters on all loaded messages when channel opens or scrolls back
            FluxDispatcher.subscribe("LOAD_MESSAGES_SUCCESS", (d: any) => {
                if (d.channelId) {
                    queueMicrotask(() => processChannel(d.channelId, "LOAD"));
                }
            }),
            // Process existing messages when switching to a channel
            FluxDispatcher.subscribe("CHANNEL_SELECT", (d: any) => {
                if (d.channelId) {
                    queueMicrotask(() => processChannel(d.channelId, "SELECT"));
                }
            }),
            // On reconnect or fresh login, process the current channel
            FluxDispatcher.subscribe("CONNECTION_OPEN", () => {
                const chId = SelectedChannelStore?.getChannelId?.();
                console.log("[BM] CONNECT: chId from SelectedChannelStore=", chId);
                if (chId) queueMicrotask(() => processChannel(chId, "CONNECT"));
            }),
        ];
    },

    stop() {
        this._unsubs.forEach(u => u());
        this._unsubs = [];
    },
});
