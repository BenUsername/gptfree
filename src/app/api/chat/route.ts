import { NextRequest, NextResponse } from "next/server";

import { DEFAULT_MODEL, isGeminiModel, modelIdentitySystemPrompt } from "@/lib/chat/types";
import type { ChatMessage } from "@/lib/chat/types";
import {
  ANON_LIMIT_MESSAGE,
  ANON_LIMIT_UNAVAILABLE_MESSAGE,
  recordAnonUsage,
} from "@/lib/server/anon-usage";
import {
  getOptionalAuth,
  requireCommercialConsent,
} from "@/lib/server/auth";
import {
  createConversation,
  getConversationMessages,
  insertMessage,
  titleFromMessage,
  touchConversation,
  updateMessageContent,
} from "@/lib/server/conversations";
import { getGeminiClient } from "@/lib/server/gemini";
import { getOpenAIClient } from "@/lib/server/openai";
import { supabase } from "@/lib/server/supabase-server";

export const runtime = "nodejs";

function messagesForModel(messages: ChatMessage[]): ChatMessage[] {
  return messages.filter(
    (message) =>
      message.content.trim().length > 0 &&
      (message.role === "user" || message.role === "assistant"),
  );
}

/**
 * Anonymous callers may only reach the cheap models. Anything else is served
 * by the cheapest one rather than rejected, so the model picker keeps working.
 */
const ANON_ALLOWED_MODELS = new Set(["gemini-3.1-flash-lite", "gpt-5.4"]);
const ANON_FALLBACK_MODEL = "gemini-3.1-flash-lite";

/** Anonymous requests carry their own history, so the body needs a ceiling. */
const ANON_MAX_BODY_BYTES = 32 * 1024;
const ANON_MAX_INPUT_MESSAGES = 20;

/** The conversationId reported to anonymous clients; never persisted. */
const ANON_CONVERSATION_ID = "anon";

function resolveModel(requested: string, isAnonymous: boolean): string {
  if (!isAnonymous) return requested;
  return ANON_ALLOWED_MODELS.has(requested) ? requested : ANON_FALLBACK_MODEL;
}

/** Client-supplied history is untrusted, so keep only well-formed turns. */
function sanitizeHistory(value: unknown): ChatMessage[] {
  if (!Array.isArray(value)) return [];

  const messages: ChatMessage[] = [];

  for (const entry of value) {
    if (!entry || typeof entry !== "object") continue;

    const { id, role, content } = entry as Partial<ChatMessage>;
    if (role !== "user" && role !== "assistant") continue;
    if (typeof content !== "string") continue;

    messages.push({
      id: typeof id === "string" ? id : crypto.randomUUID(),
      role,
      content,
    });
  }

  return messages;
}

function buildAnonymousInput(history: unknown, message: string): ChatMessage[] {
  const input = [
    ...messagesForModel(sanitizeHistory(history)),
    { id: crypto.randomUUID(), role: "user" as const, content: message },
  ].slice(-ANON_MAX_INPUT_MESSAGES);

  // Gemini rejects a history that opens on a model turn, which the cap above
  // can produce.
  while (input.length > 1 && input[0].role !== "user") {
    input.shift();
  }

  return input;
}

function sseResponse(readable: ReadableStream<Uint8Array>): Response {
  return new Response(readable, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    },
  });
}

function streamModel(
  model: string,
  messages: ChatMessage[],
  emit: (payload: Record<string, unknown>) => void,
): Promise<string> {
  if (isGeminiModel(model)) {
    return streamGeminiResponse(model, messages, emit);
  }

  return streamOpenAiResponse(model, messages, emit);
}

function createSseStream(
  onStream: (
    emit: (payload: Record<string, unknown>) => void,
  ) => Promise<string>,
  onComplete: (content: string) => Promise<void>,
  onError: (content: string, errorMessage: string) => Promise<void>,
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();

  return new ReadableStream({
    async start(controller) {
      const emit = (payload: Record<string, unknown>) => {
        controller.enqueue(
          encoder.encode(`data: ${JSON.stringify(payload)}\n\n`),
        );
      };

      let content = "";

      try {
        content = await onStream(emit);
        await onComplete(content);
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
      } catch (error) {
        const errorMessage =
          error instanceof Error ? error.message : "Stream failed";
        await onError(content, errorMessage);
        emit({ type: "error", error: errorMessage });
      } finally {
        controller.close();
      }
    },
  });
}

