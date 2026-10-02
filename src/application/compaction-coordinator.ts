import { getCoveredPrefixDigest } from "../domain/boundary";
import {
    buildSummaryInput,
    buildSummaryInstruction,
    buildTextCompletionSummaryPrompt,
    type MemorySourceMessage,
    type SystemPromptMessage,
} from "../domain/prompt";
import {
    parseStructuredMemoryJson,
    type ChatCompactState,
    type StructuredMemory,
} from "../domain/memory";
import type { ContextCompactSettings } from "../domain/settings";
import { translate } from "../i18n";
import {
    deleteChatState,
    readCurrentChatState,
    writeChatState,
} from "../infrastructure/chat-memory-store";
import { summarizeMessages } from "../infrastructure/summary-client";
import { captureActiveSystemMessages } from "../infrastructure/system-prompt-capture";
import { blockSendingDuringCompaction } from "../infrastructure/compaction-send-lock";

export interface GenerationMessage {
    index?: number;
    name?: string;
    mes?: string;
    is_user?: boolean;
    is_system?: boolean;
}

const activeTasks = new Map<string, Promise<ChatCompactState>>();
const activeControllers = new Set<AbortController>();
const chatLocks = new Map<string, Promise<void>>();
const afterReplyTasks = new Map<string, Promise<void>>();

export interface ObservedContextUsage {
    tokens: number;
    contextSize: number;
}

function getTriggerThreshold(contextSize: number, settings: ContextCompactSettings): number {
    return settings.triggerMode === "tokens"
        ? settings.triggerTokens
        : Math.floor(contextSize * settings.triggerRatio);
}

export function exceedsTrigger(
    usage: ObservedContextUsage | undefined,
    settings: ContextCompactSettings,
): boolean {
    if (settings.triggerMode === "rounds") return false;
    return Boolean(
        usage &&
        Number.isFinite(usage.tokens) &&
        usage.tokens >= 0 &&
        Number.isFinite(usage.contextSize) &&
        usage.contextSize > 0 &&
        usage.tokens >= getTriggerThreshold(usage.contextSize, settings),
    );
}

function latestUserMessageIndex(rawIndices: readonly number[]): number {
    const chat = SillyTavern.getContext().chat;
    for (let index = rawIndices.length - 1; index >= 0; index--) {
        const rawIndex = rawIndices[index];
        if (chat[rawIndex]?.is_user && !chat[rawIndex]?.is_system) return rawIndex;
    }
    return -1;
}

function hasReachedTrigger(
    settings: ContextCompactSettings,
    usage: ObservedContextUsage | undefined,
    previousState: ChatCompactState | undefined,
): boolean {
    if (settings.triggerMode !== "rounds") return exceedsTrigger(usage, settings);
    const chat = SillyTavern.getContext().chat;
    const savedIndex = previousState?.lastCompactionUserIndex;
    const checkpoint = savedIndex !== undefined && savedIndex < chat.length &&
        (savedIndex === -1 || (chat[savedIndex]?.is_user && !chat[savedIndex]?.is_system))
        ? savedIndex
        : previousState?.coveredThrough ?? -1;
    let userMessages = 0;
    for (let index = checkpoint + 1; index < chat.length; index++) {
        if (chat[index].is_user && !chat[index].is_system) userMessages++;
    }
    return userMessages >= settings.triggerRounds;
}

export async function isAfterReplyTriggerReached(
    settings: ContextCompactSettings,
    usage?: ObservedContextUsage,
): Promise<boolean> {
    const context = SillyTavern.getContext();
    const readResult = await readCurrentChatState();
    if (
        SillyTavern.getContext().chatId !== context.chatId ||
        SillyTavern.getContext().chat !== context.chat ||
        SillyTavern.getContext().chatMetadata !== context.chatMetadata
    ) return false;
    const validState = readResult.status === "valid" ? readResult.state : undefined;
    if (validState && !isCompleteRoundBoundary(context.chat, validState.coveredThrough)) {
        return true;
    }
    if (validState && validState.coveredThrough >
        getRetentionBoundary(context.chat, settings.recentRoundCount).lastEligibleRawIndex) {
        return true;
    }
    return hasReachedTrigger(settings, usage, validState);
}

