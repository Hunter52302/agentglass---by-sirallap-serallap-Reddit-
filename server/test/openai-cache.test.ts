import { describe, expect, test } from "bun:test";
import { normalize, sumTranscriptCost, sumTranscriptTokens, usageFrom } from "../src/ingest.ts";
import { costUsd } from "../src/pricing.ts";

describe("provider-aware cached-token normalization", () => {
  test("preserves Anthropic input and cache semantics", () => {
    expect(usageFrom({
      input_tokens: 1_000,
      output_tokens: 50,
      cache_read_input_tokens: 400,
      cache_creation_input_tokens: 20,
    })).toEqual({
      input_tokens: 1_000,
      output_tokens: 50,
      cache_read_tokens: 400,
      cache_creation_tokens: 20,
    });
  });

  test("normalizes OpenAI Responses cached input", () => {
    expect(usageFrom({
      input_tokens: 1_000,
      output_tokens: 50,
      input_tokens_details: { cached_tokens: 400 },
    })).toMatchObject({ input_tokens: 600, cache_read_tokens: 400 });
  });

  test("normalizes OpenAI Chat Completions cached prompt input", () => {
    expect(usageFrom({
      prompt_tokens: 1_000,
      completion_tokens: 50,
      prompt_tokens_details: { cached_tokens: 250 },
    })).toMatchObject({ input_tokens: 750, output_tokens: 50, cache_read_tokens: 250 });
  });

  test("accepts singular input_token_details and aggregate input_cached_tokens", () => {
    expect(usageFrom({
      input_tokens: 1_000,
      input_token_details: { cached_tokens: 300 },
    })).toMatchObject({ input_tokens: 700, cache_read_tokens: 300 });
    expect(usageFrom({
      input_tokens: 1_000,
      input_cached_tokens: 200,
    })).toMatchObject({ input_tokens: 800, cache_read_tokens: 200 });
  });

  test("does not add duplicate cached representations", () => {
    expect(usageFrom({
      input_tokens: 1_000,
      input_cached_tokens: 400,
      input_tokens_details: { cached_tokens: 400 },
      cache_read_tokens: 400,
    })).toMatchObject({ input_tokens: 600, cache_read_tokens: 400 });
  });

  test("keeps cache-only events and clamps cached input above total", () => {
    expect(usageFrom({ input_tokens: 0, input_cached_tokens: 500 }))
      .toMatchObject({ input_tokens: 0, cache_read_tokens: 500 });
    expect(usageFrom({ input_tokens: 100, input_cached_tokens: 500 }))
      .toMatchObject({ input_tokens: 0, cache_read_tokens: 500 });
  });

  test("tolerates missing nested objects and rejects malformed values", () => {
    expect(usageFrom({ input_tokens: 100, input_tokens_details: null }))
      .toMatchObject({ input_tokens: 100, cache_read_tokens: 0 });
    expect(usageFrom({
      input_tokens: -10,
      input_cached_tokens: "bad",
      input_token_details: { cached_tokens: -20 },
    })).toMatchObject({ input_tokens: 0, cache_read_tokens: 0 });
  });

  test("normalize detects aggregate cache-only payload usage", () => {
    const event = normalize({
      source_app: "codex",
      session_id: "s",
      hook_event_type: "response.completed",
      payload: { usage: { input_tokens: 0, input_cached_tokens: 500 } },
    } as any);
    expect(event.usage_is_cumulative).toBe(false);
    expect(event.usage.cache_read_tokens).toBe(500);
  });

  test("cumulative transcripts normalize every snapshot message", () => {
    const usage = sumTranscriptTokens([
      { message: { usage: { input_tokens: 1_000, input_tokens_details: { cached_tokens: 400 } } } },
      { message: { usage: { prompt_tokens: 500, prompt_tokens_details: { cached_tokens: 100 } } } },
    ]);
    expect(usage.input_tokens).toBe(1_000);
    expect(usage.cache_read_tokens).toBe(500);
  });

  test("mixed-provider transcript cost uses each model and cache semantics", () => {
    const anthropic = {
      model: "claude-sonnet-5",
      usage: { input_tokens: 1_000, cache_read_input_tokens: 400 },
    };
    const openai = {
      model: "gpt-4o",
      usage: { input_tokens: 1_000, input_tokens_details: { cached_tokens: 400 } },
    };
    const expected =
      costUsd(usageFrom(anthropic.usage), anthropic.model)
      + costUsd(usageFrom(openai.usage), openai.model);
    expect(sumTranscriptCost([{ message: anthropic }, { message: openai }], null))
      .toBeCloseTo(expected, 12);
  });
});
