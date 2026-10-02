export function translate(
    fallback: string,
    key: string,
    values: Record<string, string | number> = {},
): string {
    const template = SillyTavern.getContext().translate?.(fallback, key) ?? fallback;
    return template.replace(/\{(\w+)\}/g, (match: string, name: string) =>
        values[name] === undefined ? match : String(values[name]));
}