async function withChatLock<T>(chatId: string, action: () => Promise<T>): Promise<T> {
    const previous = chatLocks.get(chatId);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    chatLocks.set(chatId, gate);
    try {
        await previous;
        return await action();
    } finally {
        release();
        if (chatLocks.get(chatId) === gate) chatLocks.delete(chatId);
    }
}

async function waitForChatLock(chatId: string): Promise<void> {
    await chatLocks.get(chatId);
}

export function cancelCompactions(): void {
    for (const controller of activeControllers) {
        controller.abort(new Error("Compaction was cancelled"));
    }
}

function getRawIndices(
    messages: readonly GenerationMessage[],
    type: string,
): number[] {
    const context = SillyTavern.getContext();
    const canUseTools = context.isToolCallingSupported();
    const rawIndices: number[] = [];

    for (const [index, message] of context.chat.entries()) {
        if (
            !message.is_system ||
            (canUseTools && Array.isArray(message.extra?.tool_invocations))
        ) {
            rawIndices.push(index);
        }
    }
    if (type === "swipe") {
        rawIndices.pop();
    }
    if (rawIndices.length !== messages.length) {
        throw new Error("Generation history no longer matches the active chat");
    }
    for (const [index, rawIndex] of rawIndices.entries()) {
        const source = context.chat[rawIndex];
        if (
            messages[index].index !== index ||
            source.name !== messages[index].name ||
            Boolean(source.is_user) !== Boolean(messages[index].is_user) ||
            Boolean(source.is_system) !== Boolean(messages[index].is_system)
        ) {
            throw new Error("Generation message order changed unexpectedly");
        }
    }
    return rawIndices;
}

function getCurrentRawIndices(): number[] {
    const context = SillyTavern.getContext();
    const canUseTools = context.isToolCallingSupported();
    return context.chat.flatMap((message: ChatMessage, index: number) =>
        !message.is_system ||
        (canUseTools && Array.isArray(message.extra?.tool_invocations))
            ? [index]
            : [],
    );
}

function hasNonTextContent(message: ChatMessage): boolean {
    const extra = message.extra;
    return Boolean(
        (Array.isArray(extra?.files) && extra.files.length) ||
            extra?.file ||
            (Array.isArray(extra?.media) && extra.media.length) ||
            extra?.image ||
            extra?.video ||
            (Array.isArray(extra?.image_swipes) && extra.image_swipes.length),
    );
}

interface ChatRound {
    start: number;
    end: number;
    messages: MemorySourceMessage[];
}

function getCompleteRoundRanges(chat: readonly ChatMessage[]): Array<Pick<ChatRound, "start" | "end">> {
    const userStarts = chat.flatMap((message, index) =>
        message.is_user && !message.is_system ? [index] : [],
    );
    return userStarts.flatMap((userStart, index) => {
        const nextUser = userStarts[index + 1];
        const end = nextUser === undefined ? chat.length - 1 : nextUser - 1;
        if (nextUser === undefined) {
            let lastMeaningful = end;
            while (lastMeaningful >= userStart && chat[lastMeaningful].is_system &&
                !chat[lastMeaningful].extra?.tool_invocations?.length) lastMeaningful--;
            if (lastMeaningful < userStart || chat[lastMeaningful].is_user ||
                chat[lastMeaningful].is_system) return [];
        }
        return [{ start: index === 0 ? 0 : userStart, end }];
    });
}

function isCompleteRoundBoundary(chat: readonly ChatMessage[], boundary: number): boolean {
    return getCompleteRoundRanges(chat).some((round) => round.end === boundary);
}

function getRetentionBoundary(
    chat: readonly ChatMessage[],
    recentRoundCount: number,
): { roundCount: number; lastEligibleRawIndex: number } {
    const userStarts = chat.flatMap((message, index) =>
        message.is_user && !message.is_system ? [index] : [],
    );
    return {
        roundCount: userStarts.length,
        lastEligibleRawIndex: userStarts.length > recentRoundCount
            ? userStarts[userStarts.length - recentRoundCount] - 1
            : -1,
    };
}

