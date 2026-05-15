import { Parser, React } from "@webpack/common";
import { ContentBlock } from "./parsing";

export function TableComponent({ header, body, alignment }: { header: string[]; body: string[][]; alignment?: ("left" | "center" | "right" | null)[] }) {
    const inlineOpts = { allowLinks: true, allowList: true };
    const align = (i: number): string => alignment?.[i] ?? "left";
    return (<div style={{ marginTop: 4, marginBottom: 4, overflow: "hidden", borderRadius: 4, border: "2px solid var(--background-surface-high)", background: "var(--background-secondary)", color: "var(--text-normal)", maxWidth: "100%" }}>
        <table style={{ borderCollapse: "collapse", width: "100%", fontSize: 13, fontFamily: "var(--font-primary)" }}>
            {header.length > 0 && <thead><tr>{header.map((c, i) => <th key={i} style={{ border: "2px solid var(--background-surface-high)", padding: "8px 12px", textAlign: align(i) as any, fontWeight: 600, background: "var(--background-surface-high)" }}>{Parser.parse(c, true, inlineOpts) ?? c}</th>)}</tr></thead>}
            {body.length > 0 && <tbody>{body.map((row, ri) => <tr key={ri}>{row.map((c, ci) => <td key={ci} style={{ border: "2px solid var(--background-surface-high)", padding: "8px 12px", background: "var(--background-base-lowest)", textAlign: align(ci) as any }}>{Parser.parse(c, true, inlineOpts) ?? c}</td>)}</tr>)}</tbody>}
        </table></div>);
}

export function TaskListComponent({ items }: { items: { checked: boolean; text: string }[] }) {
    const inlineOpts = { allowLinks: true, allowList: true };
    return (<div style={{ marginTop: 4, marginBottom: 4, background: "var(--background-secondary)", borderRadius: 4, padding: "4px 0", color: "var(--text-normal)", fontFamily: "var(--font-primary)", fontSize: 13 }}>
        {items.map((item, i) => (<div key={i} style={{ display: "flex", alignItems: "center", padding: "4px 12px", gap: 8 }}>
            <span style={{ flexShrink: 0, width: 18, height: 18, borderRadius: 3, border: item.checked ? "none" : "2px solid var(--text-muted)", display: "inline-flex", alignItems: "center", justifyContent: "center", background: item.checked ? "var(--green-360)" : "transparent" }}>
                {item.checked ? "\u2713" : ""}
            </span>
            <span style={{ textDecoration: item.checked ? "line-through" : "none", opacity: item.checked ? 0.6 : 1, color: "var(--text-normal)" }}>
                {Parser.parse(item.text, true, inlineOpts) ?? item.text}
            </span>
        </div>))}
    </div>);
}

export function renderContent(blocks: ContentBlock[]): React.ReactNode {
    const textOpts = { allowHeading: true, allowLinks: true, allowList: true, allowEmojiLinks: true };

    if (blocks.length === 1 && blocks[0].type === "text")
        return Parser.parse(blocks[0].text, false, textOpts);

    const ch: React.ReactNode[] = [];
    for (const b of blocks) {
        if (b.type === "text") {
            ch.push(React.createElement(React.Fragment, { key: ch.length },
                Parser.parse(b.text, false, textOpts)));
        } else if (b.type === "table") {
            ch.push(React.createElement(TableComponent, { key: ch.length, header: b.header, body: b.body, alignment: (b as any).alignment }));
        } else if (b.type === "horizontal_rule") {
            ch.push(React.createElement("div", {
                key: ch.length,
                style: { height: 0, borderBottom: "2px solid var(--background-surface-high)", margin: "8px 0" }
            }));
        } else if (b.type === "task_list") {
            ch.push(React.createElement(TaskListComponent, { key: ch.length, items: b.items }));
        } else {
            ch.push(React.createElement(React.Fragment, { key: ch.length },
                Parser.parse(b.content, false, textOpts)));
        }
    }
    return React.createElement(React.Fragment, null, ...ch);
}
