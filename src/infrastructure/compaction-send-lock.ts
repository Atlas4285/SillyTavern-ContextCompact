let lockCount = 0;
let releaseInterface: (() => void) | undefined;
const waiters = new Set<() => void>();

function blockSendClick(event: MouseEvent): void {
    const target = event.target as Element | null;
    if (!target?.closest?.("#send_but, #option_regenerate, #option_continue, #mes_continue, #mes_impersonate")) {
        return;
    }
    event.preventDefault();
    event.stopImmediatePropagation();
}

function blockSendHotkey(event: KeyboardEvent): void {
    if (event.key !== "Enter" || event.isComposing) return;
    const target = event.target as HTMLElement | null;
    if (!event.ctrlKey && !event.altKey) {
        if (event.shiftKey || target?.id !== "send_textarea") return;
        const context = SillyTavern.getContext() as ReturnType<typeof SillyTavern.getContext> & {
            shouldSendOnEnter?: () => boolean;
        };
        if (!context.shouldSendOnEnter?.()) return;
    }
    event.preventDefault();
    event.stopImmediatePropagation();
}

function lockInterface(): () => void {
    if (typeof document === "undefined") return () => undefined;
    const sendButton = document.querySelector<HTMLElement>("#send_but");
    const wasInert = sendButton?.inert;
    if (sendButton) {
        sendButton.inert = true;
        sendButton.classList?.add("contextcompact-send-locked");
    }
    document.addEventListener?.("click", blockSendClick, true);
    document.addEventListener?.("keydown", blockSendHotkey, true);
    return () => {
        document.removeEventListener?.("click", blockSendClick, true);
        document.removeEventListener?.("keydown", blockSendHotkey, true);
        if (sendButton) {
            sendButton.inert = wasInert ?? false;
            sendButton.classList?.remove("contextcompact-send-locked");
        }
    };
}

export function blockSendingDuringCompaction(): () => void {
    if (lockCount === 0) releaseInterface = lockInterface();
    lockCount++;
    let released = false;
    return () => {
        if (released) return;
        released = true;
        if (--lockCount !== 0) return;
        releaseInterface?.();
        releaseInterface = undefined;
        for (const resolve of waiters) resolve();
        waiters.clear();
    };
}

export async function waitForCompactionSendUnlock(): Promise<void> {
    while (lockCount > 0) {
        await new Promise<void>((resolve) => waiters.add(resolve));
    }
}
