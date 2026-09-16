# OpenAI Provider Design

## Goal

Add OpenAI as a first-class AI provider so `local-auto` can authenticate with `OPENAI_API_KEY` and use an OpenAI model for screenshot-driven browser automation.

## Scope

The integration targets OpenAI's official API only. It will use the official JavaScript SDK and the Responses API. Custom OpenAI-compatible base URLs and Chat Completions compatibility are outside this change.

## Configuration

The existing `ai` configuration remains provider-agnostic:

```yaml
ai:
  provider: openai
  model: <vision-capable-openai-model>
  maxIterations: 20
```

`openai` will be added to the provider union in both the Zod configuration schema and TypeScript configuration types. The provider will read `OPENAI_API_KEY` from the environment and throw a clear error during construction when the variable is missing.

The example environment and YAML files, plus the README setup instructions, will document the new provider without changing the existing default provider.

## Provider Architecture

Create `src/ai/openai.ts` with an `OpenAIProvider` class implementing the existing `AIProvider` interface. `createAIProvider()` will dynamically import it when `ai.provider` is `openai`, preserving the current lazy-loading pattern.

The SDK client will explicitly pin `https://api.openai.com/v1`, disable SDK logging, and disable its internal retries. This prevents environment-level SDK settings from redirecting dashboard data or logging screenshots/DOM, and leaves the provider's three-attempt loop as the sole retry mechanism.

For each browser-agent iteration, the provider will:

1. Build the existing shared system prompt and user message.
2. Encode the PNG screenshot as a data URL.
3. Call the official OpenAI Responses API with the configured model, the system instructions, and one user input containing the screenshot followed by the task and DOM text.
4. Set `store: false` so dashboard screenshots and DOM content are not retained by default.
5. Read the response's combined text output and validate it with the existing `parseAIResponse()` function.
6. Return the validated action through the existing `AIResponse` contract.

The initial integration will not add OpenAI-specific reasoning controls, conversation persistence, tool calls, or model selection logic. The browser agent already provides full action history on every iteration, so each request can remain stateless.

## Error Handling

The provider will follow the existing provider behavior: retry up to three times when the API call fails, returns no text, or produces an invalid action. Each failed attempt will be logged at warning level without logging the API key, screenshot, full DOM, or raw model output. After the final attempt, it will throw a sanitized failure category instead of including raw model output.

Authentication, quota, model-access, and other API failures are therefore visible through the existing worker failure path. No provider-specific fallback will silently route requests to another vendor.

## Dependencies

Add the official `openai` package as a runtime dependency. No other new package or configuration layer is needed.

## Tests

Implementation will follow red-green-refactor. Focused tests will cover:

- rejecting construction when `OPENAI_API_KEY` is absent;
- pinning the official API endpoint and disabling SDK logging and internal retries;
- sending the configured model, shared instructions, screenshot data URL, user message, and `store: false`;
- parsing a valid OpenAI text response into an `AIAction`;
- retrying transient/API, empty-output, and malformed-action failures up to the existing limit;
- not logging or surfacing raw malformed model output;
- accepting `provider: openai` in configuration; and
- selecting `OpenAIProvider` through the provider factory.

The final verification will run the focused tests, the complete test suite, the TypeScript build, and `git diff --check`. A live API request is optional and will only be performed if a usable `OPENAI_API_KEY` is already available without exposing it.

## Acceptance Criteria

- `ai.provider: openai` passes configuration validation.
- A worker configured with `provider: openai` constructs the new provider.
- Requests authenticate through `OPENAI_API_KEY` and use the configured model through OpenAI's Responses API.
- Screenshot and DOM/task context reach the model in the expected multimodal request.
- Valid responses produce the same `AIAction` values as existing providers.
- Missing credentials and failed or invalid responses produce actionable errors.
- Existing Anthropic, Gemini, and OpenCode behavior remains unchanged.
- Documentation shows how to configure the provider and key.
