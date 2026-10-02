import {
    clearCurrentMemory,
    compactCurrentChat,
    editCurrentMemory,
} from "../application/compaction-coordinator";
import { EXTENSION_ID, MODULE_NAME } from "../constants";
import { parseStructuredMemoryJson, type ChatCompactState, type StructuredMemory } from "../domain/memory";
import { translate } from "../i18n";
import { readChatState, readCurrentChatState } from "../infrastructure/chat-memory-store";
import { clearGenerationMemoryPrompt } from "../infrastructure/generation-interceptor";
import { getSettings } from "../infrastructure/settings-store";

const buttonIds = [
    "contextcompact_refresh",
    "contextcompact_save_memory",
    "contextcompact_compact",
    "contextcompact_rebuild",
    "contextcompact_clear",
    "contextcompact_toggle_view",
] as const;
const listFields = [
    ["importantEvents", "contextcompact_important_events", "Important events"],
    ["establishedFacts", "contextcompact_established_facts", "Established facts"],
    ["relationships", "contextcompact_relationships", "Relationships"],
    ["openThreads", "contextcompact_open_threads", "Open threads"],
] as const;
type ListField = typeof listFields[number][0];

let refreshVersion = 0;
let busy = false;
let displayedState: ChatCompactState | undefined;
let displayedChatId: string | undefined;
let displayedMetadata: ChatMetadata | undefined;
let draftDirty = false;
let canSaveDisplayedDraft = false;
let viewMode: "cards" | "json" = "cards";
let jsonEditedSinceCards = false;
const renderedLists = new Map<ListField, { text: string; items: string[] }>();

function element<T extends HTMLElement>(id: string): T {
    const result = document.getElementById(id);
    if (!result) throw new Error(`Missing ContextCompact control: ${id}`);
    return result as T;
}

function report(message: string, error = false): void {
    const status = element<HTMLElement>("contextcompact_memory_status");
    status.textContent = message;
    status.dataset.error = String(error);
}

function toast(message: string, error = false): void {
    const toastr = (globalThis as typeof globalThis & {
        toastr?: { success: (text: string, title?: string) => void; error: (text: string, title?: string) => void };
    }).toastr;
    if (error) toastr?.error(message, "ContextCompact");
    else toastr?.success(message, "ContextCompact");
}

function snapshot(): { chatId: string; metadata: ChatMetadata } {
    const context = SillyTavern.getContext();
    if (!context.chatId) throw new Error(translate("Open a chat first.", "contextcompact.memory.open_chat_first"));
    return { chatId: context.chatId, metadata: context.chatMetadata };
}

function verifySnapshot(expected: { chatId: string; metadata: ChatMetadata }): void {
    const context = SillyTavern.getContext();
    if (context.chatId !== expected.chatId || context.chatMetadata !== expected.metadata) {
        throw new Error(translate("The chat changed. Try again in the current chat.", "contextcompact.memory.chat_changed"));
    }
}

function requireEnabled(): void {
    const context = SillyTavern.getContext();
    if (
        !getSettings().enabled ||
        context.extensionSettings.disabledExtensions.includes(EXTENSION_ID)
    ) {
        throw new Error(translate("Enable ContextCompact first.", "contextcompact.memory.enable_first"));
    }
}

function formatUpdatedAt(value: string): string {
    const language = document.querySelector<HTMLSelectElement>("#ui_language_select")?.value ||
        document.documentElement?.lang || globalThis.navigator?.language || "en";
    return new Intl.DateTimeFormat(language, {
        year: "numeric",
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
    }).format(new Date(value));
}

function listId(field: ListField): string {
    return listFields.find(([name]) => name === field)![1];
}

function readList(field: ListField): string[] {
    const text = element<HTMLTextAreaElement>(listId(field)).value;
    const rendered = renderedLists.get(field);
    if (rendered?.text === text) return [...rendered.items];
    return text.split(/\r?\n/).map((item) => item.trim()).filter(Boolean);
}

