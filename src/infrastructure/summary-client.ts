import {
    MemoryValidationError,
    parseStructuredMemoryJson,
    validateStructuredMemory,
    type StructuredMemory,
} from "../domain/memory";
import {
    buildSummaryInput,
    buildSummaryInstruction,
    buildTextCompletionSummaryPrompt,
    type MemorySourceMessage,
    type SystemPromptMessage,
} from "../domain/prompt";
import type { ContextCompactSettings } from "../domain/settings";
import { translate } from "../i18n";

const REQUEST_TIMEOUT_MS = 90_000;

export interface SummaryRequest {
    previousMemory?: StructuredMemory;
    systemMessages: readonly SystemPromptMessage[];
    messages: readonly MemorySourceMessage[];
    settings: ContextCompactSettings;
    signal?: AbortSignal;
}

function getResponseContent(response: unknown): unknown {
    if (
        typeof response === "object" &&
        response !== null &&
        "content" in response
    ) {
        return response.content;
    }
    throw new Error("Summary response has no content");
}

function parseResponse(response: unknown): StructuredMemory {
    const content = getResponseContent(response);
    if (typeof content === "string") {
        const trimmed = content.trim();
        const json = trimmed.startsWith("```")
            ? trimmed.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "")
            : trimmed;
        return parseStructuredMemoryJson(json);
    }
    return validateStructuredMemory(content);
}

function withTimeout(parentSignal?: AbortSignal): {
    signal: AbortSignal;
    cleanup: () => void;
} {
    const controller = new AbortController();
    const abortFromParent = () => controller.abort(parentSignal?.reason);
    if (parentSignal?.aborted) {
        abortFromParent();
    } else {
        parentSignal?.addEventListener("abort", abortFromParent, { once: true });
    }
    const timeout = globalThis.setTimeout(
        () => controller.abort(new Error("Summary request timed out")),
        REQUEST_TIMEOUT_MS,
    );
    return {
        signal: controller.signal,
        cleanup: () => {
            globalThis.clearTimeout(timeout);
            parentSignal?.removeEventListener("abort", abortFromParent);
        },
    };
}

async function requestChatCompletion(
    instruction: string,
    input: string,
    model: string,
    signal: AbortSignal,
): Promise<unknown> {
    const context = SillyTavern.getContext();
    const messages = [
        { role: "system", content: instruction },
        { role: "user", content: input },
    ];
    const payload = await context.ChatCompletionService.presetToGeneratePayload(
        {},
        {},
        { messages, model },
    );

    payload.messages = messages;
    payload.stream = false;
    payload.n = 1;
    delete payload.stop;
    delete payload.logit_bias;
    payload.enable_web_search = false;
    payload.request_images = false;
    payload.include_reasoning = false;
    payload.custom_prompt_post_processing = "";
    payload.custom_include_body = "";
    payload.custom_exclude_body = "";
    delete payload.tools;
    delete payload.tool_choice;
    delete payload.max_tokens;
    delete payload.max_completion_tokens;
    delete payload.json_schema;

    return context.ChatCompletionService.sendRequest(payload, true, signal);
}

async function requestTextCompletion(
    instruction: string,
    input: string,
    model: string | undefined,
    signal: AbortSignal,
): Promise<unknown> {
    const context = SillyTavern.getContext();
    const prompt = buildTextCompletionSummaryPrompt(instruction, input);
    const payload = context.TextCompletionService.presetToGeneratePayload(
        {},
        {},
        {
            prompt,
            ...(model ? { model } : {}),
        },
    );

    payload.prompt = prompt;
    payload.stream = false;
    delete payload.max_tokens;
    delete payload.max_new_tokens;
    delete payload.n_predict;
    delete payload.num_predict;
    payload.stop = [];
    payload.stopping_strings = [];
    delete payload.ban_eos_token;
    delete payload.ignore_eos;
    payload.negative_prompt = "";
    payload.guidance_scale = 1;
    delete payload.min_tokens;
    delete payload.min_length;
    delete payload.minimum_message_content_tokens;
    payload.include_reasoning = false;
    payload.custom_token_bans = [];
    payload.banned_strings = [];
    delete payload.logit_bias;
    payload.grammar_string = undefined;
    payload.grammar = undefined;
    payload.guided_grammar = undefined;
    delete payload.guided_json;
    delete payload.json_schema;

    return context.TextCompletionService.sendRequest(payload, true, signal);
}

