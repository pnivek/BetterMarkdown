import definePlugin from "@utils/types";
import { FluxDispatcher, MessageStore, Parser, React, SelectedChannelStore } from "@webpack/common";
import { Logger } from "@utils/Logger";
import { needsInterception, parseContentBlocks } from "./parsing";
import { renderContent, TableComponent, TaskListComponent } from "./components";

const logger = new Logger("BetterMarkdown", "#a6d189");

function installGetter(msg: any): boolean {
    if (!msg?.content || typeof msg.content !== "string") return false;
    if (!needsInterception(msg.content)) return false;
    delete msg.customRenderedContent;
    Object.defineProperty(msg, "customRenderedContent", {
        get() {
            if (!this?.content || typeof this.content !== "string") return void 0;
            if (!needsInterception(this.content)) return void 0;
            return {
                content: renderContent(parseContentBlocks(this.content)),
                hasSpoilerEmbeds: false,
                hasBailedAst: false,
            };
        },
        configurable: true,
        enumerable: false,
    });
    return true;
}

function handleMsg(channelIdIn: string, message: any, source: string) {
    const chId = channelIdIn || message?.channel_id;
    if (!chId || !message?.content || typeof message.content !== "string") return;
    if (!needsInterception(message.content)) return;
    logger.log(source + ": table in msg", message.id);

    message.customRenderedContent = {
        content: renderContent(parseContentBlocks(message.content)),
        hasSpoilerEmbeds: false, hasBailedAst: false,
    };

    try {
        const stored = MessageStore?.getMessage(chId, message.id);
        if (stored) {
            installGetter(stored);
            logger.log(source + ": getter on stored msg", stored.id);
        }
    } catch (e: any) {
        logger.warn(source + ": getter failed:", e.message);
    }

    queueMicrotask(() => {
        try {
            const stored = MessageStore?.getMessage(chId, message.id);
            if (stored) {
                const desc = Object.getOwnPropertyDescriptor(stored, "customRenderedContent");
                if (!desc) { installGetter(stored); logger.log(source + ": getter via microtask", stored.id); }
            }
        } catch {}
    });
}

function processChannel(chId: string, source: string) {
    const record = MessageStore?.getMessages?.(chId);
    if (!record || typeof record.toArray !== "function") {
        logger.warn(source + ": MessageStore unavailable");
        return;
    }
    const arr = record.toArray();
    let count = 0;
    for (const msg of arr) {
        if (installGetter(msg)) count++;
    }
    if (count > 0) {
        try {
            MessageStore.emitChange?.();
        } catch (e) {
            logger.warn(source + ": emitChange failed", e);
        }
    }
}

let _origParse: typeof Parser.parse | null = null;

export default definePlugin({
    name: "BetterMarkdown",
    description: "Renders GFM tables, task lists, and horizontal rules inline via customRenderedContent and wraps Parser.parse for support across MessageLogger, edit history, and other contexts",
    authors: [{ name: "pnivek", id: 400665810353389568n }],
    tags: ["Chat", "Utility"],

    _unsubs: [] as (() => void)[],

    start() {
        logger.log("start()");

        _origParse = Parser.parse;
        Parser.parse = function(this: any, content: string, inline: boolean, opts: any) {
            if (typeof content !== "string" || !needsInterception(content)) {
                return _origParse!.call(this, content, inline, opts);
            }
            const blocks = parseContentBlocks(content);
            if (blocks.length === 1 && blocks[0].type === "text") {
                return _origParse!.call(this, content, inline, opts);
            }
            const ch: React.ReactNode[] = [];
            for (const b of blocks) {
                if (b.type === "text") {
                    ch.push(React.createElement(React.Fragment, { key: ch.length },
                        _origParse!.call(this, b.text, inline, opts)));
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
                        _origParse!.call(this, b.content, inline, opts)));
                }
            }
            return React.createElement(React.Fragment, null, ...ch);
        };

        if (!FluxDispatcher) return;
        this._unsubs = [
            FluxDispatcher.subscribe("MESSAGE_CREATE", (d: any) => handleMsg(d.channelId, d.message, "CREATE")),
            FluxDispatcher.subscribe("MESSAGE_UPDATE", (d: any) => handleMsg(d.channelId, d.message, "UPDATE")),
            FluxDispatcher.subscribe("LOAD_MESSAGES_SUCCESS", (d: any) => {
                if (d.channelId) {
                    queueMicrotask(() => processChannel(d.channelId, "LOAD"));
                }
            }),
            FluxDispatcher.subscribe("CHANNEL_SELECT", (d: any) => {
                if (d.channelId) {
                    queueMicrotask(() => processChannel(d.channelId, "SELECT"));
                }
            }),
            FluxDispatcher.subscribe("CONNECTION_OPEN", () => {
                const chId = SelectedChannelStore?.getChannelId?.();
                if (chId) queueMicrotask(() => processChannel(chId, "CONNECT"));
            }),
        ];
    },

    stop() {
        this._unsubs.forEach(u => u());
        this._unsubs = [];
        if (_origParse && Parser.parse !== _origParse) {
            Parser.parse = _origParse;
            _origParse = null;
        }
    },
});
