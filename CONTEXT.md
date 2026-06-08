# Context — Glossary

Canonical vocabulary for `shim-cli`. Terms here are the names we use in code, issues, and discussion. Avoid the listed synonyms.

## Terms

### Cache breakpoint
A single `cache_control: { type: "ephemeral" }` marker placed on a content block (or tool definition) in an Anthropic Messages request. Everything from the start of the request up to and including a breakpoint forms a cacheable prefix. Anthropic allows at most **4** breakpoints per request.

- Use: "cache breakpoint", "breakpoint".
- Avoid: "cache point", "cache anchor", "cache tag".

### Conversation breakpoint
A cache breakpoint placed on conversation history (as opposed to the stable `system`/`tools` prefix). Anchored on **user** messages only, which are the stable turn boundaries. Two are used: a **fixed anchor** on the first user message (caches the immutable head of the conversation) and a **rolling anchor** on the second-to-last user message (the position next turn's prefix still matches). The last message is never marked.

- Use: "conversation breakpoint", "fixed anchor", "rolling anchor".
- Avoid: "history cache", "message cache", "pre-warm".

### Cache rate
The ratio `cached_tokens / prompt_tokens` over a **bounded time window** (a *period*) of recorded requests, shown in the TUI. `cached_tokens` is Anthropic's `cache_read_input_tokens`; `prompt_tokens` is the normalized full input (raw input + cache read + cache creation). The period is selectable — `5h / 24h / 7d / 30d / all` — defaulting to `24h`; it is **never** an all-time cumulative sum (that buries the live signal under cold history). It measures cache *efficiency* — distinct from [[plan-usage]], which measures quota *consumption*.

- Use: "cache rate".
- Avoid: "hit rate", "cache ratio", "session cache rate" (the window is a selectable period, not a session).

### Plan usage
Real subscription-quota consumption, read from Anthropic's `anthropic-ratelimit-unified-{5h,7d}-*` response headers (not self-computed): two windows, **5h** and **weekly**, each with a `utilization` percent and a reset time. The authoritative "how much of my plan have I burned" signal; caching shows up here as slower utilization growth.

- Use: "plan usage".
- Avoid: "cache rate" (different concept — efficiency vs consumption), "quota meter".

### Prefix (cacheable prefix)
The exact byte sequence from the start of a request up to a cache breakpoint. Anthropic reuses a cache entry only on an exact prefix match against a prior request, so request translation must be deterministic.

- Use: "prefix", "cacheable prefix".
- Avoid: "cache key".
