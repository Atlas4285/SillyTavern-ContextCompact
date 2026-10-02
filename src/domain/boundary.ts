import type { ChatCompactState } from "./memory";

export interface SourceMessage {
    name?: string;
    mes?: string;
    is_user?: boolean;
    is_system?: boolean;
    swipe_id?: number;
    extra?: {
        title?: string;
        append_title?: boolean;
        reasoning?: string;
        tool_invocations?: unknown;
        files?: unknown;
        file?: unknown;
        media?: unknown;
        image?: unknown;
        video?: unknown;
        image_swipes?: unknown;
    };
}

function serializeCoveredPrefix(
    messages: readonly SourceMessage[],
    coveredThrough: number,
): string {
    if (
        !Number.isSafeInteger(coveredThrough) ||
        coveredThrough < 0 ||
        coveredThrough >= messages.length
    ) {
        throw new RangeError("coveredThrough is outside the chat");
    }

    return JSON.stringify(
        messages.slice(0, coveredThrough + 1).map((message, index) => ({
            index,
            name: message.name ?? null,
            mes: message.mes ?? null,
            isUser: message.is_user === true,
            isSystem: message.is_system === true,
            swipeId: message.swipe_id ?? null,
            extra: {
                title: message.extra?.title ?? null,
                appendTitle: message.extra?.append_title ?? null,
                reasoning: message.extra?.reasoning ?? null,
                toolInvocations: message.extra?.tool_invocations ?? null,
                files: message.extra?.files ?? null,
                file: message.extra?.file ?? null,
                media: message.extra?.media ?? null,
                image: message.extra?.image ?? null,
                video: message.extra?.video ?? null,
                imageSwipes: message.extra?.image_swipes ?? null,
            },
        })),
    );
}

function fallbackDigest(text: string): string {
    const hashes = [0x811c9dc5, 0x9e3779b9, 0x85ebca6b, 0xc2b2ae35];
    const primes = [0x01000193, 0x27d4eb2f, 0x165667b1, 0x85ebca77];

    for (let index = 0; index < text.length; index++) {
        const code = text.charCodeAt(index);
        for (let part = 0; part < hashes.length; part++) {
            hashes[part] = Math.imul(hashes[part] ^ code, primes[part]);
        }
    }

    return `fnv128:${hashes
        .map((hash) => (hash >>> 0).toString(16).padStart(8, "0"))
        .join("")}`;
}

export async function getCoveredPrefixDigest(
    messages: readonly SourceMessage[],
    coveredThrough: number,
): Promise<string> {
    const serialized = serializeCoveredPrefix(messages, coveredThrough);
    const subtle = globalThis.crypto?.subtle;
    if (subtle) {
        try {
            const bytes = new TextEncoder().encode(serialized);
            const digest = await subtle.digest("SHA-256", bytes);
            const hex = Array.from(new Uint8Array(digest))
                .map((byte) => byte.toString(16).padStart(2, "0"))
                .join("");
            return `sha256:${hex}`;
        } catch {
            // Browsers without usable Web Crypto still need edit detection.
        }
    }
    return fallbackDigest(serialized);
}

export async function isCoveredSourceCurrent(
    state: ChatCompactState,
    messages: readonly SourceMessage[],
): Promise<boolean> {
    if (state.coveredThrough >= messages.length) {
        return false;
    }
    return (
        state.sourceDigest ===
        (await getCoveredPrefixDigest(messages, state.coveredThrough))
    );
}
