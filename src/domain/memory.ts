export interface StructuredMemory {
    currentSituation: string;
    importantEvents: string[];
    establishedFacts: string[];
    relationships: string[];
    openThreads: string[];
}

export interface ChatCompactState {
    schemaVersion: 1;
    coveredThrough: number;
    sourceDigest: string;
    memory: StructuredMemory;
    revision: number;
    updatedAt: string;
    lastCompactionUserIndex?: number;
}

const ARRAY_FIELDS = [
    "importantEvents",
    "establishedFacts",
    "relationships",
    "openThreads",
] as const;
const MAX_SITUATION_LENGTH = 2000;
const MAX_ITEMS_PER_FIELD = 30;
const MAX_ITEM_LENGTH = 500;
const DIGEST_PATTERN = /^(sha256:[0-9a-f]{64}|fnv128:[0-9a-f]{32})$/;

export const STRUCTURED_MEMORY_JSON_SCHEMA = {
    type: "object",
    additionalProperties: false,
    required: ["currentSituation", ...ARRAY_FIELDS],
    properties: {
        currentSituation: { type: "string" },
        importantEvents: { type: "array", items: { type: "string" } },
        establishedFacts: { type: "array", items: { type: "string" } },
        relationships: { type: "array", items: { type: "string" } },
        openThreads: { type: "array", items: { type: "string" } },
    },
} as const;

export class MemoryValidationError extends Error {
    constructor(path: string, reason: string) {
        super(`${path}: ${reason}`);
        this.name = "MemoryValidationError";
    }
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseText(value: unknown, path: string, maxLength: number): string {
    if (typeof value !== "string") {
        throw new MemoryValidationError(path, "expected a string");
    }

    const text = value.trim();
    if (!text) {
        throw new MemoryValidationError(path, "must not be empty");
    }
    if (text.length > maxLength) {
        throw new MemoryValidationError(path, `exceeds ${maxLength} characters`);
    }
    return text;
}

function parseTextList(value: unknown, path: string): string[] {
    if (!Array.isArray(value) || value.length > MAX_ITEMS_PER_FIELD) {
        throw new MemoryValidationError(
            path,
            `expected an array of at most ${MAX_ITEMS_PER_FIELD} items`,
        );
    }

    const seen = new Set<string>();
    const items: string[] = [];
    for (const [index, rawItem] of value.entries()) {
        const item = parseText(rawItem, `${path}[${index}]`, MAX_ITEM_LENGTH);
        const key = item.normalize("NFKC").toLocaleLowerCase();
        if (!seen.has(key)) {
            seen.add(key);
            items.push(item);
        }
    }
    return items;
}

export function validateStructuredMemory(value: unknown): StructuredMemory {
    if (!isRecord(value)) {
        throw new MemoryValidationError("memory", "expected an object");
    }

    const expectedFields = new Set<string>(["currentSituation", ...ARRAY_FIELDS]);
    if (Object.keys(value).some((key) => !expectedFields.has(key))) {
        throw new MemoryValidationError("memory", "contains an unknown field");
    }

    return {
        currentSituation: parseText(
            value.currentSituation,
            "memory.currentSituation",
            MAX_SITUATION_LENGTH,
        ),
        importantEvents: parseTextList(
            value.importantEvents,
            "memory.importantEvents",
        ),
        establishedFacts: parseTextList(
            value.establishedFacts,
            "memory.establishedFacts",
        ),
        relationships: parseTextList(
            value.relationships,
            "memory.relationships",
        ),
        openThreads: parseTextList(value.openThreads, "memory.openThreads"),
    };
}

export function parseStructuredMemoryJson(text: string): StructuredMemory {
    let value: unknown;
    try {
        value = JSON.parse(text);
    } catch {
        throw new MemoryValidationError("memory", "invalid JSON");
    }
    return validateStructuredMemory(value);
}

export function validateChatCompactState(value: unknown): ChatCompactState {
    if (!isRecord(value) || value.schemaVersion !== 1) {
        throw new MemoryValidationError("state", "unsupported schema version");
    }
    if (
        !Number.isSafeInteger(value.coveredThrough) ||
        (value.coveredThrough as number) < 0
    ) {
        throw new MemoryValidationError("state.coveredThrough", "invalid index");
    }
    if (typeof value.sourceDigest !== "string" || !DIGEST_PATTERN.test(value.sourceDigest)) {
        throw new MemoryValidationError("state.sourceDigest", "invalid digest");
    }
    if (!Number.isSafeInteger(value.revision) || (value.revision as number) < 0) {
        throw new MemoryValidationError("state.revision", "invalid revision");
    }
    if (
        value.lastCompactionUserIndex !== undefined &&
        (!Number.isSafeInteger(value.lastCompactionUserIndex) ||
            (value.lastCompactionUserIndex as number) < -1)
    ) {
        throw new MemoryValidationError("state.lastCompactionUserIndex", "invalid index");
    }
    if (
        typeof value.updatedAt !== "string" ||
        !Number.isFinite(Date.parse(value.updatedAt)) ||
        new Date(value.updatedAt).toISOString() !== value.updatedAt
    ) {
        throw new MemoryValidationError("state.updatedAt", "invalid timestamp");
    }

    return {
        schemaVersion: 1,
        coveredThrough: value.coveredThrough as number,
        sourceDigest: value.sourceDigest,
        memory: validateStructuredMemory(value.memory),
        revision: value.revision as number,
        updatedAt: value.updatedAt,
        ...(value.lastCompactionUserIndex === undefined
            ? {}
            : { lastCompactionUserIndex: value.lastCompactionUserIndex as number }),
    };
}
