"use client";

import { PanelLeft } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import { ChatInput, DEFAULT_MODEL } from "@/components/chat/ChatInput";
import { ConsentModal } from "@/components/chat/ConsentModal";
import { MessageList } from "@/components/chat/MessageList";
import { Sidebar } from "@/components/chat/Sidebar";
import type {
  ChatMessage,
  Conversation,
  ConversationSummary,
} from "@/lib/chat/types";

type AuthUser = {
  email: string;
  name: string | null;
  initials: string;
  hasCommercialConsent: boolean;
};

type StreamMeta = {
  conversationId: string;
  assistantMessageId: string;
};

async function streamChatResponse(
  conversationId: string | null,
  message: string,
  model: string,
  history: ChatMessage[],
  onMeta: (meta: StreamMeta) => void,
  onDelta: (assistantMessageId: string, text: string) => void,
): Promise<StreamMeta> {
  const response = await fetch("/api/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ conversationId, message, model, history }),
  });

  if (!response.ok) {
    const payload = (await response.json().catch(() => null)) as
      | { error?: string }
      | null;
    throw new Error(payload?.error ?? "Failed to send message");
  }

  const reader = response.body?.getReader();
  if (!reader) {
    throw new Error("No response stream");
  }

  const decoder = new TextDecoder();
  let buffer = "";
  let meta: StreamMeta | null = null;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";

    for (const line of lines) {
      if (!line.startsWith("data: ")) continue;
      const payload = line.slice(6).trim();
      if (payload === "[DONE]") {
        if (!meta) throw new Error("Stream ended without metadata");
        return meta;
      }

      try {
        const parsed = JSON.parse(payload) as {
          type?: string;
          text?: string;
          error?: string;
          conversationId?: string;
          assistantMessageId?: string;
        };

        if (parsed.type === "error" || parsed.error) {
          throw new Error(parsed.error ?? "Stream failed");
        }

        if (
          parsed.type === "meta" &&
          parsed.conversationId &&
          parsed.assistantMessageId
        ) {
          meta = {
            conversationId: parsed.conversationId,
            assistantMessageId: parsed.assistantMessageId,
          };
          onMeta(meta);
          continue;
        }

        if (parsed.type === "delta" && parsed.text && meta) {
          onDelta(meta.assistantMessageId, parsed.text);
        }
      } catch (error) {
        if (error instanceof SyntaxError) continue;
        throw error;
      }
    }
  }

  if (!meta) {
    throw new Error("Stream ended without metadata");
  }

  return meta;
}

async function fetchConversations(): Promise<ConversationSummary[]> {
  const response = await fetch("/api/conversations");
  if (!response.ok) {
    throw new Error("Failed to load conversations");
  }

  const payload = (await response.json()) as {
    conversations: ConversationSummary[];
  };

  return payload.conversations;
}

async function fetchConversation(conversationId: string): Promise<Conversation> {
  const response = await fetch(`/api/conversations/${conversationId}`);
  if (!response.ok) {
    throw new Error("Failed to load conversation");
  }

  const payload = (await response.json()) as { conversation: Conversation };
  return payload.conversation;
}

