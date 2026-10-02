import settingsHtml from "./settings.html";
import { cancelCompactions } from "../application/compaction-coordinator";
import { MODULE_NAME } from "../constants";
import {
    getLocalizedDefaultInjectionPrompt,
    getLocalizedDefaultSummaryPrompt,
} from "../domain/prompt";
import { type ContextCompactSettings } from "../domain/settings";
import { translate } from "../i18n";
import { clearGenerationMemoryPrompt } from "../infrastructure/generation-interceptor";
import { getSettings, saveSettings } from "../infrastructure/settings-store";
import { initializeMemoryPanel } from "./memory-panel";

let profileListError: string | undefined;
let customPromptDraft: string | undefined;
let customInjectionPromptDraft: string | undefined;

function element<T extends HTMLElement>(id: string): T {
    const result = document.getElementById(id);
    if (!result) throw new Error(`Missing ContextCompact control: ${id}`);
    return result as T;
}

function appendOption(select: HTMLSelectElement, label: string, value: string): void {
    select.add(new Option(label, value));
}

function renderLanguages(selected: string): void {
    const select = element<HTMLSelectElement>("contextcompact_language");
    select.replaceChildren();
    appendOption(select, translate("Auto (match chat language)", "contextcompact.settings.language_auto"), "auto");
    const source = document.querySelector<HTMLSelectElement>("#ui_language_select");
    const languages = source?.options.length
        ? Array.from(source.options).filter((option) => option.value)
        : [
            new Option("English", "en"),
            new Option(translate("Simplified Chinese", "contextcompact.settings.simplified_chinese"), "zh-cn"),
        ];
    for (const language of languages) {
        if (!Array.from(select.options).some((option) => option.value === language.value)) {
            appendOption(select, language.textContent || language.value, language.value);
        }
    }
    if (!Array.from(select.options).some((option) => option.value === selected)) {
        appendOption(select, translate("Previous language setting: {language}", "contextcompact.settings.previous_language", { language: selected }), selected);
    }
    select.value = selected;
}

function supportedProfiles(): Array<{ id: string; name?: string; model?: string; api?: string }> {
    try {
        profileListError = undefined;
        return SillyTavern.getContext().ConnectionManagerRequestService.getSupportedProfiles();
    } catch (error) {
        profileListError = error instanceof Error ? error.message : String(error);
        return [];
    }
}

function selectedModelValue(settings: ContextCompactSettings): string {
    if (settings.model.kind === "current") return "current";
    if (settings.model.kind === "profile") return `profile:${settings.model.profileId}`;
    return "legacy";
}

function renderModels(selected: string): void {
    const select = element<HTMLSelectElement>("contextcompact_model_select");
    select.replaceChildren();
    appendOption(select, translate("Current chat model", "contextcompact.settings.current_model"), "current");
    for (const profile of supportedProfiles()) {
        const label = profile.name || profile.model || profile.id;
        const detail = profile.model || profile.api || translate("No model specified", "contextcompact.settings.no_model");
        appendOption(select, `${label} · ${detail}`, `profile:${profile.id}`);
    }
    if (selected === "legacy") {
        appendOption(select, translate("Previous custom model setting (choose again)", "contextcompact.settings.legacy_model"), selected);
    } else if (
        selected !== "current" &&
        !Array.from(select.options).some((option) => option.value === selected)
    ) {
        appendOption(select, translate("Connection profile unavailable: {id}", "contextcompact.settings.profile_unavailable_option", { id: selected.slice(8) }), selected);
    }
    select.value = selected;
}

function showModelStatus(): void {
    const selected = element<HTMLSelectElement>("contextcompact_model_select").value;
    const status = element<HTMLElement>("contextcompact_model_status");
    if (selected === "current") {
        status.textContent = "";
        status.dataset.error = "false";
        return;
    }
    const profile = supportedProfiles().find((item) => `profile:${item.id}` === selected);
    if (!profile) {
        status.textContent = profileListError
            ? translate("API connection profiles are unavailable: {reason}", "contextcompact.settings.profiles_unavailable", { reason: profileListError })
            : translate("The selected API connection profile was deleted or is unavailable. Choose another profile.", "contextcompact.settings.selected_profile_unavailable");
        status.dataset.error = "true";
        return;
    }
    status.textContent = "";
    status.dataset.error = "false";
}

