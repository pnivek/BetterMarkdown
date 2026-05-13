/*
 * Vencord, a modification for Discord's desktop app
 * Copyright (c) 2025 pnivek
 *
 * BetterMarkdown - Renders markdown tables inline in message content.
 *
 * Two patches, layered for robustness:
 *
 *   1. The useMessageRenderedContent-style hook in the module containing
 *      "customRenderedContent". This hook early-returns
 *        if (null != msg.customRenderedContent) return msg.customRenderedContent
 *      before any markdown processing. Injecting our check right before that
 *      line short-circuits the entire pipeline when we have a table.
 *
 *   2. The _A function in module 291812 ("VOICE_HANGOUT_INVITE"). Verified
 *      runtime source:
 *        function T(e,t){return e.type===d.lAJ.VOICE_HANGOUT_INVITE?"":
 *          e.hasFlag(d.pr7.SOURCE_MESSAGE_DELETED)?p.intl.string(p.t.JOtgSw):t}
 *      This is the final content pass-through. We wrap it so that if the
 *      hook patch didn't fire (different code path, different Discord build,
 *      etc.), we still intercept here.
 *
 * Both patches use \i (single backslash + i) in regex literals. Vencord
 * processes regex.source at build time and converts \i to an identifier
 * matcher. We anchor each match on a unique string from the body (the
 * literal property "customRenderedContent" / "VOICE_HANGOUT_INVITE") so
 * minified variable renaming in the factory does not break us.
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

    // Called from both patch sites. Both pass `message` as first arg; the
    // _A wrapper passes the rendered-content fallback as second arg, which
    // we don't currently use. Returns ReactNode for tables, undefined for
    // everything else (so the host pipeline continues unchanged).
    renderOutput(message: any, _content?: any): any {
        if (!message || typeof message !== "object") return void 0;
        const raw = message.content;
        if (typeof raw !== "string" || !raw) return void 0;
        if (!hasTableSyntax(raw)) return void 0;
        const blocks = parseContentBlocks(raw);
        return renderInlineContent(blocks);
    },

    patches: [
        // ── Patch 1: the customRenderedContent early-return hook ──
        //
        // Matches:   if(null!=X.customRenderedContent)return X.customRenderedContent
        // Becomes:   var __vbm=$self.renderOutput(X);
        //            if(__vbm!==void 0)return __vbm;
        //            if(null!=X.customRenderedContent)return X.customRenderedContent
        //
        // X is captured as \1 so the back-reference inside the same match
        // forces both occurrences to be the same identifier.
        {
            find: "customRenderedContent",
            replacement: {
                match: /if\(null!=(\i)\.customRenderedContent\)return \1\.customRenderedContent/,
                replace: "var __vbm=$self.renderOutput($1);if(__vbm!==void 0)return __vbm;$&",
            },
        },

        // ── Patch 2: the _A function in module 291812 ──
        //
        // Anchored on the unique tail
        //   "function <name?>(<msg>,<content>){return <msg>.type===<ns>.VOICE_HANGOUT_INVITE"
        // so we match regardless of minified function/param names. We capture
        // the namespace chain leading to .VOICE_HANGOUT_INVITE ($4) and splice
        // it back so the original return tail still parses.
        //
        // Capture groups:
        //   $1 = optional " <name>" of the function (may be empty)
        //   $2 = first param identifier (the message)
        //   $3 = second param identifier (the upstream rendered content)
        //   $4 = namespace chain ending in a dot, e.g. "d.lAJ."
        {
            find: "VOICE_HANGOUT_INVITE",
            replacement: {
                match: /function((?:\s+\i)?)\((\i),(\i)\)\{return \2\.type===((?:\i\.)+)VOICE_HANGOUT_INVITE/,
                replace: "function$1($2,$3){var __vbm=$self.renderOutput($2,$3);if(__vbm!==void 0)return __vbm;return $2.type===$4VOICE_HANGOUT_INVITE",
            },
        },
    ],
});
