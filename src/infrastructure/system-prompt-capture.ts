import type { SystemPromptMessage } from "../domain/prompt";
import { MODULE_NAME } from "../constants";

const OMITTED_PROMPT_IDS = new Set(["summary", `${MODULE_NAME}_memory`]);

type PromptPart = { role?: unknown; content?: unknown };
type TextPromptParts = {
    storyString?: unknown;
    mesExmString?: unknown;
    main?: unknown;
    worldInfoBefore?: unknown;
    worldInfoAfter?: unknown;
    description?: unknown;
    personality?: unknown;
    persona?: unknown;
    scenario?: unknown;
    beforeScenarioAnchor?: unknown;
    afterScenarioAnchor?: unknown;
    finalMesSend?: unknown;
};

function getText(value: unknown): string {
    if (typeof value === "string") return value;
    if (!Array.isArray(value)) return "";
    return value.map((part: unknown) => {
        if (typeof part === "string") return part;
        if (typeof part === "object" && part !== null && "text" in part &&
            typeof part.text === "string") return part.text;
        return "";
    }).join("\n");
}

function captureChatSystemMessages(prompt: unknown): SystemPromptMessage[] {
    if (!Array.isArray(prompt)) throw new Error("Could not inspect the active Chat Completion prompt");
    return prompt.flatMap((part: PromptPart) => {
        const content = part?.role === "system" ? getText(part.content).trim() : "";
        return content ? [{ role: "system" as const, content }] : [];
    });
}

function collectPromptManagerMessages(value: unknown): SystemPromptMessage[] {
    if (typeof value !== "object" || value === null) return [];
    const item = value as { identifier?: unknown; collection?: unknown; content?: unknown };
    if (item.identifier === "chatHistory" ||
        (typeof item.identifier === "string" && item.identifier.startsWith("chatHistory-")) ||
        OMITTED_PROMPT_IDS.has(String(item.identifier))) return [];
    if (Array.isArray(item.collection)) {
        return item.collection.flatMap(collectPromptManagerMessages);
    }
    const content = getText(item.content).trim();
    return content ? [{ role: "system", content }] : [];
}

function withoutOmittedSummaries(content: string, omittedTexts: readonly string[]): string {
    let cleaned = content;
    for (const text of omittedTexts) {
        if (!text) continue;
        let index = cleaned.indexOf(text);
        while (index !== -1) {
            const end = index + text.length;
            const startsAtLine = index === 0 || cleaned[index - 1] === "\n";
            const endsAtLine = end === cleaned.length || cleaned[end] === "\n";
            if (startsAtLine && endsAtLine) {
                cleaned = cleaned.slice(0, index) + cleaned.slice(end);
                index = cleaned.indexOf(text, index);
            } else {
                index = cleaned.indexOf(text, end);
            }
        }
    }
    return cleaned.trim();
}

function getOmittedSummaryTexts(): string[] {
    const context = SillyTavern.getContext();
    const texts: string[] = [];
    for (const key of ["1_memory", `${MODULE_NAME}_memory`]) {
        const raw = context.extensionPrompts?.[key]?.value;
        if (typeof raw !== "string" || !raw.trim()) continue;
        texts.push(raw.trim());
        const rendered = context.substituteParams?.(raw)?.trim();
        if (rendered && rendered !== raw.trim()) texts.push(rendered);
    }
    return texts;
}

export function combineChatPromptParts(
    prompt: unknown,
    assembledCollection: unknown,
    presetCollection: unknown,
    omittedTexts: readonly string[] = [],
): SystemPromptMessage[] {
    const system = captureChatSystemMessages(prompt);
    const assembled = collectPromptManagerMessages(assembledCollection);
    const preset = collectPromptManagerMessages(presetCollection);
    const result: SystemPromptMessage[] = [];
    for (const part of [...system, ...assembled, ...preset]) {
        const content = withoutOmittedSummaries(part.content, omittedTexts);
        if (content && !result.some((previous) => previous.content.includes(content))) {
            result.push({ role: "system", content });
        }
    }
    if (!result.length) throw new Error("No active preset or system prompt was found for compaction");
    return result;
}

