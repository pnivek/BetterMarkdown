/*
 * Vencord, a modification for Discord's desktop app
 * Copyright (c) 2025 pnivek
 *
 * BetterMarkdown - Renders markdown tables with styled HTML tables.
 * Uses addMessageAccessory for reliable rendering.
 */

import { Devs } from "@utils/constants";
import definePlugin, { OptionType } from "@utils/types";
import { React } from "@webpack/common";

// ─── Types ─────────────────────────────────────────────────────────

type ContentBlock =
    | { type: "text"; text: string }
    | { type: "table"; header: string[]; body: string[][] };

// ─── Colors ────────────────────────────────────────────────────────

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

// ─── Plugin Definition ─────────────────────────────────────────────

export default definePlugin({
    name: "BetterMarkdown",
    description: "Renders markdown tables as styled tables below messages",
    authors: [{ name: "pnivek", id: 400665810353389568n }],
    tags: ["Chat", "Utility"],

    addMessageAccessory: "better-markdown",

    renderMessageAccessory(props: any) {
        const { message } = props;
        if (!message?.content) return null;

        const raw = message.content;
        if (typeof raw !== "string" || !raw) return null;
        if (!hasTableSyntax(raw)) return null;

        const blocks = parseContentBlocks(raw);
        const tables = blocks.filter(b => b.type === "table");
        if (tables.length === 0) return null;

        const children = tables.map((table, i) => (
            <TableComponent
                key={i}
                header={(table as any).header}
                body={(table as any).body}
            />
        ));

        return <>{children}</>;
    },
});