function showTriggerMode(): void {
    const mode = element<HTMLSelectElement>("contextcompact_trigger_mode").value;
    for (const [value, labelId, inputId] of [
        ["ratio", "contextcompact_trigger_ratio_label", "contextcompact_trigger"],
        ["tokens", "contextcompact_trigger_tokens_label", "contextcompact_trigger_tokens"],
        ["rounds", "contextcompact_trigger_rounds_label", "contextcompact_trigger_rounds"],
    ]) {
        const hidden = mode !== value;
        element<HTMLLabelElement>(labelId).hidden = hidden;
        const input = element<HTMLInputElement>(inputId);
        input.hidden = hidden;
        input.disabled = hidden;
    }
}

function showSummaryPrompt(): void {
    const useDefault = element<HTMLInputElement>("contextcompact_prompt_use_default").checked;
    const input = element<HTMLTextAreaElement>("contextcompact_summary_prompt");
    if (useDefault) {
        if (!input.disabled) customPromptDraft = input.value;
        input.value = getLocalizedDefaultSummaryPrompt();
        input.disabled = true;
    } else {
        if (input.disabled) input.value = customPromptDraft ?? getLocalizedDefaultSummaryPrompt();
        input.disabled = false;
    }
}

function showInjectionPrompt(): void {
    const useDefault = element<HTMLInputElement>("contextcompact_injection_prompt_use_default").checked;
    const input = element<HTMLTextAreaElement>("contextcompact_injection_prompt");
    if (useDefault) {
        if (!input.disabled) customInjectionPromptDraft = input.value;
        input.value = getLocalizedDefaultInjectionPrompt();
        input.disabled = true;
    } else {
        if (input.disabled) input.value = customInjectionPromptDraft ?? getLocalizedDefaultInjectionPrompt();
        input.disabled = false;
    }
}

function loadSettings(): void {
    const settings = getSettings();
    element<HTMLInputElement>("contextcompact_enabled").checked = settings.enabled;
    element<HTMLSelectElement>("contextcompact_mode").value = settings.mode;
    element<HTMLSelectElement>("contextcompact_trigger_mode").value = settings.triggerMode;
    element<HTMLInputElement>("contextcompact_trigger").value = String(settings.triggerRatio);
    element<HTMLInputElement>("contextcompact_trigger_tokens").value = String(settings.triggerTokens);
    element<HTMLInputElement>("contextcompact_trigger_rounds").value = String(settings.triggerRounds);
    showTriggerMode();
    element<HTMLInputElement>("contextcompact_recent").value = String(settings.recentRoundCount);
    element<HTMLInputElement>("contextcompact_target").value = String(settings.targetMemoryTokens);
    renderLanguages(settings.summaryLanguage);
    renderModels(selectedModelValue(settings));
    showModelStatus();
    customPromptDraft = settings.summaryPrompt;
    element<HTMLInputElement>("contextcompact_prompt_use_default").checked =
        settings.summaryPrompt === undefined;
    const prompt = element<HTMLTextAreaElement>("contextcompact_summary_prompt");
    prompt.value = settings.summaryPrompt ?? getLocalizedDefaultSummaryPrompt();
    prompt.disabled = settings.summaryPrompt === undefined;
    customInjectionPromptDraft = settings.injectionPrompt;
    element<HTMLInputElement>("contextcompact_injection_prompt_use_default").checked =
        settings.injectionPrompt === undefined;
    const injectionPrompt = element<HTMLTextAreaElement>("contextcompact_injection_prompt");
    injectionPrompt.value = settings.injectionPrompt ?? getLocalizedDefaultInjectionPrompt();
    injectionPrompt.disabled = settings.injectionPrompt === undefined;
}

