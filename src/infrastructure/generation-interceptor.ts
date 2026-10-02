import { EXTENSION_ID, MODULE_NAME } from "../constants";
import {
    cancelCompactions,
    getGenerationMemoryState,
    isAfterReplyTriggerReached,
    scheduleAfterReplyCompaction,
    type GenerationMessage,
    type ObservedContextUsage,
} from "../application/compaction-coordinator";
import { formatMemoryForGeneration } from "../domain/prompt";
import { translate } from "../i18n";
import { getSettings } from "./settings-store";
import {
    blockSendingDuringCompaction,
    waitForCompactionSendUnlock,
} from "./compaction-send-lock";

const MEMORY_PROMPT_KEY = `${MODULE_NAME}_memory`;
const PROMPT_POSITION_NONE = -1;
const PROMPT_POSITION_IN_CHAT = 1;
const PROMPT_ROLE_SYSTEM = 0;
const SUPPORTED_TYPES = new Set(["normal", "regenerate", "swipe", "continue"]);
const completedUsages = new WeakMap<ChatMetadata, ObservedContextUsage>();
const completedUsageTasks = new WeakMap<ChatMetadata, Promise<void>>();
const missingUsageWarnings = new WeakSet<ChatMetadata>();
const GENERATION_ENDPOINTS = [
    "/api/backends/chat-completions/generate",
    "/api/backends/text-completions/generate",
];

interface GenerationRound {
    chatId: string;
    metadata: ChatMetadata;
    requestCount: number;
    contextSize?: number;
    requestIssued: boolean;
    awaitingResponse: boolean;
    usagePromise?: Promise<ApiTokenUsage | undefined>;
    promptText?: string;
    receivedMessageId?: number;
    ended: boolean;
}

let currentRound: GenerationRound | undefined;
let releaseSendLock: (() => void) | undefined;

interface ApiTokenUsage {
    promptTokens?: number;
    completionTokens?: number;
    totalTokens?: number;
}

function getApiTokenUsage(value: unknown): ApiTokenUsage | undefined {
    if (typeof value !== "object" || value === null || !("usage" in value)) return undefined;
    const usage = value.usage;
    if (typeof usage !== "object" || usage === null) return undefined;
    const readTokens = (key: string): number | undefined => {
        const raw = (usage as Record<string, unknown>)[key];
        return typeof raw === "number" && Number.isSafeInteger(raw) && raw >= 0
            ? raw
            : undefined;
    };
    const promptTokens = readTokens("prompt_tokens");
    const completionTokens = readTokens("completion_tokens");
    const totalTokens = readTokens("total_tokens");
    return promptTokens === undefined && completionTokens === undefined && totalTokens === undefined
        ? undefined
        : { promptTokens, completionTokens, totalTokens };
}

async function readStreamingTokenUsage(response: Response): Promise<ApiTokenUsage | undefined> {
    const reader = response.body?.getReader();
    if (!reader) return undefined;
    const decoder = new TextDecoder();
    let buffer = "";
    let found: ApiTokenUsage | undefined;
    const recordUsage = (data: string): void => {
        const next = getApiTokenUsage(JSON.parse(data));
        if (!next) return;
        found = {
            promptTokens: next.promptTokens ?? found?.promptTokens,
            completionTokens: next.completionTokens ?? found?.completionTokens,
            totalTokens: next.totalTokens ?? found?.totalTokens,
        };
    };
    try {
        while (true) {
            const { done, value } = await reader.read();
            buffer += decoder.decode(value, { stream: !done });
            const events = buffer.split(/\r?\n\r?\n/);
            buffer = events.pop() ?? "";
            for (const event of events) {
                const data = event.split(/\r?\n/)
                    .filter((line) => line.startsWith("data:"))
                    .map((line) => line.slice(5).trimStart())
                    .join("\n");
                if (data === "[DONE]") return found;
                if (!data) continue;
                try {
                    recordUsage(data);
                } catch {
                    // Other SSE events do not contain completion usage.
                }
            }
            if (done) {
                if (buffer.trim()) {
                    const data = buffer.split(/\r?\n/)
                        .filter((line) => line.startsWith("data:"))
                        .map((line) => line.slice(5).trimStart())
                        .join("\n");
                    if (data && data !== "[DONE]") {
                        try { recordUsage(data); } catch { /* Incomplete SSE event. */ }
                    }
                }
                return found;
            }
            if (buffer.length > 1_000_000) buffer = buffer.slice(-4096);
        }
    } finally {
        await reader.cancel().catch(() => undefined);
    }
}

