// A stand-in for the Workers AI binding that replays scripted replies in the OpenAI-style shape
// the chat models use, streamed as server-sent events when the request asks for a stream.

export interface ScriptedReply {
  text?: string;
  toolCalls?: Array<{ name: string; arguments: unknown }>;
  /** Throw, as the binding does when a model is unavailable. */
  fail?: boolean;
  /** A raw result returned as is (for odd model output). */
  raw?: unknown;
}

export interface AiCall {
  model: string;
  inputs: Record<string, any>;
}

const encoder = new TextEncoder();

/** Splits the stream into small byte chunks so events straddle chunk boundaries. */
function sse(reply: ScriptedReply): ReadableStream<Uint8Array> {
  const events: unknown[] = [];
  for (const word of (reply.text ?? '').split(/(?<= )/)) {
    if (word) events.push({ choices: [{ index: 0, delta: { content: word } }] });
  }
  (reply.toolCalls ?? []).forEach((c, index) => {
    const args = JSON.stringify(c.arguments);
    const half = Math.floor(args.length / 2);
    events.push({ choices: [{ index: 0, delta: { tool_calls: [{ index, id: `call_${index}`, type: 'function', function: { name: c.name, arguments: args.slice(0, half) } }] } }] });
    events.push({ choices: [{ index: 0, delta: { tool_calls: [{ index, function: { arguments: args.slice(half) } }] } }] });
  });
  const bytes = encoder.encode(`${events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join('')}data: [DONE]\n\n`);
  let at = 0;
  return new ReadableStream({
    pull(controller) {
      if (at >= bytes.length) return controller.close();
      controller.enqueue(bytes.slice(at, at + 7));
      at += 7;
    },
  });
}

export function fakeAi(script: ScriptedReply[] | ((call: AiCall) => ScriptedReply)) {
  const calls: AiCall[] = [];
  let i = 0;
  return {
    calls,
    async run(model: string, inputs: Record<string, any>) {
      const call = { model, inputs: structuredClone(inputs) };
      calls.push(call);
      const reply = typeof script === 'function' ? script(call) : (script[i++] ?? { text: 'OK' });
      if (reply.fail) throw new Error('5007: No such model or task');
      if (reply.raw !== undefined) return reply.raw;
      if (inputs.stream) return sse(reply);
      return {
        choices: [
          {
            index: 0,
            message: {
              role: 'assistant',
              content: reply.text ?? null,
              tool_calls: reply.toolCalls?.map((c, index) => ({
                id: `call_${index}`,
                type: 'function',
                function: { name: c.name, arguments: JSON.stringify(c.arguments) },
              })),
            },
            finish_reason: reply.toolCalls?.length ? 'tool_calls' : 'stop',
          },
        ],
        usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 },
      };
    },
  };
}
