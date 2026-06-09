# 1. Claude prompt-cache breakpoints

Date: 2026-06-08

## Status

Accepted. **Amended (issue #28)**: the TTL is now configurable via `CACHE_TTL`
and defaults to **1-hour**, not 5-minute — see [Amendment: configurable TTL,
1-hour default](#amendment-configurable-ttl-1-hour-default-issue-28) below. All
other decisions stand.

## Context

The Claude provider translates OpenAI Chat Completions requests into Anthropic
Messages requests (`src/providers/claude/translate.ts`). Anthropic prompt
caching is **opt-in**: a request only benefits from caching if it carries
explicit `cache_control` markers on content blocks. Without markers, every turn
re-bills the full prompt (Claude Code identity + Cursor's system prompt + tool
definitions + entire conversation history) as fresh input.

The translator read back `cache_read_input_tokens` / `cache_creation_input_tokens`
from responses (to drive the TUI cache rate) but never wrote a single
`cache_control` marker on the request. As a result the observed cache rate was
structurally near 0%, inflating subscription/plan usage on long Cursor sessions
where the stable prefix (identity + system + tools) is large and resent verbatim
each turn.

Anthropic constraints that shaped the decision:

- At most **4** `cache_control` breakpoints per request.
- Caching requires an **exact prefix match** against a prior request; request
  translation must be deterministic.
- A cached prefix must clear a **per-model minimum token count** or the
  breakpoint is silently ignored — no error, no cache. The threshold is **not**
  uniform across models (see the per-model note below); it was stated here as a
  flat "≥ 1024 (Sonnet/Opus)", which is only correct for older Sonnet.
- The default 5-minute (`ephemeral`) TTL is cheapest to write and is **refreshed
  on every cache read**, so a continuously active session stays warm.
- Cursor is stateless and replays full conversation history each turn.

## Decision

Inject `cache_control: { type: "ephemeral" }` (5-minute TTL) in
`buildAnthropicRequest`, spending the full 4-breakpoint budget. The placement is
ported from the predecessor tool (`Firzus/shim`,
`anthropic/translation/claude-code-body.ts`), which ran this scheme in
production:

1. **Tools** — sort `tools[]` alphabetically by name, then mark the **last**
   entry. The sort is load-bearing: Cursor/MCP can emit tools in varying order
   between turns, and without a stable order the tools prefix changes byte-for-
   byte every request and **never** caches.
2. **System** — last block of `system[]` (identity + Cursor system prompt).
3. **Conversation (×2)** — anchor on **user** messages only, which are the stable
   turn boundaries:
   - the **first** user message (fixed anchor — caches the immutable head of a
     long conversation, the savings that compound most), and
   - the **second-to-last** user message (rolling anchor — the position next
     turn's prefix still matches exactly, guaranteeing a cache read).
   The **last** message is deliberately **never** marked: it is new every turn,
   so marking it forces a cache *write* with no matching read. Cache reads
   already refresh the 5-minute TTL on the whole prefix, so explicit "pre-warm"
   of the last message buys nothing.

Placement is **defensive**: a marker is only emitted where its target exists
(no `tools` → skip; fewer than 2 user messages → fewer conversation markers), so
the request never exceeds 4 markers and never references a missing block.

Decisions made:

- **User-message anchoring (first + second-to-last)**, not last+second-to-last of
  any role. Chosen over the initial theoretical plan because the predecessor
  tool proved it, and the "pre-warm the last message" intuition was wrong (it
  only adds write cost; reads already refresh the TTL).
- **Alphabetical tool sort** before marking, to keep the tools prefix
  deterministic across turns.
- ~~**5-minute TTL**, not 1-hour extended. Active sessions reuse within minutes;
  the 1-hour tier doubles write cost and only helps across long idle gaps.~~
  **Superseded — see the amendment below.** This rationale assumed a per-token
  write premium that does not apply on the OAuth/subscription path.
- **No token-size guard** on conversation markers. Sub-1024 prefixes are ignored
  by Anthropic at no cost, so always placing them is simpler and self-correcting
  as history grows.
- **Claude-only.** The Codex provider uses OpenAI's Responses API, which caches
  automatically without markers.
- **Verification** via unit tests pinning marker placement plus the existing TUI
  cache-rate readout; no new telemetry.

## Consequences

- Long sessions should see the cache rate climb from ~0% to the typical 60–90%
  range for agentic workloads, cutting billed input tokens substantially.
- `buildAnthropicRequest` must stay **deterministic** — any non-determinism in
  block ordering, tool batching, or text extraction breaks exact-prefix matching
  and silently kills cache hits. The concrete known threat is **tool ordering**
  (handled by the alphabetical sort); tests must guard this.
- The marker-placement logic is coupled to Anthropic's 4-breakpoint cap and the
  message-array shape produced by the translator; changes to either must keep the
  budget and targeting in sync.
- The first turn of a session will not hit cache (nothing to match yet); savings
  begin on the second turn onward.

## Amendment: configurable TTL, 1-hour default (issue #28)

The original decision picked the 5-minute ephemeral TTL over the 1-hour extended
tier, reasoning that the 1-hour tier *doubles write cost* and only pays off
across long idle gaps. That trade-off is real on the **standard API** (per-token
billing: a 5-minute write is 1.25× input price, a 1-hour write is 2×). It does
**not** apply on the **OAuth/subscription path** this proxy uses: consumption is
metered against plan rate-limit windows (5h / weekly utilization), not per cached
token, so the "doubled write cost" the original rationale weighed against is not
billed here. What remains is the upside — the stable ~22k-token prefix (identity
+ system + tools) survives the normal think-gaps between turns.

Under the 5-minute TTL, any pause longer than 5 minutes — common when the user
reads or thinks between turns — expires the prefix, forcing a cold rewrite that
re-bills the prefix (visible now as `cache_creation`, see [issue #27]) and adds
cold-write TTFT. The 1-hour TTL keeps the prefix warm across those gaps.

**Decision:** the breakpoint TTL is configurable via the `CACHE_TTL` env var
(`1h` | `5m`), defaulting to **`1h`**. All four breakpoints inherit it from a
single source (`CACHE_CONTROL` in `translate.ts`, fed by `CACHE_TTL` in
`config.ts`), so the marker placement above is unchanged — only the `ttl` field
on the shared marker differs. Set `CACHE_TTL=5m` to restore the original
behaviour.

The cache-rate definition is **unchanged** (ADR-0003): `cache_read /
prompt_tokens`. The TTL change reduces cold-write *frequency*; it does not touch
how the rate is computed. Validate the effect by comparing `plan_usage` 5h /
weekly utilization growth with `1h` vs `5m` over a few real sessions — the 1-hour
default should not burn the plan faster, because writes are not separately
metered on this path.

[issue #27]: surfaces `cache_creation` as a distinct signal, which makes the
cold-write reduction from this change legible.

## Note: the minimum cacheable prefix is per-model (issue #31)

The Context section above originally stated the minimum cacheable prefix as a
flat "≥ 1024 tokens (Sonnet/Opus)". **This is model-dependent, not uniform.** A
prefix that caches on one model can silently fail to cache on another — no
error, `cache_creation_input_tokens: 0`, and the breakpoint is a no-op.

Current minimums (verify against the live prompt-caching docs before relying on
these — values shift across model releases and sources disagree):

| Model | Minimum cacheable prefix |
| --- | ---: |
| Opus 4.8 / 4.7 / 4.6 / 4.5, Haiku 4.5 | 4096 tokens |
| Sonnet 4.6, Haiku 3.5 / 3 | 2048 tokens |
| Sonnet 4.5 / 4.1 / 4 / 3.7 | 1024 tokens |

**Immaterial today:** the real stable prefix (identity + Cursor system prompt +
tool definitions) is ~22k tokens, which dwarfs every threshold above — so all
four breakpoints cache on every model this proxy currently serves
(`claude-opus-4-8`, `claude-sonnet-4-6`).

**Why this note exists — guardrail against future regression:** if a future
model with a *higher* minimum is added, or the conversation breakpoints land on
a short turn below the threshold, caching could silently regress. On any model
change, re-check the new model's minimum against the prefix size, and watch
`cache_creation` / the TUI cache rate (ADR-0003) for a silent drop to confirm
the breakpoints still take.
