/*
 * BetterMarkdown - Renders markdown tables inline by intercepting
 * Flux MESSAGE_CREATE events and setting customRenderedContent.
 * The renderer checks customRenderedContent before any other processing.
 */

import { Devs } from "@utils/constants";
import definePlugin from "@utils/types";
import { FluxDispatcher } from "@webpack/common";
import { findByPropsLazy } from "@webpack";
import { React } from "@webpack/common";

// Lazy resolve the MessageStore — loads after start()
const MessageStore = findByPropsLazy("getMessage", "getMessages");

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
    const lines = c.split("\n");
    let rc = 0;
    for (const l of lines) {
        if (isTableRow(l)) { rc++; if (rc >= 2) return true; }
        if (rc === 1 && isSeparator(l)) return true;
    }
    return false;
}
function parseContentBlocks(c: string): ContentBlock[] {
    const lines = c.split("\n");
    const blocks: ContentBlock[] = [];
    let i = 0;
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
    const h = splitCells(lines[0]);
    const b = lines.slice(si + 1).map(l => splitCells(l));
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

export default definePlugin({
    name: "BetterMarkdown",
    description: "Renders markdown tables inline via customRenderedContent",
    authors: [{ name: "pnivek", id: 400665810353389568n }],
    tags: ["Chat", "Utility"],

    _unsub: null as any,

    start() {
        console.log("[BM] start()");
        try {
            if (!FluxDispatcher) { console.warn("[BM] FluxDispatcher not available"); return; }

            this._unsub = FluxDispatcher.subscribe("MESSAGE_CREATE", (data: any) => {
                try {
                    const { channelId, message } = data;
                    if (!message?.content || typeof message.content !== "string") return;
                    if (!hasTableSyntax(message.content)) return;

                    console.log("[BM] Table msg detected, will set after store processes", message.id);

                    // Set on raw data too (might work for some code paths)
                    message.customRenderedContent = {
                        content: renderContent(parseContentBlocks(message.content)),
                        hasSpoilerEmbeds: false,
                        hasBailedAst: false,
                    };

                    // Run after store processes: set on finalized Message object
                    queueMicrotask(() => {
                        try {
                            const stored = MessageStore?.getMessage(channelId, message.id);
                            if (stored && !stored.customRenderedContent) {
                                stored.customRenderedContent = {
                                    content: renderContent(parseContentBlocks(stored.content)),
                                    hasSpoilerEmbeds: false,
                                    hasBailedAst: false,
                                };
                                console.log("[BM] Set customRenderedContent on stored msg", stored.id);
                            }
                        } catch (e2: any) {
                            console.warn("[BM] microtask:", e2.message);
                        }
                    });
                } catch (e: any) {
                    console.warn("[BM] MESSAGE_CREATE handler:", e.message);
                }
            });

            console.log("[BM] Subscribed to MESSAGE_CREATE");
        } catch (e: any) {
            console.error("[BM] start():", e.message);
        }
    },

    stop() {
        if (this._unsub) this._unsub();
        console.log("[BM] stop()");
    },
});