function toMemoryMessage(
    chat: readonly ChatMessage[],
    sendable: ReadonlySet<number>,
    index: number,
): { message?: MemorySourceMessage; blocked?: "non_text" | "empty" } {
    const source = chat[index];
    const invocations = source.extra?.tool_invocations;
    if (Array.isArray(invocations) && invocations.length > 0) {
        if (hasNonTextContent(source)) return { blocked: "non_text" };
        return {
            message: {
                index,
                role: "tool",
                content: JSON.stringify(invocations.map((invocation) => ({
                    name: invocation.name,
                    parameters: invocation.parameters,
                    result: invocation.result,
                    error: invocation.error === true,
                }))),
            },
        };
    }
    if (!sendable.has(index)) return {};
    if (hasNonTextContent(source)) return { blocked: "non_text" };
    if (typeof source.mes !== "string" || !source.mes.trim()) return { blocked: "empty" };
    return {
        message: {
            index,
            role: source.is_user ? "user" : "assistant",
            content: source.mes,
        },
    };
}

function selectOldMessages(
    rawIndices: readonly number[],
    recentRoundCount: number,
    previousBoundary: number,
): { rounds: ChatRound[]; messages: MemorySourceMessage[]; coveredThrough: number } | undefined {
    const context = SillyTavern.getContext();
    const { lastEligibleRawIndex } = getRetentionBoundary(context.chat, recentRoundCount);
    if (lastEligibleRawIndex < 0) {
        return undefined;
    }
    if (lastEligibleRawIndex <= previousBoundary) {
        return undefined;
    }

    const sendable = new Set(rawIndices);
    const rounds: ChatRound[] = [];
    let coveredThrough = previousBoundary;
    for (const range of getCompleteRoundRanges(context.chat)) {
        if (range.end <= previousBoundary) continue;
        if (range.end > lastEligibleRawIndex || range.start <= previousBoundary) break;
        const messages: MemorySourceMessage[] = [];
        let blocked = false;
        for (let index = range.start; index <= range.end; index++) {
            const item = toMemoryMessage(context.chat, sendable, index);
            if (item.blocked) {
                blocked = true;
                break;
            }
            if (item.message) messages.push(item.message);
        }
        if (blocked) break;
        rounds.push({ ...range, messages });
        coveredThrough = range.end;
    }
    return rounds.length
        ? { rounds, messages: rounds.flatMap((round) => round.messages), coveredThrough }
        : undefined;
}

function explainNoEligiblePrefix(
    rawIndices: readonly number[],
    recentRoundCount: number,
    previousBoundary: number,
): string {
    const chat = SillyTavern.getContext().chat;
    const { roundCount, lastEligibleRawIndex } = getRetentionBoundary(chat, recentRoundCount);
    if (lastEligibleRawIndex < 0) {
        return translate(
            "This chat has {count} user turns, and the setting keeps the latest {recent} turns. Reduce that limit or continue chatting before compacting.",
            "contextcompact.error.not_enough_rounds",
            { count: roundCount, recent: recentRoundCount },
        );
    }
    if (previousBoundary >= 0 && !isCompleteRoundBoundary(chat, previousBoundary)) {
        return translate(
            "Saved memory ends inside a user turn. Rebuild it from chat history before continuing.",
            "contextcompact.error.partial_round_memory",
        );
    }
    if (lastEligibleRawIndex <= previousBoundary) {
        return translate(
            "Saved memory already covers all eligible older messages. There is nothing new to compact.",
            "contextcompact.error.no_new_messages",
        );
    }
    const sendable = new Set(rawIndices);
    for (const round of getCompleteRoundRanges(chat)) {
        if (round.end <= previousBoundary) continue;
        if (round.end > lastEligibleRawIndex) break;
        for (let index = round.start; index <= round.end; index++) {
            const item = toMemoryMessage(chat, sendable, index);
            if (item.blocked) {
                return item.blocked === "non_text"
                    ? translate(
                        "Message #{message} contains an image or file. Messages after it cannot be compacted safely.",
                        "contextcompact.error.non_text_message",
                        { message: index + 1 },
                    )
                    : translate(
                        "Message #{message} has no text to summarize. Messages after it cannot be compacted safely.",
                        "contextcompact.error.empty_message",
                        { message: index + 1 },
                    );
            }
        }
    }
    return translate(
        "No complete older user turn is available for compaction yet.",
        "contextcompact.error.no_complete_round",
    );
}