function isGenerationEndpoint(input: RequestInfo | URL): boolean {
    const url = typeof input === "string" ? input : "url" in input ? input.url : input.toString();
    const path = url.split("?")[0];
    return GENERATION_ENDPOINTS.some((endpoint) => path.endsWith(endpoint));
}

function installResponseUsageObserver(): void {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (input, init) => {
        const round = currentRound;
        const capture = Boolean(round?.awaitingResponse && isGenerationEndpoint(input));
        if (capture && round) round.awaitingResponse = false;
        const response = await originalFetch(input, init);
        if (!capture || !round || !response.ok || typeof response.clone !== "function") return response;
        try {
            const request = typeof init?.body === "string" ? JSON.parse(init.body) : {};
            const copy = response.clone();
            round.usagePromise = request.stream === true
                ? readStreamingTokenUsage(copy).catch(() => undefined)
                : copy.json().then(getApiTokenUsage).catch(() => undefined);
        } catch {
            round.usagePromise = Promise.resolve(undefined);
        }
        return response;
    };
}

function finishRoundIfReady(round: GenerationRound): void {
    const context = SillyTavern.getContext();
    if (
        currentRound !== round ||
        !round.ended ||
        context.chatId !== round.chatId ||
        context.chatMetadata !== round.metadata ||
        round.receivedMessageId !== context.chat.length - 1 ||
        context.chat[round.receivedMessageId]?.is_user ||
        context.chat[round.receivedMessageId]?.is_system
    ) return;

    currentRound = undefined;
    try {
        const settings = getSettings();
        const afterReply = settings.enabled && settings.mode === "after_reply" &&
            !context.extensionSettings.disabledExtensions.includes(EXTENSION_ID);
        const unlock = afterReply ? blockSendingDuringCompaction() : undefined;
        if (unlock) releaseSendLock = unlock;
        const task = (async () => {
            let usage: ObservedContextUsage | undefined;
            if (settings.triggerMode === "rounds") {
                completedUsages.delete(round.metadata);
            } else {
                const apiUsage = await round.usagePromise;
                let promptTokens = apiUsage?.promptTokens;
                if (promptTokens === undefined && round.promptText !== undefined) {
                    try {
                        const estimate = await context.getTokenCountAsync(round.promptText);
                        if (Number.isSafeInteger(estimate) && estimate >= 0) promptTokens = estimate;
                    } catch (error) {
                        console.warn(`[${MODULE_NAME}] Could not estimate the generated prompt`, error);
                    }
                }
                let replyTokens = apiUsage?.completionTokens;
                if (replyTokens === undefined && apiUsage?.totalTokens !== undefined &&
                    apiUsage.promptTokens !== undefined) {
                    const difference = apiUsage.totalTokens - apiUsage.promptTokens;
                    if (Number.isSafeInteger(difference) && difference >= 0) replyTokens = difference;
                }
                if (replyTokens === undefined) {
                    try {
                        const reply = context.chat[round.receivedMessageId]?.mes ?? "";
                        const estimate = await context.getTokenCountAsync(reply);
                        if (Number.isSafeInteger(estimate) && estimate >= 0) replyTokens = estimate;
                    } catch (error) {
                        console.warn(`[${MODULE_NAME}] Could not estimate the generated reply`, error);
                    }
                }
                const tokens = promptTokens === undefined || replyTokens === undefined
                    ? undefined
                    : promptTokens + replyTokens;
                if (tokens === undefined || !Number.isSafeInteger(tokens) || round.contextSize === undefined) {
                    completedUsages.delete(round.metadata);
                    if (settings.enabled && settings.mode !== "manual" &&
                        !missingUsageWarnings.has(round.metadata)) {
                        missingUsageWarnings.add(round.metadata);
                        (globalThis as typeof globalThis & {
                            toastr?: { warning: (message: string, title?: string) => void };
                        }).toastr?.warning(
                            translate(
                                "Could not determine completed context tokens from the API or tokenizer. Automatic compaction was skipped; manual compaction is still available.",
                                "contextcompact.error.context_tokens_unavailable",
                            ),
                            "ContextCompact",
                        );
                    }
                    return;
                }
                usage = { tokens, contextSize: round.contextSize };
                completedUsages.set(round.metadata, usage);
            }
            const active = SillyTavern.getContext();
            if (active.chatId !== round.chatId || active.chatMetadata !== round.metadata) return;
            if (afterReply && await isAfterReplyTriggerReached(settings, usage)) {
                if (SillyTavern.getContext().chatId !== round.chatId ||
                    SillyTavern.getContext().chatMetadata !== round.metadata) return;
                await scheduleAfterReplyCompaction(settings, usage);
            }
        })()
            .catch((error: unknown) => {
                if (error instanceof Error && error.message === "Compaction was cancelled") return;
                console.error(`[${MODULE_NAME}] After-reply compaction failed`, error);
                const reason = error instanceof Error ? error.message : String(error);
                (globalThis as typeof globalThis & {
                    toastr?: { warning: (message: string, title?: string) => void };
                }).toastr?.warning(
                    translate(
                        "After-reply memory compaction failed: {reason}. The next generation will use existing valid memory or the full chat history.",
                        "contextcompact.error.after_reply_failed",
                        { reason },
                    ),
                    "ContextCompact",
                );
            })
            .finally(() => {
                if (unlock && releaseSendLock === unlock) {
                    unlock();
                    releaseSendLock = undefined;
                }
            });
        completedUsageTasks.set(round.metadata, task);
        void task.finally(() => {
            if (completedUsageTasks.get(round.metadata) === task) completedUsageTasks.delete(round.metadata);
        });
    } catch (error) {
        releaseSendLock?.();
        releaseSendLock = undefined;
        notifyFailure(error);
    }
}