export function ChatApp() {
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [user, setUser] = useState<AuthUser | null>(null);
  const [conversations, setConversations] = useState<ConversationSummary[]>([]);
  const [activeConversationId, setActiveConversationId] = useState<string | null>(
    null,
  );
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [model, setModel] = useState(DEFAULT_MODEL);
  const [searchQuery, setSearchQuery] = useState("");
  const [isStreaming, setIsStreaming] = useState(false);
  const [hydrated, setHydrated] = useState(false);
  const [loadingConversation, setLoadingConversation] = useState(false);
  const [hasCommercialConsent, setHasCommercialConsent] = useState(true);
  const [consentChecked, setConsentChecked] = useState(false);

  useEffect(() => {
    async function bootstrap() {
      try {
        const meResponse = await fetch("/api/auth/me");
        if (!meResponse.ok) return;

        const me = (await meResponse.json()) as AuthUser & { email?: string };
        if (!me.email) return;

        setUser({
          email: me.email,
          name: me.name ?? null,
          initials: me.initials ?? me.email.slice(0, 2).toUpperCase(),
          hasCommercialConsent: me.hasCommercialConsent ?? false,
        });
        setHasCommercialConsent(me.hasCommercialConsent ?? false);
        setConsentChecked(true);

        if (me.hasCommercialConsent) {
          setConversations(await fetchConversations());
        }
      } finally {
        setHydrated(true);
      }
    }

    void bootstrap();
  }, []);

  useEffect(() => {
    if (!activeConversationId) {
      setMessages([]);
    }
  }, [activeConversationId]);

  const isEmptyState =
    messages.length === 0 && !loadingConversation && !isStreaming;

  const refreshConversations = useCallback(async () => {
    setConversations(await fetchConversations());
  }, []);

  const handleNewChat = useCallback(() => {
    setActiveConversationId(null);
    setMessages([]);
    setInput("");
    setSearchQuery("");
  }, []);

  const handleSelectConversation = useCallback(async (conversationId: string) => {
    setActiveConversationId(conversationId);
    setInput("");
    setLoadingConversation(true);

    try {
      const conversation = await fetchConversation(conversationId);
      setMessages(conversation.messages);
    } catch {
      setMessages([]);
    } finally {
      setLoadingConversation(false);
    }
  }, []);

  const handleQuickAction = useCallback((prompt: string) => {
    setInput(prompt);
  }, []);

  const handleSubmit = useCallback(async () => {
    const trimmed = input.trim();
    if (!trimmed || isStreaming) return;

    const tempAssistantId = crypto.randomUUID();
    // The meta frame renames the placeholder, so track the live id: a
    // mid-stream failure must still land on the message being streamed
    // instead of vanishing.
    let assistantId = tempAssistantId;
    const userMessage: ChatMessage = {
      id: crypto.randomUUID(),
      role: "user",
      content: trimmed,
    };
    const assistantMessage: ChatMessage = {
      id: tempAssistantId,
      role: "assistant",
      content: "",
    };

    setMessages((current) => [...current, userMessage, assistantMessage]);
    setInput("");
    setIsStreaming(true);

    try {
      const meta = await streamChatResponse(
        activeConversationId,
        trimmed,
        model,
        // Anonymous requests have no server-side transcript, so the local
        // messages are the conversation. The empty assistant placeholder is
        // excluded.
        messages.filter((entry) => entry.content.trim().length > 0),
        (streamMeta) => {
          assistantId = streamMeta.assistantMessageId;
          setActiveConversationId(streamMeta.conversationId);
          setMessages((current) =>
            current.map((message) =>
              message.id === tempAssistantId
                ? { ...message, id: streamMeta.assistantMessageId }
                : message,
            ),
          );
        },
        (assistantMessageId, delta) => {
          setMessages((current) =>
            current.map((message) =>
              message.id === assistantMessageId
                ? { ...message, content: message.content + delta }
                : message,
            ),
          );
        },
      );

      setActiveConversationId(meta.conversationId);

      // Only signed-in visitors have saved conversations; /api/conversations
      // 401s otherwise, and the throw would overwrite the streamed reply.
      if (user) {
        await refreshConversations();
      }
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Something went wrong";
      setMessages((current) =>
        current.map((entry) =>
          entry.id === assistantId ? { ...entry, content: message } : entry,
        ),
      );
    } finally {
      setIsStreaming(false);
    }
  }, [
    activeConversationId,
    input,
    isStreaming,
    messages,
    model,
    refreshConversations,
    user,
  ]);

  const handleAcceptConsent = useCallback(async () => {
    const response = await fetch("/api/auth/consent", { method: "POST" });
    if (!response.ok) {
      const payload = (await response.json().catch(() => null)) as
        | { error?: string }
        | null;
      throw new Error(payload?.error ?? "Failed to save consent");
    }

    setHasCommercialConsent(true);
    setUser((current) =>
      current ? { ...current, hasCommercialConsent: true } : current,
    );
    setConversations(await fetchConversations());
  }, []);

  if (!hydrated) {
    return <div className="h-full bg-white" />;
  }

  return (
    <div className="flex h-full bg-white">
      {!hasCommercialConsent && consentChecked ? (
        <ConsentModal onAccept={handleAcceptConsent} />
      ) : null}
      <Sidebar
        open={sidebarOpen}
        conversations={conversations}
        activeConversationId={activeConversationId}
        searchQuery={searchQuery}
        user={user}
        onToggle={() => setSidebarOpen(false)}
        onNewChat={handleNewChat}
        onSelectConversation={handleSelectConversation}
        onSearchChange={setSearchQuery}
      />

      <main className="relative flex min-w-0 flex-1 flex-col">
        {!sidebarOpen ? (
          <div className="absolute left-3 top-3 z-10">
            <button
              type="button"
              aria-label="Open sidebar"
              onClick={() => setSidebarOpen(true)}
              className="rounded-lg p-2 text-[#676767] transition-colors hover:bg-[#ececec]"
            >
              <PanelLeft className="h-[18px] w-[18px]" strokeWidth={1.75} />
            </button>
          </div>
        ) : null}

        {isEmptyState ? (
          <div className="flex flex-1 flex-col items-center justify-center px-4 pb-8">
            <h1 className="mb-8 text-[28px] font-normal tracking-[-0.02em] text-[#0d0d0d]">
              What&apos;s on your mind today?
            </h1>
            <ChatInput
              value={input}
              model={model}
              disabled={isStreaming}
              centered
              showQuickActions
              onChange={setInput}
              onSubmit={handleSubmit}
              onModelChange={setModel}
              onQuickAction={handleQuickAction}
            />
          </div>
        ) : (
          <>
            <div className="min-h-0 flex-1 overflow-y-auto gpt-scrollbar">
              {loadingConversation ? (
                <div className="flex h-full items-center justify-center text-[14px] text-[#676767]">
                  Loading conversation...
                </div>
              ) : (
                <MessageList messages={messages} isStreaming={isStreaming} />
              )}
            </div>
            <ChatInput
              value={input}
              model={model}
              disabled={isStreaming || loadingConversation}
              onChange={setInput}
              onSubmit={handleSubmit}
              onModelChange={setModel}
              onQuickAction={handleQuickAction}
            />
          </>
        )}
      </main>
    </div>
  );
}
