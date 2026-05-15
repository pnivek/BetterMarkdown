// Parsing is pure logic — no webpack imports needed

export type ContentBlock =
    | { type: "text"; text: string }
    | { type: "table"; header: string[]; body: string[][]; alignment?: ("left" | "center" | "right" | null)[] }
    | { type: "task_list"; items: { checked: boolean; text: string }[] }
    | { type: "horizontal_rule" }
    | { type: "code_block"; content: string; fence: string };

export type LineToken =
    | { kind: "code_block_fence"; fence: string }
    | { kind: "table_row"; cells: string[]; leading: string; trailing: string }
    | { kind: "task_list_item"; checked: boolean; text: string }
    | { kind: "horizontal_rule" }
    | { kind: "text"; content: string };

const TASK_ITEM_RE = /^(-|\*|\+)\s+\[([ xX])\]\s+(.*)$/;
const HR_RE = /^\s*[-*_](?:\s*[-*_]){2,}\s*$/;

function isSeparatorCells(cells: string[]): boolean {
    return cells.length > 0 && cells.every(c => /^:?-+:?$/.test(c));
}

function getColumnAlignment(cells: string[]): ("left" | "center" | "right" | null)[] {
    return cells.map(c => {
        const t = c.trim();
        const left = t.startsWith(":");
        const right = t.endsWith(":");
        if (left && right) return "center";
        if (left) return "left";
        if (right) return "right";
        return null;
    });
}

function tryParseTaskListItem(raw: string): LineToken | null {
    const line = raw.trim();
    const clean = line.replace(/(`+)[\s\S]*?\1/g, "").replace(/\\\|/g, "");
    const m = clean.match(TASK_ITEM_RE);
    if (!m) return null;
    const checked = m[2] === "x" || m[2] === "X";
    const prefixEnd = m.index! + m[0].length - m[3].length;
    const text = line.slice(prefixEnd).trim();
    return { kind: "task_list_item", checked, text };
}

function tryParseHorizontalRule(raw: string): LineToken | null {
    const line = raw.trim();
    if (HR_RE.test(line)) {
        return { kind: "horizontal_rule" };
    }
    return null;
}

function tryParseTableRow(raw: string): LineToken | null {
    const line = raw.trim();

    let leading = "";
    let cells: string[] = [];
    let cell = "";
    let trailing = "";
    let phase: "leading" | "cells" | "trailing" = "leading";

    let codeDelim: number | null = null;
    let inQuote = false;
    let i = 0;

    while (i < line.length) {
        const ch = line[i];

        if (ch === "`") {
            let count = 1;
            while (i + count < line.length && line[i + count] === "`") count++;

            if (codeDelim === null) {
                codeDelim = count;
            } else if (count === codeDelim) {
                codeDelim = null;
            }

            const chunk = line.slice(i, i + count);
            if (phase === "leading") leading += chunk;
            else if (phase === "cells") cell += chunk;
            else trailing += chunk;

            i += count;
            continue;
        }

        if (codeDelim === null && (ch === '"' || ch === "\u201C" || ch === "\u201D")) {
            inQuote = !inQuote;
        }

        if (ch === '\\' && i + 1 < line.length && line[i + 1] === '|' && codeDelim === null && !inQuote) {
            if (phase === 'leading') leading += '|';
            else if (phase === 'cells') cell += '|';
            else trailing += '|';
            i += 2;
            continue;
        }

        if (ch === "|" && codeDelim === null && !inQuote) {
            if (phase === "leading") {
                leading = leading.trimEnd();
                phase = "cells";
            } else if (phase === "cells") {
                cells.push(cell.trim());
                cell = "";
            } else {
                trailing += ch;
            }
            i++;
            continue;
        }

        if (phase === "leading") leading += ch;
        else if (phase === "cells") cell += ch;
        else trailing += ch;
        i++;
    }

    if (phase === "leading") return null;

    const clean = line.replace(/(`+)[\s\S]*?\1/g, "").replace(/\\\|/g, "");
    const STRUCT_RE = /^(.*?)(\|(?:[^|]+\|)+)(.*)$/;
    const sm = clean.match(STRUCT_RE);
    if (!sm) return null;

    const pipeCount = (sm[2].match(/\|/g) || []).length;
    const structCellCount = Math.max(1, pipeCount - 1);
    const trailingClean = sm[3]?.trim() || "";

    while (cells.length > structCellCount) {
        const extra = cells.pop()!;
        trailing = extra + (trailing ? " " + trailing : "");
    }

    if (trailingClean && !trailing && cell.trim()) {
        trailing = cell.trim();
        cell = "";
    }

    if (cell.trim()) cells.push(cell.trim());

    if (cells.length < 2) return null;
    if (cells.every(c => c === "")) return null;

    return {
        kind: "table_row",
        cells,
        leading: leading.trim(),
        trailing: trailing.trim(),
    };
}

export function tokenize(content: string): LineToken[] {
    const lines = content.split("\n");
    const tokens: LineToken[] = [];
    const state: string[] = [];

    for (const rawLine of lines) {
        const trimmed = rawLine.trim();
        const currentState = state[state.length - 1] ?? null;

        if (trimmed.startsWith("```")) {
            if (currentState === "code_block") {
                state.pop();
            } else {
                state.push("code_block");
            }
            tokens.push({ kind: "code_block_fence", fence: trimmed });
            continue;
        }

        if (currentState === "code_block") {
            tokens.push({ kind: "text", content: rawLine });
            continue;
        }

        const row = tryParseTableRow(rawLine);
        if (row) { tokens.push(row); continue; }
        const task = tryParseTaskListItem(rawLine);
        if (task) { tokens.push(task); continue; }
        const hr = tryParseHorizontalRule(rawLine);
        tokens.push(hr ?? { kind: "text", content: rawLine });
    }

    return tokens;
}