function setMemoryPrompt(value: string, depth = 0): void {
    SillyTavern.getContext().setExtensionPrompt(
        MEMORY_PROMPT_KEY,
        value,
        value ? PROMPT_POSITION_IN_CHAT : PROMPT_POSITION_NONE,
        depth,
        false,
        PROMPT_ROLE_SYSTEM,
    );
}

export function clearGenerationMemoryPrompt(): void {
    setMemoryPrompt("");
}

function notifyFailure(error: unknown): void {
    console.error(`[${MODULE_NAME}] Compaction failed; original chat was kept`, error);
    const reason = error instanceof Error ? error.message : String(error);
    const toast = (
        globalThis as typeof globalThis & {
            toastr?: { warning: (message: string, title?: string) => void };
        }
    ).toastr;
    toast?.warning(
        translate(
            "Memory compaction failed: {reason}. This generation continued with the full chat history.",
            "contextcompact.error.generation_failed",
            { reason },
        ),
        "ContextCompact",
    );
}

async function runGenerationInterceptor(
    messages: GenerationMessage[],
    contextSize: number,
    _abort: (immediately: boolean) => void,
    type: string,
): Promise<void> {
    setMemoryPrompt("");
    if (!SUPPORTED_TYPES.has(type)) {
        return;
    }

    const context = SillyTavern.getContext();
    if (context.extensionSettings.disabledExtensions.includes(EXTENSION_ID)) {
        return;
    }

    const originalMessages = messages.slice();
    try {
        const settings = getSettings();
        if (!settings.enabled) {
            return;
        }

        const round = currentRound;
        if (round && round.chatId === context.chatId && round.metadata === context.chatMetadata) {
            round.contextSize = contextSize;
        }
        await completedUsageTasks.get(context.chatMetadata);

        const result = await getGenerationMemoryState(
            messages,
            contextSize,
            type,
            settings,
            completedUsages.get(context.chatMetadata),
            (currentRound?.requestCount ?? 1) === 1,
        );
        if (!result) {
            return;
        }

        if (
            SillyTavern.getContext().chatId !== context.chatId ||
            SillyTavern.getContext().chat !== context.chat ||
            SillyTavern.getContext().chatMetadata !== context.chatMetadata
        ) {
            throw new Error("Chat changed before memory could be injected");
        }
        const currentSettings = getSettings();
        if (
            context.extensionSettings.disabledExtensions.includes(EXTENSION_ID) ||
            !currentSettings.enabled
        ) {
            return;
        }

        let removed = 0;
        for (let index = messages.length - 1; index >= 0; index--) {
            if (result.rawIndices[index] <= result.state.coveredThrough) {
                messages.splice(index, 1);
                removed++;
            }
        }
        // Depth counts back from the newest chat message. The remaining
        // history length places memory immediately before its oldest message.
        setMemoryPrompt(
            formatMemoryForGeneration(result.state.memory, currentSettings.injectionPrompt),
            messages.length,
        );
        console.debug?.(
            `[${MODULE_NAME}] Replaced ${removed} chat messages through #${result.state.coveredThrough + 1} with memory; ${messages.length} recent messages remain`,
        );
    } catch (error) {
        messages.splice(0, messages.length, ...originalMessages);
        setMemoryPrompt("");
        if (!(error instanceof Error && error.message === "Compaction was cancelled")) {
            notifyFailure(error);
        }
    }
}

