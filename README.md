# SillyTavern ContextCompact

**English** | [简体中文](README.zh-CN.md)

ContextCompact is a third-party [SillyTavern](https://github.com/SillyTavern/SillyTavern) extension that turns older chat turns into structured memory. During generation, it replaces the covered chat history with that memory and keeps recent turns in their original form. Saved chat messages are not deleted.

## Features

- Compact automatically before sending, after a completed reply, or only when requested manually.
- Trigger automatic compaction by completed context size, either as a context window ratio or a token count, or by user turns.
- Keep a configurable number of complete recent turns as original chat history.
- Update existing memory with new turns or rebuild it from the original chat in batches.
- View and edit memory as labeled fields or JSON, and save it with the chat.
- Use the current chat model or a supported API connection profile for summaries.
- Edit the compaction and memory injection prompts, or use localized defaults.
- Continue typing while compaction blocks new messages from being sent.
- Provide an English interface with Simplified Chinese localization.

## Installation

### Install through SillyTavern

1. Open SillyTavern's **Extensions** panel and select **Install Extension**.
2. Enter this repository URL:

    ```text
    https://github.com/Atlas4285/SillyTavern-ContextCompact
    ```

3. Complete the installation and reload SillyTavern if the extension does not appear immediately.

Only install third-party extensions from sources you trust.

### Manual installation

Clone the repository into SillyTavern's third-party extensions directory:

```bash
cd /path/to/SillyTavern/public/scripts/extensions/third-party
git clone https://github.com/Atlas4285/SillyTavern-ContextCompact.git
```

If the checkout does not contain a built `dist/index.js`, build it first:

```bash
cd SillyTavern-ContextCompact
npm install
npm run build
```

Then reload SillyTavern.

## Getting started

1. Open **Extensions → ContextCompact** and leave **Enable memory compaction** on.
2. Choose **Compaction timing** and **Trigger mode**, set **Recent user turns to keep**, and click **Save settings**.
3. Open a chat with more complete turns than the number you chose to keep. Click **Compact now** to create its first memory, or continue chatting until the automatic trigger is reached.
4. Review **Current chat memory**. Edit its fields directly, or switch to **Show JSON**, then click **Save edit**.

### Main settings

| Setting | Meaning | Default |
| --- | --- | --- |
| Compaction timing | Check before sending, after a complete reply, or only on demand. | Before sending |
| Trigger mode | Use a context window ratio, a completed context token threshold, or completed user turns. Only one mode applies at a time. | Ratio, 60% |
| Completed context token threshold | Trigger when the context after a complete reply reaches this many tokens, if token mode is selected. | 128,000 |
| Rounds per compaction | Trigger after this many user messages since the previous compaction, if rounds mode is selected. | 1 |
| Recent user turns to keep | Keep this many complete turns as original text. | 10 |
| Target memory tokens | Ask the model to aim for this size; it is not a hard output cap. | 1,000 |
| Summary language | Match the chat language automatically or choose a language. | Auto |
| Summary model | Use the current chat model or a supported API connection profile. | Current chat model |

## How compaction works

A **turn** starts with a user message and includes the following assistant replies and tool calls up to the next user message. ContextCompact only compresses complete turns and never splits one between memory and recent history.

For example, if turns 1–16 have been compacted and turns 17–20 are being kept, the next generation receives the memory **before** turns 17–20. The original messages remain in the saved chat. The next compaction sends the previous memory with newly eligible turns and saves the updated memory.

| Timing | Behavior |
| --- | --- |
| Before sending | Checks the context size after the previous complete reply and compacts, if triggered, before the next request is built. |
| After a reply | Waits for the full reply, including tool calls, then checks the trigger and compacts. |
| Manual only | Compacts only when **Compact now** or **Rebuild from chat** is used. |

Ratio and token triggers measure the last request's input **plus its completed reply**. They use API `prompt_tokens` and `completion_tokens` when available; missing values are estimated with SillyTavern's tokenizer. With tool calls, the last request's input already contains earlier tool activity in that turn. Requests are not added together. If the complete size cannot be determined, those automatic triggers are skipped and manual compaction remains available. The rounds trigger counts user messages since the previous compaction. Trigger settings do not force a partial turn into memory.

A result longer than the summary input is rejected. During compaction, you can keep typing, but sending another message is blocked until the operation finishes or fails.

## Memory and controls

Each chat stores one current memory in its chat metadata:

| Field | Meaning |
| --- | --- |
| `currentSituation` | The current scene or state of the conversation. |
| `importantEvents` | Important events and decisions in chronological order. |
| `establishedFacts` | Facts confirmed in the chat. |
| `relationships` | Relevant relationships and how they have changed. |
| `openThreads` | Questions, goals, and events still unresolved. |

The four list fields appear as one editable text area each, with one item per line. **Show JSON** switches to an editable JSON view. **Save edit** validates and stores either view's changes. The panel also shows the covered message count, update time, version, and memory token count.

- **Refresh** reloads the saved memory and discards unsaved edits.
- **Compact now** adds newly eligible complete turns to the current memory. It needs older turns beyond the configured recent-turn count.
- **Rebuild from chat** replaces this chat's memory by processing its original eligible turns in consecutive batches. Each batch uses the temporary memory from the previous batch. It keeps the configured recent turns as original text.
- **Clear memory** deletes this chat's saved memory without deleting chat messages. The next generation uses the original history until memory is created again.

Rebuilding uses the configured rounds per compaction when the rounds trigger is selected. With ratio or token triggers, it groups as many complete turns as fit the estimated request budget. If the provider reports that a batch is too long, it retries with a smaller batch. A single turn that cannot fit remains uncompressed.

## Models and prompts

The summary model selector offers **Current chat model** and supported profiles from SillyTavern's API connection configuration. Summarization currently supports Chat Completion and Text Completion connections. The summary request is built from a compaction instruction and data containing previous memory, active system or preset context, and newly eligible chat messages. Existing summary text is excluded from the captured preset context.

Both prompt editors can use their localized defaults or a custom prompt:

- **Compaction prompt:** `{{targetTokens}}` inserts the target memory size; `{{languageInstruction}}` inserts the selected summary-language instruction.
- **Memory injection prompt:** `{{memory}}` inserts the saved memory JSON. If omitted, the JSON is appended after the prompt.

Memory is injected into later generations as a system-role prompt immediately before the remaining original turns. If compaction fails, ContextCompact reports the error and does not save the failed result. Generation continues with existing valid memory or the original chat history.

Non-text content, an empty message, or a turn too large for a rebuild request can prevent safe compaction past that point. If covered chat history is edited, the saved memory is considered stale and must be rebuilt before it can replace that history.

## Development

This extension is written in TypeScript and bundled with Webpack. From the extension directory:

```bash
npm install
npm run dev               # rebuild on source changes
npm run build             # production bundle in dist/
npm run lint              # ESLint
npm run lint:fix          # apply automatically fixable ESLint changes
```

The watcher rebuilds the bundle but does not hot-reload SillyTavern; refresh the browser page after a change.

### Project structure

```text
src/
├── index.ts               Extension initialization
├── application/           Compaction coordination and chat turn selection
├── domain/                Settings, memory validation, and prompt templates
├── infrastructure/        SillyTavern integration, summary requests, and chat storage
└── ui/                    Settings and memory editor
i18n/                      Simplified Chinese UI strings
dist/                      Built extension bundle
```

The production entry point in `manifest.json` is `dist/index.js`.

## License

This project is licensed under the [GNU Affero General Public License v3.0](LICENSE).
