import definePlugin from "@utils/types";
import { FluxDispatcher, MessageStore, Parser, SelectedChannelStore } from "@webpack/common";
import { Logger } from "@utils/Logger";
import { hasSupportedSyntax, parseContentBlocks } from "./parsing";
import { renderContent } from "./components";

const logger = new Logger("BetterMarkdown", "#a6d189");

/**
 * Installs a reactive `customRenderedContent` getter on a stored Discord message.
 * Re-evaluates each read so edits to `msg.content` show up without refresh.
 * Returns true if the getter was installed, false if the message has no
 * supported syntax (or no content).
 */
function installGetter(msg: any): boolean {
    if (!msg?.content || typeof msg.content !== "string") return false;
    if (!hasSupportedSyntax(msg.content)) return false;
    delete msg.customRenderedContent;
    Object.defineProperty(msg, "customRenderedContent", {
        get() {
            if (!this?.content || typeof this.content !== "string") return void 0;
            if (!hasSupportedSyntax(this.content)) return void 0;
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

/**
 * Handles a MESSAGE_CREATE / MESSAGE_UPDATE event: renders the message's
 * customRenderedContent immediately, then installs a reactive getter on the
 * stored copy (now and on the next microtask, since the store write may race).
 */
function handleMsg(channelIdIn: string, message: any, source: string) {
    const chId = channelIdIn || message?.channel_id;
    if (!chId || !message?.content || typeof message.content !== "string") return;
    if (!hasSupportedSyntax(message.content)) return;
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

/**
 * Walks every message currently stored for a channel and installs the reactive
 * getter on any with supported syntax. Emits a MessageStore change so the
 * affected messages re-render once getters are in place.
 */
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
            if (typeof content !== "string" || !hasSupportedSyntax(content)) {
                return _origParse!.call(this, content, inline, opts);
            }
            const blocks = parseContentBlocks(content);
            return renderContent(blocks, _origParse!.bind(this), inline, opts);
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
        for (const u of this._unsubs) {
            if (typeof u === "function") u();
        }
        this._unsubs = [];
        if (_origParse && Parser.parse !== _origParse) {
            Parser.parse = _origParse;
            _origParse = null;
        }
    },
});