export function initializeGenerationInterceptor(): void {
    Object.assign(globalThis, {
        contextCompactGenerateInterceptor: runGenerationInterceptor,
    });
    installResponseUsageObserver();

    const { eventSource, eventTypes } = SillyTavern.getContext();
    eventSource.on(eventTypes.GENERATION_AFTER_COMMANDS, async (type: string, _options: unknown, dryRun: boolean) => {
        if (dryRun || !SUPPORTED_TYPES.has(type)) return;
        await waitForCompactionSendUnlock();
        const context = SillyTavern.getContext();
        if (!context.chatId) return;
        if (
            !currentRound ||
            currentRound.ended ||
            !currentRound.requestIssued ||
            currentRound.chatId !== context.chatId ||
            currentRound.metadata !== context.chatMetadata
        ) {
            currentRound = {
                chatId: context.chatId,
                metadata: context.chatMetadata,
                requestCount: 0,
                requestIssued: false,
                awaitingResponse: false,
                ended: false,
            };
        }
        currentRound.requestCount++;
    });
    eventSource.on(eventTypes.GENERATE_AFTER_DATA, (data: { prompt?: unknown; input?: unknown }, dryRun: boolean) => {
        const round = currentRound;
        if (dryRun || !round) return;
        const context = SillyTavern.getContext();
        if (context.chatId !== round.chatId || context.chatMetadata !== round.metadata) return;
        round.requestIssued = true;
        round.awaitingResponse = true;
        round.usagePromise = undefined;
        round.promptText = undefined;
        const prompt = data?.prompt ?? data?.input;
        if (prompt === undefined || prompt === null) return;
        try {
            round.promptText = typeof prompt === "string" ? prompt : JSON.stringify(prompt);
        } catch (error) {
            console.warn(`[${MODULE_NAME}] Could not serialize the generated prompt`, error);
        }
    });
    eventSource.on(eventTypes.CHAT_CHANGED, () => {
        cancelCompactions();
        currentRound = undefined;
        releaseSendLock?.();
        releaseSendLock = undefined;
        setMemoryPrompt("");
    });
    eventSource.on(eventTypes.SETTINGS_UPDATED, () => setMemoryPrompt(""));
    eventSource.on(eventTypes.GENERATION_ENDED, () => {
        setMemoryPrompt("");
        if (currentRound) {
            currentRound.ended = true;
            finishRoundIfReady(currentRound);
        }
    });
    eventSource.on(eventTypes.GENERATION_STOPPED, () => {
        cancelCompactions();
        currentRound = undefined;
        releaseSendLock?.();
        releaseSendLock = undefined;
        setMemoryPrompt("");
    });
    eventSource.on(eventTypes.MESSAGE_RECEIVED, (messageId: number, type: string) => {
        if (!["normal", "continue", "regenerate", "swipe"].includes(type)) return;
        if (!currentRound) return;
        currentRound.receivedMessageId = messageId;
        finishRoundIfReady(currentRound);
    });
    const invalidatePrompt = () => {
        cancelCompactions();
        setMemoryPrompt("");
    };
    for (const type of [
        eventTypes.MESSAGE_EDITED,
        eventTypes.MESSAGE_UPDATED,
        eventTypes.MESSAGE_DELETED,
        eventTypes.MESSAGE_SWIPED,
        eventTypes.MESSAGE_SWIPE_DELETED,
        eventTypes.MESSAGE_REASONING_EDITED,
        eventTypes.MESSAGE_REASONING_DELETED,
        eventTypes.MESSAGE_FILE_EMBEDDED,
        eventTypes.MEDIA_ATTACHMENT_DELETED,
        eventTypes.IMAGE_SWIPED,
    ]) {
        eventSource.on(type, invalidatePrompt);
    }
}