function readCards(): StructuredMemory {
    return {
        currentSituation: element<HTMLTextAreaElement>("contextcompact_current_situation").value,
        importantEvents: readList("importantEvents"),
        establishedFacts: readList("establishedFacts"),
        relationships: readList("relationships"),
        openThreads: readList("openThreads"),
    };
}

function syncJsonFromCards(): void {
    element<HTMLTextAreaElement>("contextcompact_memory_json").value =
        JSON.stringify(readCards(), null, 2);
    draftDirty = true;
}

function renderList(field: ListField, items: readonly string[]): void {
    const text = items.join("\n");
    element<HTMLTextAreaElement>(listId(field)).value = text;
    renderedLists.set(field, { text, items: [...items] });
}

function renderCards(memory: StructuredMemory): void {
    element<HTMLTextAreaElement>("contextcompact_current_situation").value = memory.currentSituation;
    for (const [field] of listFields) renderList(field, memory[field]);
}

function setCardControlsDisabled(value: boolean): void {
    for (const control of element<HTMLElement>("contextcompact_memory_cards")
        .querySelectorAll<HTMLTextAreaElement>("textarea")) {
        control.disabled = value;
    }
}

function showView(hasMemory: boolean): void {
    const toggle = element<HTMLButtonElement>("contextcompact_toggle_view");
    toggle.hidden = !hasMemory;
    toggle.disabled = busy || !hasMemory;
    toggle.textContent = viewMode === "cards"
        ? translate("Show JSON", "contextcompact.memory.show_json")
        : translate("Show cards", "contextcompact.memory.show_cards");
    element<HTMLElement>("contextcompact_memory_cards").hidden = !hasMemory || viewMode !== "cards";
    element<HTMLElement>("contextcompact_memory_json_view").hidden = !hasMemory || viewMode !== "json";
}

async function refreshMemory(force = false): Promise<void> {
    const version = ++refreshVersion;
    const context = SillyTavern.getContext();
    const chatId = context.chatId;
    const metadata = context.chatMetadata;
    const textarea = element<HTMLTextAreaElement>("contextcompact_memory_json");
    const saveButton = element<HTMLButtonElement>("contextcompact_save_memory");
    const tokenCountLabel = element<HTMLElement>("contextcompact_memory_token_count");
    if (!chatId) {
        displayedState = undefined;
        displayedChatId = undefined;
        displayedMetadata = undefined;
        draftDirty = false;
        canSaveDisplayedDraft = false;
        viewMode = "cards";
        jsonEditedSinceCards = false;
        renderedLists.clear();
        textarea.value = "";
        saveButton.disabled = true;
        tokenCountLabel.hidden = true;
        tokenCountLabel.textContent = "";
        showView(false);
        report(translate("No chat is open.", "contextcompact.memory.no_chat"), true);
        return;
    }

    const stored = readChatState();
    const checked = await readCurrentChatState();
    let memoryTokens: number | undefined;
    if (stored.status === "valid") {
        try {
            const count = await context.getTokenCountAsync(JSON.stringify(stored.state.memory));
            if (Number.isFinite(count) && count >= 0) memoryTokens = Math.round(count);
        } catch (error) {
            console.warn(`[${MODULE_NAME}] Could not count memory tokens`, error);
        }
    }
    if (
        version !== refreshVersion ||
        SillyTavern.getContext().chatId !== chatId ||
        SillyTavern.getContext().chatMetadata !== metadata
    ) return;

    tokenCountLabel.hidden = memoryTokens === undefined;
    tokenCountLabel.textContent = memoryTokens === undefined
        ? ""
        : translate("token: {count}", "contextcompact.memory.token_count", {
            count: memoryTokens,
        });

    const preserveDraft = !force && draftDirty &&
        displayedChatId === chatId && displayedMetadata === metadata;
    const latestState = checked.status === "valid" ? checked.state : undefined;
    const draftIsCurrent = !preserveDraft || Boolean(
        latestState && displayedState &&
        latestState.revision === displayedState.revision &&
        latestState.sourceDigest === displayedState.sourceDigest &&
        latestState.coveredThrough === displayedState.coveredThrough,
    );
    if (!preserveDraft) {
        if (displayedChatId !== chatId) viewMode = "cards";
        textarea.value = stored.status === "valid"
            ? JSON.stringify(stored.state.memory, null, 2)
            : "";
        displayedState = latestState;
        displayedChatId = chatId;
        displayedMetadata = metadata;
        draftDirty = false;
        jsonEditedSinceCards = false;
    }
    if (preserveDraft && !draftIsCurrent) viewMode = "json";
    const storedMemory = stored.status === "valid" ? stored.state.memory : undefined;
    if (!preserveDraft && storedMemory) renderCards(storedMemory);
    setCardControlsDisabled(busy);
    showView(Boolean(storedMemory));
    canSaveDisplayedDraft = Boolean(latestState && draftIsCurrent);
    saveButton.disabled = busy || !canSaveDisplayedDraft;
    if (preserveDraft && !draftIsCurrent) {
        report(translate(
            "Memory or chat history changed in the background. Copy your draft, refresh, and edit again.",
            "contextcompact.memory.draft_conflict",
        ), true);
        return;
    }
    if (checked.status === "valid") {
        report(translate(
            "First {message} messages compressed\nUpdated {updatedAt} · Version {version}",
            "contextcompact.memory.current_status",
            {
                message: checked.state.coveredThrough + 1,
                version: checked.state.revision + 1,
                updatedAt: formatUpdatedAt(checked.state.updatedAt),
            },
        ));
    } else if (checked.status === "stale") {
        report(translate(
            "Chat history or message version changed. The old memory is stale; you can inspect it and rebuild from chat history.",
            "contextcompact.memory.stale",
        ), true);
    } else if (checked.status === "invalid") {
        report(translate(
            "Saved memory is invalid: {reason}. Rebuild it from chat history or clear it.",
            "contextcompact.memory.invalid",
            { reason: checked.reason },
        ), true);
    } else {
        report(translate(
            "This chat has no memory yet. Once older messages exceed the recent-message limit, use Compact now.",
            "contextcompact.memory.empty",
        ));
    }
}