async function saveComputedState(
    chatId: string,
    chat: ChatMessage[],
    metadata: ChatMetadata,
    originalStoredState: string,
    coveredThrough: number,
    sourceDigest: string,
    memory: StructuredMemory,
    lastCompactionUserIndex: number,
    signal: AbortSignal,
): Promise<ChatCompactState> {
    signal.throwIfAborted();
    const active = SillyTavern.getContext();
    if (
        active.chatId !== chatId ||
        active.chat !== chat ||
        active.chatMetadata !== metadata ||
        JSON.stringify(metadata.contextCompact ?? null) !== originalStoredState ||
        (await getCoveredPrefixDigest(active.chat, coveredThrough)) !== sourceDigest
    ) {
        throw new Error("Chat history changed during compression");
    }
    signal.throwIfAborted();
    const rawRevision: unknown = metadata.contextCompact?.revision;
    const revision =
        typeof rawRevision === "number" && Number.isSafeInteger(rawRevision)
            ? rawRevision + 1
            : 0;
    const nextState: ChatCompactState = {
        schemaVersion: 1,
        coveredThrough,
        sourceDigest,
        memory,
        revision,
        updatedAt: new Date().toISOString(),
        lastCompactionUserIndex,
    };
    await writeChatState(nextState, chatId);
    return nextState;
}

async function createUpdatedState(
    chatId: string,
    rawIndices: readonly number[],
    settings: ContextCompactSettings,
    previousState: ChatCompactState | undefined,
    signal: AbortSignal,
): Promise<ChatCompactState> {
    const context = SillyTavern.getContext();
    const metadata = context.chatMetadata;
    const originalStoredState = JSON.stringify(metadata.contextCompact ?? null);
    const lastCompactionUserIndex = latestUserMessageIndex(rawIndices);
    const systemMessages = await captureActiveSystemMessages(signal);
    const selection = selectOldMessages(
        rawIndices,
        settings.recentRoundCount,
        previousState?.coveredThrough ?? -1,
    );
    if (!selection) {
        throw new Error(explainNoEligiblePrefix(
            rawIndices,
            settings.recentRoundCount,
            previousState?.coveredThrough ?? -1,
        ));
    }

    const sourceDigest = await getCoveredPrefixDigest(
        context.chat,
        selection.coveredThrough,
    );
    const memory = await summarizeMessages({
        previousMemory: previousState?.memory,
        systemMessages,
        messages: selection.messages,
        settings,
        signal,
    });
    return saveComputedState(
        chatId,
        context.chat,
        metadata,
        originalStoredState,
        selection.coveredThrough,
        sourceDigest,
        memory,
        lastCompactionUserIndex,
        signal,
    );
}

function isContextLengthError(error: unknown): boolean {
    if (!(error instanceof Error)) return false;
    if (/(context|prompt|input|token).*(too long|length|limit|exceed|maximum)|(too many tokens|maximum context)/i.test(error.message)) {
        return true;
    }
    return isContextLengthError((error as Error & { cause?: unknown }).cause);
}

function getRebuildInputLimit(settings: ContextCompactSettings): number {
    const contextSize = Math.floor(SillyTavern.getContext().maxContext);
    if (!Number.isSafeInteger(contextSize) || contextSize <= 0) {
        throw new Error("The summary model context size is unavailable");
    }
    const outputReserve = Math.min(
        Math.max(settings.targetMemoryTokens, 256),
        Math.floor(contextSize / 3),
    );
    const available = contextSize - outputReserve;
    return settings.triggerMode === "rounds"
        ? available
        : Math.min(available, getTriggerThreshold(contextSize, settings));
}

async function countSummaryRequestTokens(
    memory: StructuredMemory | undefined,
    systemMessages: readonly SystemPromptMessage[],
    messages: readonly MemorySourceMessage[],
    settings: ContextCompactSettings,
): Promise<number> {
    const instruction = buildSummaryInstruction(
        settings.summaryLanguage,
        settings.targetMemoryTokens,
        settings.summaryPrompt,
    );
    const input = buildSummaryInput(memory, systemMessages, messages);
    const prompt = buildTextCompletionSummaryPrompt(instruction, input);
    const count = await SillyTavern.getContext().getTokenCountAsync(prompt);
    if (!Number.isSafeInteger(count) || count < 0) {
        throw new Error("Could not estimate the rebuild request size");
    }
    return count;
}

