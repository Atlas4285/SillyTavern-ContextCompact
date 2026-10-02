import { MODULE_NAME } from "../constants";
import {
    createDefaultSettings,
    validateSettings,
    type ContextCompactSettings,
} from "../domain/settings";

export function getSettings(): ContextCompactSettings {
    const { extensionSettings, saveSettingsDebounced } = SillyTavern.getContext();
    const stored: unknown = extensionSettings[MODULE_NAME];

    if (stored === undefined) {
        const defaults = createDefaultSettings();
        extensionSettings[MODULE_NAME] = defaults;
        saveSettingsDebounced();
        return defaults;
    }

    return validateSettings(stored);
}

export function saveSettings(value: unknown): ContextCompactSettings {
    const settings = validateSettings(value);
    const { extensionSettings, saveSettingsDebounced } = SillyTavern.getContext();
    extensionSettings[MODULE_NAME] = settings;
    saveSettingsDebounced();
    return settings;
}