function setBusy(value: boolean): void {
    busy = value;
    for (const id of buttonIds) element<HTMLButtonElement>(id).disabled = value;
    element<HTMLButtonElement>("contextcompact_save_memory").disabled =
        value || !canSaveDisplayedDraft;
    const toggle = element<HTMLButtonElement>("contextcompact_toggle_view");
    toggle.disabled = value || Boolean(toggle.hidden);
    element<HTMLTextAreaElement>("contextcompact_memory_json").disabled = value;
    setCardControlsDisabled(value);
}

async function runOperation(
    action: () => Promise<void | boolean>,
    successMessage: string,
): Promise<void> {
    if (busy) return;
    setBusy(true);
    let completed = false;
    try {
        const performed = await action();
        if (performed === false) return;
        completed = true;
        clearGenerationMemoryPrompt();
        toast(successMessage);
    } catch (error) {
        console.error(`[${MODULE_NAME}] Memory operation failed`, error);
        const message = error instanceof Error ? error.message : String(error);
        toast(message, true);
    } finally {
        setBusy(false);
        await refreshMemory(completed);
    }
}

async function confirmAction(title: string, description: string): Promise<boolean> {
    const context = SillyTavern.getContext();
    return (await context.Popup.show.confirm(title, description)) ===
        context.POPUP_RESULT.AFFIRMATIVE;
}