async function createRebuiltState(
    chatId: string,
    rawIndices: readonly number[],
    settings: ContextCompactSettings,
    signal: AbortSignal,
): Promise<ChatCompactState> {
    const context = SillyTavern.getContext();
    const metadata = context.chatMetadata;
    const originalStoredState = JSON.stringify(metadata.contextCompact ?? null);
    const selection = selectOldMessages(rawIndices, settings.recentRoundCount, -1);
    if (!selection) {
        throw new Error(explainNoEligiblePrefix(rawIndices, settings.recentRoundCount, -1));
    }
    const { lastEligibleRawIndex } = getRetentionBoundary(context.chat, settings.recentRoundCount);
    const eligibleRanges = getCompleteRoundRanges(context.chat)
        .filter((round) => round.end <= lastEligibleRawIndex);
    const finalRound = eligibleRanges[eligibleRanges.length - 1];
    if (selection.coveredThrough !== finalRound?.end) {
        throw new Error(explainNoEligiblePrefix(rawIndices, settings.recentRoundCount, -1));
    }

    const sourceDigest = await getCoveredPrefixDigest(context.chat, selection.coveredThrough);
    const lastCompactionUserIndex = latestUserMessageIndex(rawIndices);
    const systemMessages = await captureActiveSystemMessages(signal);
    const inputLimit = getRebuildInputLimit(settings);
    let memory: StructuredMemory | undefined;
    let cursor = 0;

    while (cursor < selection.rounds.length) {
        signal.throwIfAborted();
        const maxEnd = settings.triggerMode === "rounds"
            ? Math.min(selection.rounds.length, cursor + settings.triggerRounds)
            : selection.rounds.length;
        let end = cursor;
        for (let candidate = cursor + 1; candidate <= maxEnd; candidate++) {
            const messages = selection.rounds.slice(cursor, candidate)
                .flatMap((round) => round.messages);
            const tokens = await countSummaryRequestTokens(
                memory, systemMessages, messages, settings,
            );
            if (tokens > inputLimit) break;
            end = candidate;
        }
        if (end === cursor) {
            throw new Error(translate(
                "A complete user turn cannot fit in one rebuild request. The saved memory was kept.",
                "contextcompact.error.rebuild_round_too_large",
            ));
        }

        while (true) {
            try {
                memory = await summarizeMessages({
                    previousMemory: memory,
                    systemMessages,
                    messages: selection.rounds.slice(cursor, end)
                        .flatMap((round) => round.messages),
                    settings,
                    signal,
                });
                break;
            } catch (error) {
                if (!isContextLengthError(error)) throw error;
                if (end === cursor + 1) {
                    throw Object.assign(new Error(translate(
                        "A complete user turn exceeds the summary model context window. The saved memory was kept.",
                        "contextcompact.error.rebuild_round_rejected",
                    )), { cause: error });
                }
                end = cursor + Math.floor((end - cursor) / 2);
            }
        }
        cursor = end;
        if (
            SillyTavern.getContext().chatId !== chatId ||
            SillyTavern.getContext().chat !== context.chat ||
            SillyTavern.getContext().chatMetadata !== metadata ||
            JSON.stringify(metadata.contextCompact ?? null) !== originalStoredState ||
            (await getCoveredPrefixDigest(context.chat, selection.coveredThrough)) !== sourceDigest
        ) {
            throw new Error("Chat history changed during compression");
        }
    }

    return saveComputedState(
        chatId,
        context.chat,
        metadata,
        originalStoredState,
        selection.coveredThrough,
        sourceDigest,
        memory!,
        lastCompactionUserIndex,
        signal,
    );
}

async function runCompaction(
    chatId: string,
    rawIndices: readonly number[],
    settings: ContextCompactSettings,
    rebuild = false,
): Promise<ChatCompactState> {
    const previousTask = activeTasks.get(chatId);
    if (previousTask && !rebuild) return previousTask;
    const releaseSend = blockSendingDuringCompaction();
    const expected = SillyTavern.getContext();
    const controller = new AbortController();
    activeControllers.add(controller);
    const task = withChatLock(chatId, async () => {
        controller.signal.throwIfAborted();
        const latest = await readCurrentChatState();
        controller.signal.throwIfAborted();
        const current = SillyTavern.getContext();
        if (
            current.chatId !== chatId ||
            current.chat !== expected.chat ||
            current.chatMetadata !== expected.chatMetadata
        ) {
            throw new Error("Chat changed while waiting for compaction");
        }
        const previousState = latest.status === "valid" &&
            isCompleteRoundBoundary(current.chat, latest.state.coveredThrough)
            ? latest.state
            : undefined;
        return rebuild || (latest.status !== "empty" && !previousState)
            ? createRebuiltState(chatId, rawIndices, settings, controller.signal)
            : createUpdatedState(chatId, rawIndices, settings, previousState, controller.signal);
    });
    activeTasks.set(chatId, task);
    try {
        return await task;
    } finally {
        releaseSend();
        activeControllers.delete(controller);
        if (activeTasks.get(chatId) === task) {
            activeTasks.delete(chatId);
        }
    }
}

