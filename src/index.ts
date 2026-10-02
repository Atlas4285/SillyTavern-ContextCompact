import "./ui/settings.css";
import { MODULE_NAME } from "./constants";
import { initializeGenerationInterceptor } from "./infrastructure/generation-interceptor";
import { getSettings } from "./infrastructure/settings-store";
import { initializeSettingsPanel } from "./ui/settings";

initializeGenerationInterceptor();
const { eventSource, eventTypes } = SillyTavern.getContext();
eventSource.on(eventTypes.APP_INITIALIZED, () => {
    getSettings();
    initializeSettingsPanel();
});
console.log(`[${MODULE_NAME}] Extension loaded`);
