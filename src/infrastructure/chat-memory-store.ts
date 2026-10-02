import { isCoveredSourceCurrent } from "../domain/boundary";
import {
    MemoryValidationError,
    validateChatCompactState,
    type ChatCompactState,
} from "../domain/memory";

const CHAT_METADATA_KEY = "contextCompact";

export type ChatStateReadResult =
    | { status: "empty" }
    | { status: "valid"; state: ChatCompactState }
    | { status: "invalid"; reason: string }
    | { status: "stale"; reason: string };

export function readChatState(): ChatStateReadResult {
    const raw: unknown = SillyTavern.getContext().chatMetadata[CHAT_METADATA_KEY];
    if (raw === undefined) {
        return { status: "empty" };
    }

    try {
        return { status: "valid", state: validateChatCompactState(raw) };
    } catch (error) {
        return {
            status: "invalid",
            reason:
                error instanceof MemoryValidationError
                    ? error.message
                    : "Unknown memory state error",
        };
    }
}

export async function readCurrentChatState(): Promise<ChatStateReadResult> {
    const context = SillyTavern.getContext();
    const result = readChatState();
    if (result.status !== "valid") {
        return result;
    }

    try {
        const current = await isCoveredSourceCurrent(result.state, context.chat);
        const active = SillyTavern.getContext();
        if (
            active.chatId !== context.chatId ||
            active.chat !== context.chat ||
            active.chatMetadata !== context.chatMetadata ||
            !current
        ) {
            return { status: "stale", reason: "Covered chat history changed" };
        }
        return result;
    } catch {
        return { status: "stale", reason: "Covered chat history could not be checked" };
    }
}

function requireChatContext(expectedChatId: string): ReturnType<typeof SillyTavern.getContext> {
    const context = SillyTavern.getContext();
    if (!expectedChatId || context.chatId !== expectedChatId) {
        throw new Error("The active chat changed before memory could be saved");
    }
    return context;
}

async function readPersistedState(
    context: ReturnType<typeof SillyTavern.getContext>,
    chatId: string,
): Promise<unknown> {
    let endpoint: string;
    let requestBody: object;

    if (context.groupId) {
        endpoint = "/api/chats/group/get";
        requestBody = { id: chatId };
    } else {
        const character = context.characters[context.characterId];
        if (!character || character.chat !== chatId) {
            throw new Error("Character chat is no longer available");
        }
        endpoint = "/api/chats/get";
        requestBody = {
            ch_name: character.name,
            file_name: chatId,
            avatar_url: character.avatar,
        };
    }

    const response = await fetch(endpoint, {
        method: "POST",
        headers: context.getRequestHeaders(),
        cache: "no-cache",
        body: JSON.stringify(requestBody),
    });
    if (!response.ok) {
        throw new Error(`Could not verify memory save (${response.status})`);
    }

    const data: unknown = await response.json();
    if (!Array.isArray(data) || data.length === 0) {
        throw new Error("Saved chat could not be read back");
    }
    const header: unknown = data[0];
    if (typeof header !== "object" || header === null || !("chat_metadata" in header)) {
        throw new Error("Saved chat has no metadata header");
    }
    const metadata: unknown = header.chat_metadata;
    if (typeof metadata !== "object" || metadata === null) {
        throw new Error("Saved chat has no metadata");
    }
    return (metadata as Record<string, unknown>)[CHAT_METADATA_KEY];
}

// saveMetadata() can swallow errors, so read the chat back from the server.
export async function writeChatState(
    state: ChatCompactState,
    expectedChatId: string,
): Promise<void> {
    const validated = validateChatCompactState(state);
    const context = requireChatContext(expectedChatId);
    const metadata = context.chatMetadata;
    const previous: unknown = metadata[CHAT_METADATA_KEY];
    metadata[CHAT_METADATA_KEY] = validated;

    try {
        await context.saveMetadata();
        const persisted = validateChatCompactState(
            await readPersistedState(context, expectedChatId),
        );
        if (JSON.stringify(persisted) !== JSON.stringify(validated)) {
            throw new Error("Saved memory differs from the proposed memory");
        }
        if (
            SillyTavern.getContext().chatId !== expectedChatId ||
            SillyTavern.getContext().chatMetadata !== metadata
        ) {
            throw new Error("The active chat changed while memory was being saved");
        }
    } catch (error) {
        if (previous === undefined) {
            delete metadata[CHAT_METADATA_KEY];
        } else {
            metadata[CHAT_METADATA_KEY] = previous;
        }
        throw error;
    }
}

export async function deleteChatState(expectedChatId: string): Promise<void> {
    const context = requireChatContext(expectedChatId);
    const metadata = context.chatMetadata;
    const previous: unknown = metadata[CHAT_METADATA_KEY];
    delete metadata[CHAT_METADATA_KEY];

    try {
        await context.saveMetadata();
        if ((await readPersistedState(context, expectedChatId)) !== undefined) {
            throw new Error("Deleted memory is still present in the saved chat");
        }
        if (
            SillyTavern.getContext().chatId !== expectedChatId ||
            SillyTavern.getContext().chatMetadata !== metadata
        ) {
            throw new Error("The active chat changed while memory was being deleted");
        }
    } catch (error) {
        if (previous !== undefined) {
            metadata[CHAT_METADATA_KEY] = previous;
        }
        throw error;
    }
}