async function streamOpenAiResponse(
  model: string,
  messages: ChatMessage[],
  emit: (payload: Record<string, unknown>) => void,
): Promise<string> {
  const openai = getOpenAIClient();
  const stream = await openai.chat.completions.create({
    model,
    messages: [
      { role: "system", content: modelIdentitySystemPrompt(model) },
      ...messages.map(({ role, content }) => ({ role, content })),
    ],
    stream: true,
  });

  let assistantContent = "";

  for await (const chunk of stream) {
    const text = chunk.choices[0]?.delta?.content ?? "";
    if (!text) continue;

    assistantContent += text;
    emit({ type: "delta", text });
  }

  return assistantContent;
}

async function streamGeminiResponse(
  model: string,
  messages: ChatMessage[],
  emit: (payload: Record<string, unknown>) => void,
): Promise<string> {
  const genAI = getGeminiClient();
  const generativeModel = genAI.getGenerativeModel({
    model,
    systemInstruction: modelIdentitySystemPrompt(model),
  });

  const history = messages.slice(0, -1).map((message) => ({
    role: message.role === "user" ? "user" : "model",
    parts: [{ text: message.content }],
  }));

  const lastMessage = messages[messages.length - 1];
  if (!lastMessage || lastMessage.role !== "user") {
    throw new Error("Gemini requests require a user message");
  }

  const chat = generativeModel.startChat({ history });
  const result = await chat.sendMessageStream(lastMessage.content);

  let assistantContent = "";

  for await (const chunk of result.stream) {
    const text = chunk.text();
    if (!text) continue;

    assistantContent += text;
    emit({ type: "delta", text });
  }

  return assistantContent;
}

export async function POST(request: NextRequest) {
  const auth = await getOptionalAuth(request);

  if (auth) {
    const consentError = requireCommercialConsent(auth);
    if (consentError) return consentError;
  }

  let body: {
    conversationId?: string;
    message?: string;
    model?: string;
    history?: unknown;
  };

  try {
    const raw = await request.text();

    if (!auth && Buffer.byteLength(raw, "utf8") > ANON_MAX_BODY_BYTES) {
      return NextResponse.json(
        { error: "Conversation is too long to continue without signing in." },
        { status: 413 },
      );
    }

    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("Body must be a JSON object");
    }

    body = parsed;
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }

  try {
    const message = body.message?.trim();
    const model = resolveModel(body.model ?? DEFAULT_MODEL, !auth);

    if (!message) {
      return NextResponse.json({ error: "Message is required" }, { status: 400 });
    }

    if (!auth) {
      const usage = await recordAnonUsage(request);

      if (!usage.allowed) {
        const overLimit = usage.reason === "over_limit";
        return NextResponse.json(
          { error: overLimit ? ANON_LIMIT_MESSAGE : ANON_LIMIT_UNAVAILABLE_MESSAGE },
          { status: overLimit ? 429 : 503 },
        );
      }

      const input = buildAnonymousInput(body.history, message);
      const noop = async () => {};

      return sseResponse(
        createSseStream(
          async (emit) => {
            emit({
              type: "meta",
              conversationId: ANON_CONVERSATION_ID,
              assistantMessageId: crypto.randomUUID(),
            });

            return streamModel(model, input, emit);
          },
          noop,
          noop,
        ),
      );
    }

    let conversationId =
      body.conversationId === ANON_CONVERSATION_ID
        ? undefined
        : body.conversationId;
    const isNewConversation = !conversationId;

    if (conversationId) {
      const { data: existing, error: existingError } = await supabase
        .from("gptfree_conversations")
        .select("id")
        .eq("id", conversationId)
        .eq("email", auth.email)
        .maybeSingle();

      if (existingError) {
        throw new Error(existingError.message);
      }

      if (!existing) {
        return NextResponse.json({ error: "Conversation not found" }, { status: 404 });
      }
    } else {
      conversationId = await createConversation(
        auth.id,
        auth.email,
        titleFromMessage(message),
        model,
      );
    }

    await insertMessage(conversationId, "user", message);

    const history = messagesForModel(await getConversationMessages(conversationId));
    const assistantMessageId = await insertMessage(conversationId, "assistant", "");

    if (isNewConversation) {
      await touchConversation(conversationId, titleFromMessage(message));
    } else {
      await touchConversation(conversationId);
    }

    const readable = createSseStream(
      async (emit) => {
        emit({
          type: "meta",
          conversationId,
          assistantMessageId,
        });

        return streamModel(model, history, emit);
      },
      async (assistantContent) => {
        await updateMessageContent(assistantMessageId, assistantContent);
        await touchConversation(conversationId!);
      },
      async (assistantContent, errorMessage) => {
        if (assistantContent) {
          await updateMessageContent(assistantMessageId, assistantContent);
        } else {
          await updateMessageContent(assistantMessageId, errorMessage);
        }
      },
    );

    return sseResponse(readable);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Request failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
