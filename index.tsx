/*
 * Vencord, a modification for Discord's desktop app
 * Copyright (c) 2025 pnivek
 *
 * BetterMarkdown - Renders markdown tables inline in message content,
 * replacing the raw pipe-delimited text with styled HTML tables.
 *
 * Approach: Patches the _A function definition in module 291812.
 * _A is Discord's content-rendering pass-through:
 *   function _A(e,t){
 *     return e.type===VOICE_HANGOUT_INVITE?"":
 *            e.hasFlag(SOURCE_MESSAGE_DELETED)?intl("Deleted"):t
 *   }
 *
 * We wrap it: call $self.renderContent(e,t) first. If it returns
 * undefined (no table detected), fall through to the original logic.
 */

import definePlugin from "@utils/types";
import { Devs } from "@utils/constants";
import { React } from "@webpack/common";

// ─── Types ─────────────────────────────────────────────────────────

type ContentBlock =
    | { type: "text"; text: string }
    | { type: "table"; header: string[]; body: string[][] };

// ─── Colors (hardcoded, Discord dark theme) ──────────────────────

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
    return /^\|[\\s\\-:|]+\|$/.test(line.trim());
}

function splitCells(line: string): string[] {
    return line.split("|").slice(1, -1).map(c => c.trim());
}

/**
 * Quick heuristic: does content contain GFM-style table syntax?
 * Requires at least 2 pipe rows with either a separator or matching columns.
 */
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
        // Pure text - return raw string so Discord renders it normally
        return blocks[0].text;
    }

    // Mixed content: text interspersed with tables
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
    description: "Renders markdown tables inline in message content, replacing raw pipe text with styled tables",
    authors: [{ name: "pnivek", id: 400665810353389568n }],
    tags: ["Chat", "Utility"],

    /**
     * Called by our patched _A wrapper in module 291812.
     *
     * Parameters:
     *   message - the message object (e from _A's signature)
     *   content - the rendered content string (t from _A's signature)
     *
     * Returns undefined if no table content is detected, allowing the
     * original _A logic (voice hangout / deleted / normal) to proceed.
     * Returns a React fragment (table JSX) if table syntax is found.
     */
    renderContent(message: any, content: any): any {
        // Use the raw message content for table detection.
        const raw = message?.content;
        if (typeof raw !== "string" || !raw) return undefined;
        if (!hasTableSyntax(raw)) return undefined;

        const blocks = parseContentBlocks(raw);
        return renderInlineContent(blocks);
    },

    patches: [{
        /**
         * Module 291812 exports the _A content-rendering pass-through.
         * VOICE_HANGOUT_INVITE is unique to this module.
         *
         * Original:
         *   function _A(e,t){return e.type===VOICE_HANGOUT_INVITE?\
         *   "":e.hasFlag(SOURCE_MESSAGE_DELETED)?intl("Deleted"):t}
         *
         * Patched:
         *   function _A(e,t){var _=$self.renderContent(e,t);\
         *   if(_!==void 0)return _;return e.type===VOICE_HANGOUT_INVITE?\
         *   '':e.hasFlag(SOURCE_MESSAGE_DELETED)?intl('Deleted'):t}
         */
        find: "VOICE_HANGOUT_INVITE",

        replacement: {
            match: /function\s+(\w+)\((\w+),(\w+)\)\{return\s*\2\.type===VOICE_HANGOUT_INVITE\?"":\2\.hasFlag\(SOURCE_MESSAGE_DELETED\)\?intl\("Deleted"\):\3\}/,
            replace: "function $1($2,$3){var _=$self.renderContent($2,$3);if(_!==void 0)return _;return $2.type===VOICE_HANGOUT_INVITE?'':$2.hasFlag(SOURCE_MESSAGE_DELETED)?intl('Deleted'):$3}",
        },
    }],
});