export async function getGenerationMemoryState(
    messages: readonly GenerationMessage[],
    contextSize: number,
    type: string,
    settings: ContextCompactSettings,
    previousUsage?: ObservedContextUsage,
    firstRequestInTurn = true,
): Promise<{ state: ChatCompactState; rawIndices: number[] } | undefined> {
    const context = SillyTavern.getContext();
    const chatId = context.chatId;
    if (!chatId || !Number.isFinite(contextSize) || contextSize <= 0) {
        return undefined;
    }

    await afterReplyTasks.get(chatId);
    const rawIndices = getRawIndices(messages, type);
    await waitForChatLock(chatId);
    const readResult = await readCurrentChatState();
    const needsRoundRepair = readResult.status === "valid" &&
        !isCompleteRoundBoundary(context.chat, readResult.state.coveredThrough);
    const retentionBoundary = getRetentionBoundary(context.chat, settings.recentRoundCount).lastEligibleRawIndex;
    const needsRetentionRepair = readResult.status === "valid" &&
        readResult.state.coveredThrough > retentionBoundary;
    const needsSourceRepair = readResult.status === "stale" || readResult.status === "invalid";
    const previousState = readResult.status === "valid" &&
        !needsRoundRepair && !needsRetentionRepair
        ? readResult.state
        : undefined;
    if (
        SillyTavern.getContext().chatId !== chatId ||
        SillyTavern.getContext().chat !== context.chat ||
        SillyTavern.getContext().chatMetadata !== context.chatMetadata
    ) {
        throw new Error("Chat changed while checking the context budget");
    }
    if (needsRetentionRepair && retentionBoundary < 0) {
        return undefined;
    }
    const shouldRepair = type === "normal" && firstRequestInTurn &&
        (needsRoundRepair || needsRetentionRepair || needsSourceRepair);
    const shouldCompact = shouldRepair || (
        type === "normal" &&
        settings.mode === "before_send" &&
        firstRequestInTurn &&
        hasReachedTrigger(
            settings,
            previousUsage ? { tokens: previousUsage.tokens, contextSize } : undefined,
            previousState,
        )
    );
    const hasEligiblePrefix = shouldCompact && Boolean(selectOldMessages(
        rawIndices,
        settings.recentRoundCount,
        previousState?.coveredThrough ?? -1,
    ));
    if (shouldRepair && !hasEligiblePrefix) {
        throw new Error(explainNoEligiblePrefix(rawIndices, settings.recentRoundCount, -1));
    }
    const state = hasEligiblePrefix
        ? await runCompaction(
            chatId,
            rawIndices,
            settings,
            needsRetentionRepair,
        )
        : previousState;
    if (!state) {
        if (needsRoundRepair || needsRetentionRepair || needsSourceRepair) {
            throw new Error(translate(
                "Saved memory needs to be rebuilt before it can replace chat history.",
                "contextcompact.error.memory_needs_rebuild",
            ));
        }
        return undefined;
    }
    const confirmed = await readCurrentChatState();
    if (
        SillyTavern.getContext().chatId !== chatId ||
        SillyTavern.getContext().chat !== context.chat ||
        SillyTavern.getContext().chatMetadata !== context.chatMetadata ||
        confirmed.status !== "valid"
    ) {
        throw new Error("Saved memory is no longer valid for this chat");
    }
    return { state: confirmed.state, rawIndices };
}

function requireCurrentChat(): { chatId: string; metadata: ChatMetadata } {
    const context = SillyTavern.getContext();
    if (!context.chatId) throw new Error("Open a chat first");
    return { chatId: context.chatId, metadata: context.chatMetadata };
}

