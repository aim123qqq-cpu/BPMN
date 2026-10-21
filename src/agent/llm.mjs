// Клиенты LLM. Конвейеру нужен только текст ответа (JSON внутри) — tool calling не требуется,
// поэтому подходит любая модель: облачная или локальная.
//
// Anthropic — официальный SDK. Остальные — OpenAI-совместимый /chat/completions
// (OpenAI, DeepSeek, OpenRouter, Ollama, LM Studio, vLLM, YandexGPT, GigaChat через совместимый шлюз и т.д.).

export const PRESETS = {
  anthropic: { kind: 'anthropic', model: 'claude-opus-5-5', keyEnv: 'ANTHROPIC_API_KEY' },
  openai: { kind: 'openai', baseUrl: 'https://api.openai.com/v1', keyEnv: 'OPENAI_API_KEY' },
  deepseek: { kind: 'openai', baseUrl: 'https://api.deepseek.com/v1', keyEnv: 'DEEPSEEK_API_KEY' },
  openrouter: { kind: 'openai', baseUrl: 'https://openrouter.ai/api/v1', keyEnv: 'OPENROUTER_API_KEY' },
  ollama: { kind: 'openai', baseUrl: 'http://localhost:11434/v1' },
  lmstudio: { kind: 'openai', baseUrl: 'http://localhost:1234/v1' },
  'openai-compatible': { kind: 'openai', keyEnv: 'LLM_API_KEY' }
};

/**
 * Сообщения: [{ role: 'user'|'assistant', content: string | [{ text, cache? }] }].
 * cache: true — подсказка «этот блок повторяется между вызовами» (документы); используется там, где провайдер
 * поддерживает кэширование промпта.
 */
export function createLLM(opts = {}) {
  const env = process.env;
  const provider = opts.provider ?? env.LLM_PROVIDER ?? 'anthropic';
  const preset = PRESETS[provider];
  if (!preset) throw new Error(`Неизвестный провайдер «${provider}». Доступны: ${Object.keys(PRESETS).join(', ')}`);
  const model = opts.model ?? env.LLM_MODEL ?? preset.model;
  if (!model) throw new Error(`Для провайдера ${provider} укажите модель: --model <id> (или LLM_MODEL)`);
  const apiKey = opts.apiKey ?? env.LLM_API_KEY ?? (preset.keyEnv ? env[preset.keyEnv] : undefined);
  const baseUrl = opts.baseUrl ?? env.LLM_BASE_URL ?? preset.baseUrl;
  const name = `${provider}:${model}`;
  if (preset.kind === 'anthropic') return anthropicClient({ name, model, apiKey, ...opts });
  if (!baseUrl) throw new Error(`Для провайдера ${provider} укажите --base-url (или LLM_BASE_URL)`);
  return openaiCompatibleClient({ name, model, apiKey, baseUrl, ...opts });
}

const textOf = (content) => (typeof content === 'string' ? content : content.map((b) => b.text).join('\n\n'));

// --- Anthropic (официальный SDK) ---
// Модели с adaptive thinking и output_config.effort; для них же — серверный fallback при отказе.
const EFFORT_MODELS = /^claude-(fable|mythos|opus|sonnet|haiku)-5|^claude-opus-4-[678]|^claude-sonnet-4-6/;
const FALLBACK_MODELS = new Set(['claude-fable-5-1', 'claude-opus-5-5', 'claude-opus-5', 'claude-sonnet-5-5']);

function anthropicClient({ name, model, apiKey, maxTokens = 64000, effort = 'high' }) {
  let client;
  return {
    name,
    async complete({ system, messages }) {
      if (!client) {
        const { default: Anthropic } = await import('@anthropic-ai/sdk');
        client = new Anthropic(apiKey ? { apiKey } : {});
      }
      const params = {
        model,
        max_tokens: maxTokens,
        system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }],
        messages: messages.map((m) => ({
          role: m.role,
          content:
            typeof m.content === 'string'
              ? m.content
              : m.content.map((b) => ({ type: 'text', text: b.text, ...(b.cache ? { cache_control: { type: 'ephemeral' } } : {}) }))
        }))
      };
      if (EFFORT_MODELS.test(model)) params.output_config = { effort };
      let stream;
      if (FALLBACK_MODELS.has(model)) {
        // при отказе классификатора безопасности запрос автоматически повторяется на подходящей модели
        stream = client.beta.messages.stream({ ...params, betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' });
      } else {
        stream = client.messages.stream(params);
      }
      const msg = await stream.finalMessage();
      if (msg.stop_reason === 'refusal') throw new Error(`${name}: модель отказалась отвечать (${msg.stop_details?.category ?? 'без категории'})`);
      if (msg.stop_reason === 'max_tokens') throw new Error(`${name}: ответ обрезан по max_tokens=${maxTokens}`);
      return msg.content
        .filter((b) => b.type === 'text')
        .map((b) => b.text)
        .join('');
    }
  };
}

// --- OpenAI-совместимые API (fetch) ---
function openaiCompatibleClient({ name, model, apiKey, baseUrl, maxTokens, jsonMode = false, timeoutMs = 15 * 60 * 1000, retries = 3 }) {
  const url = `${baseUrl.replace(/\/+$/, '')}/chat/completions`;
  return {
    name,
    async complete({ system, messages }) {
      const body = {
        model,
        messages: [{ role: 'system', content: system }, ...messages.map((m) => ({ role: m.role, content: textOf(m.content) }))],
        ...(maxTokens ? { max_tokens: maxTokens } : {}),
        ...(jsonMode ? { response_format: { type: 'json_object' } } : {})
      };
      for (let attempt = 0; ; attempt++) {
        let res;
        try {
          res = await fetch(url, {
            method: 'POST',
            headers: { 'content-type': 'application/json', ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}) },
            body: JSON.stringify(body),
            signal: AbortSignal.timeout(timeoutMs)
          });
        } catch (e) {
          if (attempt < retries) {
            await sleep(2 ** attempt * 1000);
            continue;
          }
          throw new Error(`${name}: нет соединения с ${url}: ${e.message}`);
        }
        if ((res.status === 429 || res.status >= 500) && attempt < retries) {
          await sleep(Number(res.headers.get('retry-after')) * 1000 || 2 ** attempt * 2000);
          continue;
        }
        if (!res.ok) throw new Error(`${name}: HTTP ${res.status}: ${(await res.text()).slice(0, 500)}`);
        const data = await res.json();
        const choice = data.choices?.[0];
        if (!choice) throw new Error(`${name}: пустой ответ: ${JSON.stringify(data).slice(0, 300)}`);
        if (choice.finish_reason === 'length') throw new Error(`${name}: ответ обрезан по длине — увеличьте --max-tokens`);
        return choice.message?.content ?? '';
      }
    }
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Достаёт JSON из ответа модели: ```json-блок, иначе первый «{» … последний «}». */
export function parseJsonResponse(text) {
  const fenced = [...text.matchAll(/```(?:json)?\s*\n([\s\S]*?)```/g)].map((m) => m[1]);
  const candidates = [...fenced.reverse()];
  const a = text.indexOf('{');
  const b = text.lastIndexOf('}');
  if (a >= 0 && b > a) candidates.push(text.slice(a, b + 1));
  let lastError;
  for (const c of candidates) {
    try {
      return JSON.parse(c);
    } catch (e) {
      lastError = e;
    }
  }
  throw new Error(candidates.length ? `ответ не является корректным JSON: ${lastError.message}` : 'в ответе нет JSON-объекта');
}
