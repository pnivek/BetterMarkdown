/*
 * Vencord, a modification for Discord's desktop app
 * Copyright (c) 2025 pnivek
 *
 * BetterMarkdown - Renders markdown tables inline in message content.
 *
 * Approach: Directly wraps the _A function (module 291812) at runtime
 * in start(). _A is Discord's content-rendering pass-through:
 *   function T(e,t){return e.type===d.lAJ.VOICE_HANGOUT_INVITE?"":e.hasFlag(d.pr7.SOURCE_MESSAGE_DELETED)?p.intl.string(p.t.JOtgSw):t}
 *
 * We replace _A with a wrapper: checks for table syntax in message.content,
 * returns a React fragment with tables if found, falls through otherwise.
 */

import { Devs } from "@utils/constants";
import definePlugin from "@utils/types";
import { React } from "@webpack/common";

// ─── Types ─────────────────────────────────────────────────────────

type ContentBlock =
    | { type: "text"; text: string }
    | { type: "table"; header: string[]; body: string[][] };

// ─── Colors (Discord dark theme) ──────────────────────────────────

const C = {
    text: "#dbdee1",
    border: "#3f4147",
    headerBg: "#1e1f22",
    rowBg: "#2b2d31",
    altRowBg: "#313338",
    wrapBg: "#2b2d31",
};

// ─── Detection ─────────────────────────────────────────────────────

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
        if (isTableRow(line)) {
            rowCount++;
            if (rowCount >= 2) return true;
        }
        if (rowCount === 1 && isSeparator(line)) return true;
    }
    return false;
}

// ─── Parsing ───────────────────────────────────────────────────────

function parseContentBlocks(content: string): ContentBlock[] {
    const lines = content.split("\n");
    const blocks: ContentBlock[] = [];
    let i = 0;

    while (i < lines.length) {
        if (isTableRow(lines[i])) {
            const tableLines: string[] = [];
            while (i < lines.length && isTableRow(lines[i])) {
                tableLines.push(lines[i].trim());
                i++;
            }
            const parsed = parseSingleTable(tableLines);
            if (parsed) {
                const { header, body } = parsed;
                blocks.push({ type: "table", header, body });
            } else {
                blocks.push({ type: "text", text: tableLines.join("\n") });
            }
        } else {
            const textLines: string[] = [];
            while (i < lines.length && !isTableRow(lines[i])) {
                textLines.push(lines[i]);
                i++;
            }
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

// ─── React Components ──────────────────────────────────────────────

function TableComponent({ header, body }: { header: string[]; body: string[][] }) {
    return (
        <div
            style={{
                marginTop: 4,
                marginBottom: 4,
                borderRadius: 8,
                overflow: "hidden",
                border: `1px solid ${C.border}`,
                background: C.wrapBg,
                color: C.text,
                maxWidth: "100%",
            }}
        >
            <table
                style={{
                    borderCollapse: "collapse",
                    width: "100%",
                    fontSize: 13,
                    fontFamily: "var(--font-primary)",
                }}
            >
                <thead>
                    <tr>
                        {header.map((cell: string, i: number) => (
                            <th
                                key={i}
                                style={{
                                    border: `1px solid ${C.border}`,
                                    padding: "8px 12px",
                                    textAlign: "left",
                                    fontWeight: 600,
                                    background: C.headerBg,
                                }}
                            >
                                {cell}
                            </th>
                        ))}
                    </tr>
                </thead>
                <tbody>
                    {body.map((row: string[], ri: number) => (
                        <tr key={ri}>
                            {row.map((cell: string, ci: number) => (
                                <td
                                    key={ci}
                                    style={{
                                        border: `1px solid ${C.border}`,
                                        padding: "8px 12px",
                                        background: ri % 2 === 0 ? C.rowBg : C.altRowBg,
                                    }}
                                >
                                    {cell}
                                </td>
                            ))}
                        </tr>
                    ))}
                </tbody>
            </table>
        </div>
    );
}

function renderInlineContent(blocks: ContentBlock[]): React.ReactNode {
    if (blocks.length === 1 && blocks[0].type === "text") {
        return blocks[0].text;
    }

    const children: React.ReactNode[] = [];
    for (const block of blocks) {
        if (block.type === "text") {
            children.push(
                React.createElement("span", { key: children.length }, block.text)
            );
        } else {
            children.push(
                React.createElement(TableComponent, {
                    key: children.length,
                    header: block.header,
                    body: block.body,
                })
            );
        }
    }
    return React.createElement(React.Fragment, null, ...children);
}

// ─── Plugin Definition ─────────────────────────────────────────────

export default definePlugin({
    name: "BetterMarkdown",
    description: "Renders markdown tables inline in message content",
    authors: [{ name: "pnivek", id: 400665810353389568n }],
    tags: ["Chat", "Utility"],

    /**
     * We save references to restore on stop()
     */
    _orig: null as (Function | null),

    start() {
        const mod = (Vencord.Webpack.wreq.c as any)[291812]?.exports;
        if (!mod || typeof mod._A !== "function") {
            console.warn("[BetterMarkdown] _A not found (module 291812)");
            return;
        }

        this._orig = mod._A;

        mod._A = (e: any, t: any) => {
            const raw = e?.content;
            if (typeof raw === "string" && hasTableSyntax(raw)) {
                const blocks = parseContentBlocks(raw);
                return renderInlineContent(blocks);
            }
            return this._orig!(e, t);
        };

        console.log("[BetterMarkdown] _A wrapped successfully");
    },

    stop() {
        if (this._orig) {
            const mod = (Vencord.Webpack.wreq.c as any)[291812]?.exports;
            if (mod) mod._A = this._orig;
            this._orig = null;
        }
    },
});