async function captureChatPromptParts(
    prompt: unknown,
    omittedTexts: readonly string[],
): Promise<SystemPromptMessage[]> {
    if (!Array.isArray(prompt)) throw new Error("Could not inspect the active Chat Completion prompt");
    if (typeof window === "undefined") {
        return captureChatSystemMessages(prompt).flatMap((part) => {
            const content = withoutOmittedSummaries(part.content, omittedTexts);
            return content ? [{ role: "system" as const, content }] : [];
        });
    }
    // The preview contains the rendered system messages. The prompt manager also exposes
    // active preset entries with user/assistant roles, which the API messages cannot identify.
    const coreModuleUrl = "/scripts/openai.js";
    const core = await import(/* webpackIgnore: true */ coreModuleUrl);
    const manager = core.promptManager;
    if (!manager || typeof manager.getPromptCollection !== "function") {
        throw new Error("Could not inspect the active Chat Completion preset");
    }
    return combineChatPromptParts(prompt, manager.messages, manager.getPromptCollection("normal"), omittedTexts);
}

function captureTextSystemMessages(
    parts: TextPromptParts | undefined,
    omittedTexts: readonly string[],
): SystemPromptMessage[] {
    if (!parts) throw new Error("Could not inspect the active Text Completion prompt");
    const content: string[] = [];
    const story = getText(parts.storyString).trim();
    if (story) content.push(story);
    for (const value of [
        parts.main,
        parts.worldInfoBefore,
        parts.worldInfoAfter,
        parts.description,
        parts.personality,
        parts.persona,
        parts.scenario,
        parts.beforeScenarioAnchor,
        parts.afterScenarioAnchor,
        parts.mesExmString,
    ]) {
        const text = getText(value).trim();
        if (text && !story.includes(text)) content.push(text);
    }
    if (Array.isArray(parts.finalMesSend)) {
        for (const message of parts.finalMesSend) {
            if (typeof message !== "object" || message === null ||
                !("extensionPrompts" in message) || !Array.isArray(message.extensionPrompts)) continue;
            for (const prompt of message.extensionPrompts) {
                const text = getText(prompt).trim();
                if (text && !story.includes(text)) content.push(text);
            }
        }
    }
    return content.flatMap((value) => {
        const cleaned = withoutOmittedSummaries(value, omittedTexts);
        return cleaned ? [{ role: "system" as const, content: cleaned }] : [];
    });
}

/** Build the current prompt without sending a model request, then copy its system context. */
export async function captureActiveSystemMessages(signal: AbortSignal): Promise<SystemPromptMessage[]> {
    const context = SillyTavern.getContext();
    const { eventSource, eventTypes } = context;
    let prompt: unknown;
    let textParts: TextPromptParts | undefined;
    let sawPrompt = false;
    const onPrompt = (data: { prompt?: unknown }, dryRun: boolean) => {
        if (!dryRun) return;
        prompt = data?.prompt;
        sawPrompt = true;
    };
    const onTextParts = (data: TextPromptParts) => {
        if (!textParts) textParts = data;
    };
    eventSource.on(eventTypes.GENERATE_AFTER_DATA, onPrompt);
    if (context.mainApi === "textgenerationwebui") {
        eventSource.on(eventTypes.GENERATE_BEFORE_COMBINE_PROMPTS, onTextParts);
    }
    try {
        signal.throwIfAborted();
        await context.generate("normal", { signal }, true);
        signal.throwIfAborted();
        if (!sawPrompt) throw new Error("SillyTavern did not finish assembling the active prompt");
        const omittedTexts = getOmittedSummaryTexts();
        return context.mainApi === "openai"
            ? await captureChatPromptParts(prompt, omittedTexts)
            : captureTextSystemMessages(textParts, omittedTexts);
    } finally {
        eventSource.removeListener(eventTypes.GENERATE_AFTER_DATA, onPrompt);
        if (context.mainApi === "textgenerationwebui") {
            eventSource.removeListener(eventTypes.GENERATE_BEFORE_COMBINE_PROMPTS, onTextParts);
        }
    }
}