function parse(tokens: LineToken[]): ContentBlock[] {
    const blocks: ContentBlock[] = [];
    let i = 0;

    while (i < tokens.length) {
        const t = tokens[i];

        if (t.kind === "code_block_fence") {
            const fence = t.fence;
            const codeLines: string[] = [t.fence];
            i++;
            while (i < tokens.length && tokens[i].kind !== "code_block_fence") {
                codeLines.push(tokens[i].kind === "text" ? tokens[i].content : "");
                i++;
            }
            if (i < tokens.length) {
                codeLines.push(tokens[i].fence);
                i++;
            }
            blocks.push({ type: "code_block", content: codeLines.join("\n"), fence });
            continue;
        }

        if (t.kind === "table_row") {
            const rows: { kind: "table_row"; cells: string[]; leading: string; trailing: string }[] = [];
            const leadingText: string[] = [];
            const trailingText: string[] = [];

            while (i < tokens.length && tokens[i].kind === "table_row") {
                const tr = tokens[i] as Extract<LineToken, { kind: "table_row" }>;
                rows.push(tr);
                if (tr.leading) leadingText.push(tr.leading);
                if (tr.trailing) trailingText.push(tr.trailing);
                i++;
            }

            if (leadingText.length > 0)
                blocks.push({ type: "text", text: leadingText[0] });

            buildTables(rows, blocks);

            if (trailingText.length > 0)
                blocks.push({ type: "text", text: trailingText.join(" ") });

            continue;
        }

        if (t.kind === "horizontal_rule") {
            blocks.push({ type: "horizontal_rule" });
            i++;
            continue;
        }

        if (t.kind === "task_list_item") {
            const items: { checked: boolean; text: string }[] = [];

            while (i < tokens.length && tokens[i].kind === "task_list_item") {
                const ti = tokens[i] as Extract<LineToken, { kind: "task_list_item" }>;
                items.push({ checked: ti.checked, text: ti.text });
                i++;
            }

            blocks.push({ type: "task_list", items });
            continue;
        }

        const textLines: string[] = [];
        while (i < tokens.length && tokens[i].kind === "text") {
            textLines.push(tokens[i].content);
            i++;
        }
        const joined = textLines.join("\n").trim();
        if (joined) blocks.push({ type: "text", text: joined });
    }

    return blocks;
}

function buildTables(
    rows: { cells: string[]; leading: string; trailing: string }[],
    blocks: ContentBlock[]
): void {
    let start = 0;

    while (start < rows.length) {
        const sepIdx = rows.slice(start).findIndex(r => isSeparatorCells(r.cells));
        const absSep = sepIdx >= 0 ? start + sepIdx : -1;

        if (absSep >= 0 && absSep > start) {
            const header = rows[start].cells;
            const bodyRows = rows.slice(absSep + 1);

            const bodyOk = bodyRows.length === 0 ||
                bodyRows.every(r => r.cells.length === header.length);

            if (bodyOk && header.length >= 1) {
                const alignment = getColumnAlignment(rows[absSep].cells);
                blocks.push({
                    type: "table",
                    header,
                    body: bodyRows.map(r => r.cells),
                    alignment,
                });
                start = absSep + 1 + bodyRows.length;
                continue;
            }
        }

        if (absSep === start) {
            const bodyRows = rows.slice(absSep + 1);
            if (bodyRows.length === 0) { start++; continue; }

            const cellCount = bodyRows[0].cells.length;
            let end = start + 1;
            while (end < rows.length &&
                   rows[end].cells.length === cellCount &&
                   !isSeparatorCells(rows[end].cells)) end++;

            if (cellCount >= 2) {
                const alignment = getColumnAlignment(rows[absSep].cells);
                blocks.push({
                    type: "table",
                    header: [],
                    body: bodyRows.slice(0, end - (start + 1)).map(r => r.cells),
                    alignment,
                });
            }
            start = end;
            continue;
        }

        const cellCount = rows[start].cells.length;
        if (cellCount < 2) {
            blocks.push({ type: "text", text: rows[start].cells.map(c => `| ${c} |`).join(" ") });
            start++;
            continue;
        }

        let end = start + 1;
        while (end < rows.length &&
               rows[end].cells.length === cellCount &&
               !isSeparatorCells(rows[end].cells)) end++;

        blocks.push({
            type: "table",
            header: [],
            body: rows.slice(start, end).map(r => r.cells),
        });
        start = end;
    }
}

export function hasSupportedSyntax(c: string): boolean {
    return tokenize(c).some(t => t.kind === "table_row" || t.kind === "task_list_item" || t.kind === "horizontal_rule");
}

export function parseContentBlocks(c: string): ContentBlock[] {
    return parse(tokenize(c));
}