async function requestProfileCompletion(
    profileId: string,
    api: "openai" | "textgenerationwebui",
    instruction: string,
    input: string,
    signal: AbortSignal,
): Promise<unknown> {
    const service = SillyTavern.getContext().ConnectionManagerRequestService;
    if (api === "openai") {
        const messages = [
            { role: "system", content: instruction },
            { role: "user", content: input },
        ];
        return service.sendRequest(profileId, messages, undefined, {
            stream: false,
            signal,
            extractData: true,
            includePreset: false,
            includeInstruct: false,
        }, {
            messages,
            custom_prompt_post_processing: "",
            custom_include_body: "",
            custom_exclude_body: "",
            enable_web_search: false,
            request_images: false,
            include_reasoning: false,
            n: 1,
            tools: undefined,
            tool_choice: undefined,
        });
    }
    const prompt = buildTextCompletionSummaryPrompt(instruction, input);
    return service.sendRequest(profileId, prompt, undefined, {
        stream: false,
        signal,
        extractData: true,
        includePreset: false,
        includeInstruct: false,
    }, {
        prompt,
        stop: [],
        stopping_strings: [],
        negative_prompt: "",
        include_reasoning: false,
    });
}

function isRetryableOutputError(error: unknown): boolean {
    return error instanceof MemoryValidationError ||
        (error instanceof Error && [
            "Summary response has no content",
        ].includes(error.message));
}

export async function summarizeMessages(request: SummaryRequest): Promise<StructuredMemory> {
    const context = SillyTavern.getContext();
    const selected = request.settings.model;
    const profile = selected.kind === "profile"
        ? context.ConnectionManagerRequestService.getProfile(selected.profileId)
        : undefined;
    const profileApi = profile
        ? context.ConnectionManagerRequestService.validateProfile(profile)
        : undefined;
    const api = selected.kind === "current"
        ? context.mainApi
        : selected.kind === "profile"
            ? profileApi?.selected
            : selected.provider.startsWith("chat:")
                ? "openai"
                : selected.provider.startsWith("text:")
                    ? "textgenerationwebui"
                    : "unsupported";
    if (api !== "openai" && api !== "textgenerationwebui") {
        throw new Error(`Summary is not supported for API: ${api}`);
    }
    if (selected.kind === "custom") {
        const configured = api === "openai"
            ? `chat:${context.chatCompletionSettings.chat_completion_source}`
            : `text:${context.textCompletionSettings.type}`;
        if (selected.provider !== configured) {
            throw new Error(`The selected summary provider is unavailable: ${selected.provider}`);
        }
    }
    if (selected.kind === "profile") {
        const supported = context.ConnectionManagerRequestService.getSupportedProfiles();
        if (!supported.some((item: { id: string }) => item.id === selected.profileId)) {
            throw new Error("The selected connection profile is no longer supported");
        }
        if (!profile?.model && api === "openai") {
            throw new Error("The selected connection profile has no model");
        }
    }
    const model = selected.kind === "custom"
        ? selected.model
        : selected.kind === "profile"
            ? profile?.model
            : api === "openai"
                ? context.getChatCompletionModel()
                : undefined;
    if (api === "openai" && !model) {
        throw new Error("No Chat Completion model is selected for summarization");
    }

    const instruction = buildSummaryInstruction(
        request.settings.summaryLanguage,
        request.settings.targetMemoryTokens,
        request.settings.summaryPrompt,
    );
    const input = buildSummaryInput(request.previousMemory, request.systemMessages, request.messages);
    let lastError: unknown;

    for (let attempt = 0; attempt < 2; attempt++) {
        const { signal, cleanup } = withTimeout(request.signal);
        let requestCompleted = false;
        try {
            signal.throwIfAborted();
            const response = selected.kind === "profile"
                ? await requestProfileCompletion(
                    selected.profileId,
                    api,
                    instruction,
                    input,
                    signal,
                )
                : api === "openai"
                    ? await requestChatCompletion(
                        instruction,
                        input,
                        model as string,
                        signal,
                    )
                    : await requestTextCompletion(
                        instruction,
                        input,
                        model,
                        signal,
                    );
            requestCompleted = true;
            const memory = parseResponse(response);
            const [inputTokens, memoryTokens] = await Promise.all([
                context.getTokenCountAsync(input),
                context.getTokenCountAsync(JSON.stringify(memory)),
            ]);
            if (memoryTokens > inputTokens) {
                throw new Error(translate(
                    "Summary is longer than the input being compressed ({memoryTokens} > {inputTokens} tokens)",
                    "contextcompact.memory.summary_longer_than_input",
                    { memoryTokens, inputTokens },
                ));
            }
            return memory;
        } catch (error) {
            lastError = error;
            if (signal.aborted) {
                throw signal.reason instanceof Error ? signal.reason : error;
            }
            if (!requestCompleted || !isRetryableOutputError(error)) {
                throw error;
            }
        } finally {
            cleanup();
        }
    }

    throw lastError instanceof Error ? lastError : new Error("Summary failed");
}
