/*
 * BetterMarkdown - Renders markdown tables inline in message content.
 * Wraps _A on module 291812 via Object.defineProperty (getter-only exports).
 */
import { Devs } from "@utils/constants";
import definePlugin from "@utils/types";
import { React } from "@webpack/common";

type ContentBlock =
    | { type: "text"; text: string }
    | { type: "table"; header: string[]; body: string[][] };

const C = { text: "#dbdee1", border: "#3f4147", headerBg: "#1e1f22", rowBg: "#2b2d31", altRowBg: "#313338", wrapBg: "#2b2d31" };

function isTableRow(l: string): boolean { const t = l.trim(); return t.startsWith("|") && t.endsWith("|") && t.length > 2; }
function isSeparator(l: string): boolean { return /^\|[\s\-:|]+\|$/.test(l.trim()); }
function splitCells(l: string): string[] { return l.split("|").slice(1, -1).map(c => c.trim()); }

function hasTableSyntax(c: string): boolean {
    const lines = c.split("\n"); let rc = 0;
    for (const l of lines) { if (isTableRow(l)) { rc++; if (rc >= 2) return true; } if (rc === 1 && isSeparator(l)) return true; }
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
    const h = splitCells(lines[0]), b = lines.slice(si + 1).map(l => splitCells(l));
    if (b.length === 0 || b.some(r => r.length !== h.length)) return null;
    return { header: h, body: b };
}

function Table({ header, body }: { header: string[]; body: string[][] }) {
    return (<div style={{ marginTop: 4, marginBottom: 4, borderRadius: 8, overflow: "hidden", border: "1px solid " + C.border, background: C.wrapBg, color: C.text, maxWidth: "100%" }}>
        <table style={{ borderCollapse: "collapse", width: "100%", fontSize: 13, fontFamily: "var(--font-primary)" }}>
            <thead><tr>{header.map((c, i) => <th key={i} style={{ border: "1px solid " + C.border, padding: "8px 12px", textAlign: "left", fontWeight: 600, background: C.headerBg }}>{c}</th>)}</tr></thead>
            <tbody>{body.map((row, ri) => <tr key={ri}>{row.map((c, ci) => <td key={ci} style={{ border: "1px solid " + C.border, padding: "8px 12px", background: ri % 2 === 0 ? C.rowBg : C.altRowBg }}>{c}</td>)}</tr>)}</tbody>
        </table></div>);
}

function renderContent(blocks: ContentBlock[]): React.ReactNode {
    if (blocks.length === 1 && blocks[0].type === "text") return blocks[0].text;
    const ch: React.ReactNode[] = [];
    for (const b of blocks) {
        if (b.type === "text") ch.push(React.createElement("span", { key: ch.length }, b.text));
        else ch.push(React.createElement(Table, { key: ch.length, header: b.header, body: b.body }));
    }
    return React.createElement(React.Fragment, null, ...ch);
}

export default definePlugin({
    name: "BetterMarkdown",
    description: "Renders markdown tables inline in message content",
    authors: [{ name: "pnivek", id: 400665810353389568n }],
    tags: ["Chat", "Utility"],

    start() {
        console.log("[BM] start()");
        try {
            const m = (Vencord.Webpack.wreq.c as any)[291812]?.exports;
            if (!m?._A) { console.warn("[BM] _A not found"); return; }

            const orig = m._A;
            console.log("[BM] _A:", orig.toString().slice(0, 80));

            // _A is a getter-only property — must use defineProperty
            Object.defineProperty(m, "_A", {
                get() {
                    const wrapped = function(this: any, e: any, t: any) {
                        const raw = e?.content;
                        if (typeof raw === "string" && hasTableSyntax(raw)) {
                            console.log("[BM] table!", e.id);
                            return renderContent(parseContentBlocks(raw));
                        }
                        return orig.call(this, e, t);
                    };
                    return wrapped;
                },
                configurable: true,
            });

            console.log("[BM] _A redefined via defineProperty");
        } catch (ex: any) {
            console.error("[BM] error:", ex.message, ex.stack);
        }
    },

    stop() {
        console.log("[BM] stop()");
    },
});
