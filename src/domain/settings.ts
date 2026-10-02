export type CompactMode = "before_send" | "after_reply" | "manual";
export type TriggerMode = "ratio" | "tokens" | "rounds";

export type SummaryModel =
    | { kind: "current" }
    | { kind: "profile"; profileId: string }
    | { kind: "custom"; provider: string; model: string };

export interface ContextCompactSettings {
    enabled: boolean;
    mode: CompactMode;
    triggerMode: TriggerMode;
    triggerRatio: number;
    triggerTokens: number;
    triggerRounds: number;
    recentRoundCount: number;
    targetMemoryTokens: number;
    model: SummaryModel;
    summaryLanguage: string;
    summaryPrompt?: string;
    injectionPrompt?: string;
}

export const DEFAULT_SETTINGS: Readonly<ContextCompactSettings> = {
    enabled: true,
    mode: "before_send",
    triggerMode: "ratio",
    triggerRatio: 0.6,
    triggerTokens: 128000,
    triggerRounds: 1,
    recentRoundCount: 10,
    targetMemoryTokens: 1000,
    model: { kind: "current" },
    summaryLanguage: "auto",
};

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseNumber(
    value: unknown,
    field: string,
    min: number,
    max: number,
    integer = false,
): number {
    if (
        typeof value !== "number" ||
        !Number.isFinite(value) ||
        value < min ||
        value > max ||
        (integer && !Number.isInteger(value))
    ) {
        throw new Error(`Invalid ContextCompact setting: ${field}`);
    }
    return value;
}

function parseModel(value: unknown): SummaryModel {
    if (!isRecord(value)) {
        throw new Error("Invalid ContextCompact setting: model");
    }
    if (value.kind === "current") {
        return { kind: "current" };
    }
    if (
        value.kind === "profile" &&
        typeof value.profileId === "string" &&
        value.profileId.trim().length > 0 &&
        value.profileId.length <= 200
    ) {
        return { kind: "profile", profileId: value.profileId.trim() };
    }
    if (
        value.kind === "custom" &&
        typeof value.provider === "string" &&
        value.provider.trim().length > 0 &&
        value.provider.length <= 100 &&
        typeof value.model === "string" &&
        value.model.trim().length > 0 &&
        value.model.length <= 200
    ) {
        return {
            kind: "custom",
            provider: value.provider.trim(),
            model: value.model.trim(),
        };
    }
    throw new Error("Invalid ContextCompact setting: model");
}

export function validateSettings(value: unknown): ContextCompactSettings {
    if (!isRecord(value)) {
        throw new Error("Invalid ContextCompact settings");
    }

    const mode = value.mode ?? DEFAULT_SETTINGS.mode;
    if (mode !== "before_send" && mode !== "after_reply" && mode !== "manual") {
        throw new Error("Invalid ContextCompact setting: mode");
    }
    const triggerMode = value.triggerMode ?? DEFAULT_SETTINGS.triggerMode;
    if (triggerMode !== "ratio" && triggerMode !== "tokens" && triggerMode !== "rounds") {
        throw new Error("Invalid ContextCompact setting: triggerMode");
    }

    const enabled = value.enabled ?? DEFAULT_SETTINGS.enabled;
    if (typeof enabled !== "boolean") {
        throw new Error("Invalid ContextCompact setting: enabled");
    }

    const summaryLanguage = value.summaryLanguage ?? DEFAULT_SETTINGS.summaryLanguage;
    if (
        typeof summaryLanguage !== "string" ||
        summaryLanguage.trim().length === 0 ||
        summaryLanguage.length > 40
    ) {
        throw new Error("Invalid ContextCompact setting: summaryLanguage");
    }
    const summaryPrompt = value.summaryPrompt;
    if (
        summaryPrompt !== undefined &&
        (typeof summaryPrompt !== "string" ||
            !summaryPrompt.trim() ||
            summaryPrompt.length > 10000)
    ) {
        throw new Error("Invalid ContextCompact setting: summaryPrompt");
    }
    const injectionPrompt = value.injectionPrompt;
    if (
        injectionPrompt !== undefined &&
        (typeof injectionPrompt !== "string" ||
            !injectionPrompt.trim() ||
            injectionPrompt.length > 10000)
    ) {
        throw new Error("Invalid ContextCompact setting: injectionPrompt");
    }

    return {
        enabled,
        mode,
        triggerMode,
        triggerRatio: parseNumber(
            value.triggerRatio ?? DEFAULT_SETTINGS.triggerRatio,
            "triggerRatio",
            0.2,
            0.9,
        ),
        triggerTokens: parseNumber(
            value.triggerTokens ?? DEFAULT_SETTINGS.triggerTokens,
            "triggerTokens",
            256,
            1000000,
            true,
        ),
        triggerRounds: parseNumber(
            value.triggerRounds ?? DEFAULT_SETTINGS.triggerRounds,
            "triggerRounds",
            1,
            1000,
            true,
        ),
        recentRoundCount: parseNumber(
            value.recentRoundCount ?? value.recentMessageCount ?? DEFAULT_SETTINGS.recentRoundCount,
            "recentRoundCount",
            1,
            100,
            true,
        ),
        targetMemoryTokens: parseNumber(
            value.targetMemoryTokens ?? DEFAULT_SETTINGS.targetMemoryTokens,
            "targetMemoryTokens",
            100,
            8000,
            true,
        ),
        model: parseModel(value.model ?? DEFAULT_SETTINGS.model),
        summaryLanguage: summaryLanguage.trim(),
        ...(summaryPrompt === undefined ? {} : { summaryPrompt }),
        ...(injectionPrompt === undefined ? {} : { injectionPrompt }),
    };
}

export function createDefaultSettings(): ContextCompactSettings {
    return validateSettings(DEFAULT_SETTINGS);
}