export function initializeMemoryPanel(): void {
    element<HTMLTextAreaElement>("contextcompact_current_situation").setAttribute(
        "aria-label",
        translate("Current situation", "contextcompact.memory.current_situation"),
    );
    element<HTMLTextAreaElement>("contextcompact_current_situation").addEventListener("input", syncJsonFromCards);
    for (const [, id, label] of listFields) {
        const input = element<HTMLTextAreaElement>(id);
        input.setAttribute("aria-label", translate(label, `contextcompact.memory.${id.slice("contextcompact_".length)}`));
        input.placeholder = translate("One item per line", "contextcompact.memory.one_item_per_line");
        input.addEventListener("input", syncJsonFromCards);
    }
    element<HTMLButtonElement>("contextcompact_toggle_view").addEventListener("click", () => {
        if (busy) return;
        if (viewMode === "cards") {
            jsonEditedSinceCards = false;
            viewMode = "json";
        } else {
            if (jsonEditedSinceCards) {
                try {
                    renderCards(parseStructuredMemoryJson(element<HTMLTextAreaElement>("contextcompact_memory_json").value));
                } catch (error) {
                    toast(error instanceof Error ? error.message : String(error), true);
                    return;
                }
            }
            jsonEditedSinceCards = false;
            viewMode = "cards";
        }
        showView(true);
        element<HTMLButtonElement>("contextcompact_save_memory").disabled =
            !canSaveDisplayedDraft;
    });
    element<HTMLButtonElement>("contextcompact_refresh").addEventListener("click", () => {
        void refreshMemory(true);
    });
    element<HTMLTextAreaElement>("contextcompact_memory_json").addEventListener("input", () => {
        draftDirty = true;
        jsonEditedSinceCards = true;
    });
    element<HTMLButtonElement>("contextcompact_save_memory").addEventListener("click", () => {
        const text = element<HTMLTextAreaElement>("contextcompact_memory_json").value;
        const expectedMemory = displayedState;
        void runOperation(async () => {
            const expected = snapshot();
            if (!expectedMemory) throw new Error(translate("Memory is stale. Refresh and rebuild it.", "contextcompact.memory.edit_stale"));
            verifySnapshot(expected);
            await editCurrentMemory(text, expectedMemory);
        }, translate("Memory saved.", "contextcompact.memory.saved"));
    });
    element<HTMLButtonElement>("contextcompact_compact").addEventListener("click", () => {
        void runOperation(async () => {
            const expected = snapshot();
            requireEnabled();
            verifySnapshot(expected);
            await compactCurrentChat(getSettings(), "manual");
        }, translate("Memory compaction complete.", "contextcompact.memory.compacted"));
    });
    element<HTMLButtonElement>("contextcompact_rebuild").addEventListener("click", () => {
        void runOperation(async () => {
            const expected = snapshot();
            requireEnabled();
            if (!await confirmAction(
                translate("Rebuild memory from chat history", "contextcompact.memory.rebuild_confirm_title"),
                translate("This replaces saved memory for this chat. The original chat history is kept. Continue?", "contextcompact.memory.rebuild_confirm_body"),
            )) return false;
            verifySnapshot(expected);
            await compactCurrentChat(getSettings(), "manual", true);
        }, translate("Memory rebuilt from chat history.", "contextcompact.memory.rebuilt"));
    });
    element<HTMLButtonElement>("contextcompact_clear").addEventListener("click", () => {
        void runOperation(async () => {
            const expected = snapshot();
            if (!await confirmAction(
                translate("Clear memory", "contextcompact.memory.clear_confirm_title"),
                translate("This deletes saved memory for this chat. Future generations will use the full chat history. Continue?", "contextcompact.memory.clear_confirm_body"),
            )) return false;
            verifySnapshot(expected);
            await clearCurrentMemory();
        }, translate("Memory cleared.", "contextcompact.memory.cleared"));
    });

    const { eventSource, eventTypes } = SillyTavern.getContext();
    for (const type of [
        eventTypes.CHAT_CHANGED,
        eventTypes.CHAT_LOADED,
        eventTypes.MESSAGE_EDITED,
        eventTypes.MESSAGE_UPDATED,
        eventTypes.MESSAGE_DELETED,
        eventTypes.MESSAGE_SWIPED,
        eventTypes.IMAGE_SWIPED,
        eventTypes.MESSAGE_SWIPE_DELETED,
        eventTypes.MESSAGE_REASONING_EDITED,
        eventTypes.MESSAGE_REASONING_DELETED,
        eventTypes.MESSAGE_RECEIVED,
    ]) {
        eventSource.on(type, () => { void refreshMemory(); });
    }
    void refreshMemory();
}