function requireSameChat(chatId: string, metadata: ChatMetadata): void {
    const current = SillyTavern.getContext();
    if (current.chatId !== chatId || current.chatMetadata !== metadata) {
        throw new Error("The active chat changed");
    }
}

export async function compactCurrentChat(
    settings: ContextCompactSettings,
    mode: "manual" | "after_reply",
    rebuild = false,
    observedUsage?: ObservedContextUsage,
): Promise<ChatCompactState | undefined> {
    const releaseSend = blockSendingDuringCompaction();
    try {
        const { chatId, metadata } = requireCurrentChat();
        await waitForChatLock(chatId);
        requireSameChat(chatId, metadata);
        const rawIndices = getCurrentRawIndices();
        const readResult = await readCurrentChatState();
        const needsRoundRepair = readResult.status === "valid" &&
            !isCompleteRoundBoundary(SillyTavern.getContext().chat, readResult.state.coveredThrough);
        const needsRetentionRepair = readResult.status === "valid" &&
            readResult.state.coveredThrough >
                getRetentionBoundary(SillyTavern.getContext().chat, settings.recentRoundCount).lastEligibleRawIndex;
        const previousState = !rebuild && readResult.status === "valid" &&
            !needsRoundRepair && !needsRetentionRepair
            ? readResult.state
            : undefined;
        if (mode === "after_reply" && !needsRoundRepair && !needsRetentionRepair &&
            !hasReachedTrigger(settings, observedUsage, previousState)) {
            return previousState;
        }
        if (!selectOldMessages(
            rawIndices,
            settings.recentRoundCount,
            previousState?.coveredThrough ?? -1,
        )) {
            if (mode === "manual") {
                throw new Error(explainNoEligiblePrefix(
                    rawIndices,
                    settings.recentRoundCount,
                    previousState?.coveredThrough ?? -1,
                ));
            }
            return previousState;
        }
        requireSameChat(chatId, metadata);
        return await runCompaction(chatId, rawIndices, settings, rebuild || needsRetentionRepair);
    } finally {
        releaseSend();
    }
}

export function scheduleAfterReplyCompaction(
    settings: ContextCompactSettings,
    usage?: ObservedContextUsage,
): Promise<void> {
    const chatId = SillyTavern.getContext().chatId;
    if (!chatId) return Promise.resolve();
    const previous = afterReplyTasks.get(chatId);
    if (previous) return previous;
    const task = compactCurrentChat(settings, "after_reply", false, usage)
        .then(() => undefined)
        .finally(() => {
            if (afterReplyTasks.get(chatId) === task) afterReplyTasks.delete(chatId);
        });
    afterReplyTasks.set(chatId, task);
    return task;
}

export async function editCurrentMemory(
    json: string,
    expected: Pick<ChatCompactState, "revision" | "coveredThrough" | "sourceDigest">,
): Promise<ChatCompactState> {
    const { chatId, metadata } = requireCurrentChat();
    const memory = parseStructuredMemoryJson(json);
    return withChatLock(chatId, async () => {
        requireSameChat(chatId, metadata);
        const readResult = await readCurrentChatState();
        if (readResult.status !== "valid") {
            throw new Error("Memory is missing or out of date; rebuild it first");
        }
        const previous = readResult.state;
        if (
            previous.revision !== expected.revision ||
            previous.coveredThrough !== expected.coveredThrough ||
            previous.sourceDigest !== expected.sourceDigest
        ) {
            throw new Error("Memory changed while editing; reload it first");
        }
        const digest = await getCoveredPrefixDigest(
            SillyTavern.getContext().chat,
            previous.coveredThrough,
        );
        requireSameChat(chatId, metadata);
        if (
            digest !== previous.sourceDigest ||
            metadata.contextCompact?.revision !== previous.revision
        ) {
            throw new Error("Memory changed while editing; reload it first");
        }
        const next: ChatCompactState = {
            ...previous,
            memory,
            revision: previous.revision + 1,
            updatedAt: new Date().toISOString(),
        };
        await writeChatState(next, chatId);
        return next;
    });
}

export async function clearCurrentMemory(): Promise<void> {
    const { chatId, metadata } = requireCurrentChat();
    return withChatLock(chatId, async () => {
        requireSameChat(chatId, metadata);
        await deleteChatState(chatId);
    });
}
