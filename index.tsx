/*
 * Vencord, a modification for Discord's desktop app
 * Copyright (c) 2025 pnivek
 *
 * BetterMarkdown - Renders markdown tables inline in message content.
 * Direct wrapping of module 291812 exports with full logging.
 */

import { Devs } from "@utils/constants";
import definePlugin from "@utils/types";
import { React } from "@webpack/common";

type ContentBlock =
    | { type: "text"; text: string }
    | { type: "table"; header: string[]; body: string[][] };

const C = {
    text: "#dbdee1", border: "#3f4147", headerBg: "#1e1f22",
    rowBg: "#2b2d31", altRowBg: "#313338", wrapBg: "#2b2d31",
};

function isTableRow(line: string): boolean {
    const t = line.trim();
    return t.startsWith("|") && t.endsWith("|") && t.length > 2;
}
function isSeparator(line: string): boolean {
    return /^\|[\s\-:|]+\|$/.test(line.trim());
}
function splitCells(line: string): string[] {
    return line.split("|").slice(1, -1).map(c => c.trim());
}
function hasTableSyntax(content: string): boolean {
    const lines = content.split("\n");
    let rowCount = 0;
    for (const line of lines) {
        if (isTableRow(line)) { rowCount++; if (rowCount >= 2) return true; }
        if (rowCount === 1 && isSeparator(line)) return true;
    }
    return false;
}
function parseContentBlocks(content: string): ContentBlock[] {
    const lines = content.split("\n");
    const blocks: ContentBlock[] = [];
    let i = 0;
    while (i < lines.length) {
        if (isTableRow(lines[i])) {
            const tableLines: string[] = [];
            while (i < lines.length && isTableRow(lines[i])) { tableLines.push(lines[i].trim()); i++; }
            const parsed = parseSingleTable(tableLines);
            if (parsed) { blocks.push({ type: "table", header: parsed.header, body: parsed.body }); }
            else { blocks.push({ type: "text", text: tableLines.join("\n") }); }
        } else {
            const textLines: string[] = [];
            while (i < lines.length && !isTableRow(lines[i])) { textLines.push(lines[i]); i++; }
            const text = textLines.join("\n").trim();
            if (text) blocks.push({ type: "text", text });
        }
    }
    return blocks;
}
function parseSingleTable(lines: string[]): { header: string[]; body: string[][] } | null {
    if (lines.length < 2) return null;
    const sepIdx = lines.findIndex(l => isSeparator(l));
    if (sepIdx <= 0) return null;
    const header = splitCells(lines[0]);
    const body = lines.slice(sepIdx + 1).map(l => splitCells(l));
    if (body.length === 0) return null;
    if (body.some(row => row.length !== header.length)) return null;
    return { header, body };
}
function TableComponent({ header, body }: { header: string[]; body: string[][] }) {
    return <div style={{ marginTop: 4, marginBottom: 4, borderRadius: 8, overflow: "hidden", border: "1px solid #3f4147", background: "#2b2d31", color: "#dbdee1", maxWidth: "100%" }}>
        <table style={{ borderCollapse: "collapse", width: "100%", fontSize: 13, fontFamily: "var(--font-primary)" }}>
            <thead><tr>{header.map((c, i) => <th key={i} style={{ border: "1px solid #3f4147", padding: "8px 12px", textAlign: "left", fontWeight: 600, background: "#1e1f22" }}>{c}</th>)}</tr></thead>
            <tbody>{body.map((row, ri) => <tr key={ri}>{row.map((c, ci) => <td key={ci} style={{ border: "1px solid #3f4147", padding: "8px 12px", background: ri % 2 === 0 ? "#2b2d31" : "#313338" }}>{c}</td>)}</tr>)}</tbody>
        </table>
    </div>;
}
function renderInlineContent(blocks: ContentBlock[]): React.ReactNode {
    if (blocks.length === 1 && blocks[0].type === "text") return blocks[0].text;
    const children: React.ReactNode[] = [];
    for (const block of blocks) {
        if (block.type === "text") children.push(React.createElement("span", { key: children.length }, block.text));
        else children.push(React.createElement(TableComponent, { key: children.length, header: block.header, body: block.body }));
    }
    return React.createElement(React.Fragment, null, ...children);
}

export default definePlugin({
    name: "BetterMarkdown",
    description: "Renders markdown tables inline in message content",
    authors: [{ name: "pnivek", id: 400665810353389568n }],
    tags: ["Chat", "Utility"],

    start() {
        console.log("[BetterMarkdown] start()");
        try {
            const cache = (Vencord.Webpack.wreq.c as any);
            const rawMod = cache[291812];
            console.log("[BetterMarkdown] rawMod:", !!rawMod, typeof rawMod);
            if (!rawMod) { console.warn("[BetterMarkdown] mod 291812 not in cache"); return; }
            const exps = rawMod.exports || rawMod;
            console.log("[BetterMarkdown] exports:", typeof exps, Object.keys(exps).join(","));
            if (typeof exps._A !== "function") { console.warn("[BetterMarkdown] _A not a function"); return; }

            const orig = exps._A;
            console.log("[BetterMarkdown] orig _A:", orig.toString().slice(0, 100));

            exps._A = function (e: any, t: any) {
                try {
                    const raw = e?.content;
                    if (typeof raw === "string" && raw.length > 0 && hasTableSyntax(raw)) {
                        console.log("[BetterMarkdown] table detected in msg", e.id);
                        return renderInlineContent(parseContentBlocks(raw));
                    }
                } catch (ex: any) {
                    console.warn("[BetterMarkdown] wrapper error:", ex.message);
                }
                return orig.call(this, e, t);
            };
            console.log("[BetterMarkdown] _A wrapped successfully");
        } catch (ex: any) {
            console.error("[BetterMarkdown] start error:", ex.message, ex.stack);
        }
    },

    stop() {
        console.log("[BetterMarkdown] stop()");
    },
});