function readSettings(): ContextCompactSettings {
    const selected = element<HTMLSelectElement>("contextcompact_model_select").value;
    const profile = supportedProfiles().find((item) => `profile:${item.id}` === selected);
    if (selected !== "current" && !profile) {
        throw new Error(translate("The selected API connection profile is unavailable.", "contextcompact.settings.selected_profile_unavailable_save"));
    }
    return {
        enabled: element<HTMLInputElement>("contextcompact_enabled").checked,
        mode: element<HTMLSelectElement>("contextcompact_mode").value as ContextCompactSettings["mode"],
        triggerMode: element<HTMLSelectElement>("contextcompact_trigger_mode").value as ContextCompactSettings["triggerMode"],
        triggerRatio: Number(element<HTMLInputElement>("contextcompact_trigger").value),
        triggerTokens: Number(element<HTMLInputElement>("contextcompact_trigger_tokens").value),
        triggerRounds: Number(element<HTMLInputElement>("contextcompact_trigger_rounds").value),
        recentRoundCount: Number(element<HTMLInputElement>("contextcompact_recent").value),
        targetMemoryTokens: Number(element<HTMLInputElement>("contextcompact_target").value),
        summaryLanguage: element<HTMLSelectElement>("contextcompact_language").value,
        model: profile ? { kind: "profile", profileId: profile.id } : { kind: "current" },
        summaryPrompt: element<HTMLInputElement>("contextcompact_prompt_use_default").checked
            ? undefined
            : element<HTMLTextAreaElement>("contextcompact_summary_prompt").value,
        injectionPrompt: element<HTMLInputElement>("contextcompact_injection_prompt_use_default").checked
            ? undefined
            : element<HTMLTextAreaElement>("contextcompact_injection_prompt").value,
    };
}

export function initializeSettingsPanel(): void {
    const container = document.querySelector<HTMLElement>("#extensions_settings2");
    if (!container) {
        console.warn(`[${MODULE_NAME}] Extensions settings container not found`);
        return;
    }
    if (!document.getElementById("contextcompact_settings")) {
        container.insertAdjacentHTML("beforeend", settingsHtml);
    }
    loadSettings();
    const feedback = element<HTMLElement>("contextcompact_settings_feedback");
    element<HTMLSelectElement>("contextcompact_trigger_mode").addEventListener("change", showTriggerMode);
    element<HTMLInputElement>("contextcompact_prompt_use_default")
        .addEventListener("change", showSummaryPrompt);
    element<HTMLInputElement>("contextcompact_injection_prompt_use_default")
        .addEventListener("change", showInjectionPrompt);
    const modelSelect = element<HTMLSelectElement>("contextcompact_model_select");
    modelSelect.addEventListener("focus", () => renderModels(modelSelect.value));
    modelSelect.addEventListener("change", showModelStatus);
    const { eventSource, eventTypes } = SillyTavern.getContext();
    for (const type of [
        eventTypes.CONNECTION_PROFILE_CREATED,
        eventTypes.CONNECTION_PROFILE_UPDATED,
        eventTypes.CONNECTION_PROFILE_DELETED,
    ]) {
        eventSource.on(type, () => {
            renderModels(modelSelect.value);
            showModelStatus();
        });
    }
    element<HTMLButtonElement>("contextcompact_save_settings").addEventListener("click", () => {
        try {
            const saved = saveSettings(readSettings());
            customPromptDraft = saved.summaryPrompt;
            customInjectionPromptDraft = saved.injectionPrompt;
            cancelCompactions();
            clearGenerationMemoryPrompt();
            feedback.textContent = translate("Settings saved.", "contextcompact.settings.saved");
            feedback.dataset.error = "false";
            showModelStatus();
        } catch (error) {
            feedback.textContent = error instanceof Error ? error.message : String(error);
            feedback.dataset.error = "true";
        }
    });
    initializeMemoryPanel();
}
