import { Parser, React } from "@webpack/common";
import { ContentBlock } from "./parsing";

/**
 * Renders a GFM-style table with optional column alignment.
 * Cell contents are run back through Parser.parse for inline markdown (links, lists).
 */
export function TableComponent({
    header,
    body,
    alignment,
}: {
    header: string[];
    body: string[][];
    alignment?: ("left" | "center" | "right" | null)[];
}) {
    const inlineOpts = { allowLinks: true, allowList: true };
    const align = (i: number): string => alignment?.[i] ?? "left";

    const wrapperStyle: React.CSSProperties = {
        marginTop: 4,
        marginBottom: 4,
        overflow: "hidden",
        borderRadius: 4,
        border: "2px solid var(--background-surface-high)",
        background: "var(--background-secondary)",
        color: "var(--text-normal)",
        maxWidth: "90%",
    };

    const tableStyle: React.CSSProperties = {
        borderCollapse: "collapse",
        width: "100%",
        fontSize: 13,
        fontFamily: "var(--font-primary)",
        tableLayout: "fixed",
    };

    const headerCellStyle = (i: number): React.CSSProperties => ({
        border: "2px solid var(--background-surface-high)",
        padding: "8px 12px",
        textAlign: align(i) as any,
        fontWeight: 600,
        background: "var(--background-surface-high)",
    });

    const bodyCellStyle = (i: number): React.CSSProperties => ({
        border: "2px solid var(--background-surface-high)",
        padding: "8px 12px",
        background: "var(--background-base-lowest)",
        textAlign: align(i) as any,
    });

    const colCount = header.length || body[0]?.length || 0;

    return (
        <div style={wrapperStyle}>
            <table style={tableStyle}>
                {colCount > 0 && (
                    <colgroup>
                        {Array.from({ length: colCount - 1 }, (_, i) => (
                            <col key={i} style={{ width: "1%" }} />
                        ))}
                        <col />
                    </colgroup>
                )}
                {header.length > 0 && (
                    <thead>
                        <tr>
                            {header.map((c, i) => (
                                <th key={i} style={headerCellStyle(i)}>
                                    {Parser.parse(c, true, inlineOpts) ?? c}
                                </th>
                            ))}
                        </tr>
                    </thead>
                )}

                {body.length > 0 && (
                    <tbody>
                        {body.map((row, ri) => (
                            <tr key={ri}>
                                {row.map((c, ci) => (
                                    <td key={ci} style={bodyCellStyle(ci)}>
                                        {Parser.parse(c, true, inlineOpts) ?? c}
                                    </td>
                                ))}
                            </tr>
                        ))}
                    </tbody>
                )}
            </table>
        </div>
    );
}

/**
 * Renders a GFM task list — a vertical list of checkbox + label rows.
 * Checked items render with a filled box and strikethrough text.
 */
export function TaskListComponent({ items }: { items: { checked: boolean; text: string }[] }) {
    const inlineOpts = { allowLinks: true, allowList: true };

    const wrapperStyle: React.CSSProperties = {
        marginTop: 4,
        marginBottom: 4,
        background: "var(--background-secondary)",
        borderRadius: 4,
        padding: "4px 0",
        color: "var(--text-normal)",
        fontFamily: "var(--font-primary)",
        fontSize: 13,
        maxWidth: "90%",
    };

    const rowStyle: React.CSSProperties = {
        display: "flex",
        alignItems: "center",
        padding: "4px 12px",
        gap: 8,
    };

    const checkboxStyle = (checked: boolean): React.CSSProperties => ({
        flexShrink: 0,
        width: 18,
        height: 18,
        borderRadius: 3,
        border: checked ? "none" : "2px solid var(--text-muted)",
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        background: checked ? "var(--green-360)" : "transparent",
    });

    const labelStyle = (checked: boolean): React.CSSProperties => ({
        textDecoration: checked ? "line-through" : "none",
        opacity: checked ? 0.6 : 1,
        color: "var(--text-normal)",
    });

    return (
        <div style={wrapperStyle}>
            {items.map((item, i) => (
                <div key={i} style={rowStyle}>
                    <span style={checkboxStyle(item.checked)}>
                        {item.checked ? "✓" : ""}
                    </span>

                    <span style={labelStyle(item.checked)}>
                        {Parser.parse(item.text, true, inlineOpts) ?? item.text}
                    </span>
                </div>
            ))}
        </div>
    );
}

/**
 * Renders a sequence of ContentBlocks as a React tree.
 * `parseFn` overrides the default Parser.parse (used to thread the original
 * implementation through when wrapping Parser.parse).
 * `inline` and `opts` are passed through to the inline parser for text blocks.
 */
export function renderContent(
    blocks: ContentBlock[],
    parseFn?: (text: string, inline: boolean, opts: any) => any,
    inline?: boolean,
    opts?: any,
): React.ReactNode {
    const parse = parseFn ?? Parser.parse;

    // fast path: a single text block — just delegate straight to the parser
    if (blocks.length === 1 && blocks[0].type === "text")
        return parse(
            blocks[0].text,
            inline ?? false,
            opts ?? { allowHeading: true, allowLinks: true, allowList: true, allowEmojiLinks: true },
        );

    const ch: React.ReactNode[] = [];
    for (const b of blocks) {
        if (b.type === "text") {
            ch.push(React.createElement(
                React.Fragment,
                { key: ch.length },
                parse(
                    b.text,
                    inline ?? false,
                    opts ?? { allowHeading: true, allowLinks: true, allowList: true, allowEmojiLinks: true },
                ),
            ));
        } else if (b.type === "table") {
            ch.push(React.createElement(TableComponent, {
                key: ch.length,
                header: b.header,
                body: b.body,
                alignment: (b as any).alignment,
            }));
        } else if (b.type === "horizontal_rule") {
            ch.push(React.createElement("div", {
                key: ch.length,
                style: {
                    height: 0,
                    borderBottom: "2px solid var(--background-surface-high)",
                    margin: "8px 0",
                    maxWidth: "90%",
                },
            }));
        } else if (b.type === "task_list") {
            ch.push(React.createElement(TaskListComponent, {
                key: ch.length,
                items: b.items,
            }));
        } else {
            ch.push(React.createElement(
                React.Fragment,
                { key: ch.length },
                parse(b.content, inline ?? false, opts ?? { allowHeading: true, allowLinks: true, allowList: true, allowEmojiLinks: true }),
            ));
        }
    }
    return React.createElement(React.Fragment, null, ...ch);
}
