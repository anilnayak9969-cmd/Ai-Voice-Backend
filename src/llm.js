import Anthropic from '@anthropic-ai/sdk';

export const MODEL = process.env.ANTHROPIC_MODEL || 'claude-opus-5-5';

// Voice needs fast first tokens: keep effort low. Haiku 4.5 doesn't accept
// the effort parameter, so only send it to models that do.
const EFFORT = process.env.ANTHROPIC_EFFORT || 'low';
const SUPPORTS_EFFORT = !MODEL.startsWith('claude-haiku');

// Server-side refusal fallback ("default" routing) on the models that support it.
const FALLBACK_MODELS = ['claude-opus-5-5', 'claude-opus-5', 'claude-fable-5-1', 'claude-sonnet-5-5'];
const SUPPORTS_FALLBACK = FALLBACK_MODELS.includes(MODEL);

export const client = new Anthropic();

export function hasCredentials() {
  const key = process.env.ANTHROPIC_API_KEY;
  return Boolean((key && !key.startsWith('your_')) || process.env.ANTHROPIC_AUTH_TOKEN);
}

// Shared request options for every call to Claude.
export function baseParams() {
  const params = { model: MODEL };
  if (SUPPORTS_EFFORT) params.output_config = { effort: EFFORT };
  return params;
}

export function fallbackParams() {
  return SUPPORTS_FALLBACK ? { betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' } : {};
}
