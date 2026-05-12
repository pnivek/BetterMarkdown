/*
 * Vencord, a modification for Discord's desktop app
 * Copyright (c) 2025 pnivek
 */

import {
    addMessageAccessory,
    removeMessageAccessory,
} from "@api/MessageAccessories";
import definePlugin from "@utils/types";
import { Channel, Message } from "discord-types/general";
import { React } from "@webpack/common";

// ─── Types ─────────────────────────────────────────────────────────

type AccessoryProps = {
    message: Message;
    channel: Channel;
    [key: string]: any;
};

type TableBlock =
    | { kind: "complete"; header: string[]; body: string[][] }
    | { kind: "partial"; body: string[][] };

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
    const parts = line.split("|").slice(1, -1);
    return parts.map(c => c.trim());
}

// ─── Single-message parser (no cross-message chain logic) ──────────

function extractTables(content: string): TableBlock[] {
    const lines = content.split("\n");
    const blocks: TableBlock[] = [];
    let i = 0;

    while (i < lines.length) {
        // Find next table block start
        while (i < lines.length && !isTableRow(lines[i])) i++;
        if (i >= lines.length) break;

        // Collect contiguous table lines
        const raw: string[] = [];
        while (i < lines.length && isTableRow(lines[i])) {
            raw.push(lines[i].trim());
            i++;
        }
        if (raw.length < 2) continue;

        // Try parsing as complete table
        const sepIdx = raw.findIndex(l => isSeparator(l));

        if (sepIdx > 0) {
            const header = splitCells(raw[0]);
            const bodyLines = raw.slice(sepIdx + 1);
            const body = bodyLines.map(l => splitCells(l));
            if (body.length > 0 && body.every(r => r.length === header.length)) {
                blocks.push({ kind: "complete", header, body });
                continue;
            }
        }

        // Couldn't parse as complete table — render as partial
        const body = raw.map(l => splitCells(l));
        if (body.length > 0) {
            blocks.push({ kind: "partial", body });
        }
    }

    return blocks;
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

function PartialTable({ body }: { body: string[][] }) {
    return (
        <div
            style={{
                marginTop: 4,
                marginBottom: 4,
                borderRadius: 8,
                overflow: "hidden",
                border: "1px dashed var(--background-modifier-accent, #3f4147)",
                borderTop: "2px dashed rgba(219,222,225,0.3)",
                background: C.wrapBg,
                color: C.text,
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
                                        color: C.text,
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

function TablesAccordion({ blocks }: { blocks: TableBlock[] }) {
    if (blocks.length === 0) return null;
    return (
        <div style={{ marginTop: 2 }}>
            {blocks.map((block, i) =>
                block.kind === "complete"
                    ? <TableComponent key={i} header={block.header} body={block.body} />
                    : <PartialTable key={i} body={block.body} />
            )}
        </div>
    );
}

// ─── Plugin Definition ─────────────────────────────────────────────

export default definePlugin({
    name: "BetterMarkdown",
    description: "Renders markdown tables as styled HTML. Handles split tables via partial rendering.",
    authors: [{ name: "pnivek", id: 400665810353389568n }],
    tags: ["Chat", "Utility"],

    start() {
        addMessageAccessory("better-markdown", (props: AccessoryProps) => {
            const { message } = props;
            if (!message?.content) return null;

            const blocks = extractTables(message.content);
            if (blocks.length === 0) return null;

            return <TablesAccordion blocks={blocks} />;
        });
    },

    stop() {
        removeMessageAccessory("better-markdown");
    },
});
