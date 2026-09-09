"use client";

import {
  LayoutGrid,
  LogIn,
  LogOut,
  PanelLeft,
  PenLine,
  Search,
} from "lucide-react";
import { useMemo, useState } from "react";

import { handleSignOut } from "@/app/auth/actions";
import type { ConversationSummary } from "@/lib/chat/types";

type SidebarUser = {
  email: string;
  name: string | null;
  initials: string;
};

type SidebarProps = {
  open: boolean;
  conversations: ConversationSummary[];
  activeConversationId: string | null;
  searchQuery: string;
  user: SidebarUser | null;
  onToggle: () => void;
  onNewChat: () => void;
  onSelectConversation: (id: string) => void;
  onSearchChange: (query: string) => void;
};

function displayName(user: SidebarUser | null): string {
  if (!user) return "Guest";
  if (user.name) return user.name;
  return user.email.split("@")[0] ?? user.email;
}

export function Sidebar({
  open,
  conversations,
  activeConversationId,
  searchQuery,
  user,
  onToggle,
  onNewChat,
  onSelectConversation,
  onSearchChange,
}: SidebarProps) {
  const [searchOpen, setSearchOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);

  const filteredConversations = useMemo(() => {
    const query = searchQuery.trim().toLowerCase();
    const sorted = [...conversations].sort((a, b) => b.updatedAt - a.updatedAt);
    if (!query) return sorted;
    return sorted.filter((conversation) =>
      conversation.title.toLowerCase().includes(query),
    );
  }, [conversations, searchQuery]);

  if (!open) return null;

  return (
    <aside
      className="flex h-full shrink-0 flex-col border-r border-[#e5e5e5] bg-[#f9f9f9]"
      style={{ width: "var(--gpt-sidebar-width)" }}
    >
      <div className="flex items-center justify-between px-3 pb-2 pt-3">
        <div className="px-2 text-[15px] font-semibold tracking-[-0.01em] text-[#0d0d0d]">
          GPTfree
        </div>
        <button
          type="button"
          aria-label="Close sidebar"
          onClick={onToggle}
          className="rounded-lg p-2 text-[#676767] transition-colors hover:bg-[#ececec]"
        >
          <PanelLeft className="h-[18px] w-[18px]" strokeWidth={1.75} />
        </button>
      </div>

      <div className="px-3 pb-2">
        <button
          type="button"
          onClick={onNewChat}
          className="flex w-full items-center gap-2 rounded-lg bg-[#ececec] px-3 py-2 text-[14px] font-medium text-[#0d0d0d] transition-colors hover:bg-[#e3e3e3]"
        >
          <PenLine className="h-[18px] w-[18px]" strokeWidth={1.75} />
          New chat
        </button>
      </div>

      <nav className="px-2">
        <button
          type="button"
          onClick={() => {
            setSearchOpen((value) => !value);
            onSearchChange("");
          }}
          className="flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left text-[14px] text-[#0d0d0d] transition-colors hover:bg-[#ececec]"
        >
          <Search className="h-[18px] w-[18px] text-[#676767]" strokeWidth={1.75} />
          Search chats
        </button>
      </nav>

      {searchOpen ? (
        <div className="px-3 pt-2">
          <div className="flex items-center gap-2 rounded-lg border border-[#e5e5e5] bg-white px-3 py-2">
            <Search className="h-4 w-4 text-[#676767]" strokeWidth={1.75} />
            <input
              autoFocus
              value={searchQuery}
              onChange={(event) => onSearchChange(event.target.value)}
              placeholder="Search chats..."
              className="w-full border-0 bg-transparent text-[14px] text-[#0d0d0d] outline-none placeholder:text-[#8f8f8f]"
            />
          </div>
        </div>
      ) : null}

      <div className="mt-4 min-h-0 flex-1 overflow-y-auto px-2 gpt-scrollbar">
        {!user ? (
          <div className="px-3 pb-3 text-[12px] leading-4 text-[#676767]">
            <a href="/login" className="underline hover:text-[#0d0d0d]">
              Sign in
            </a>{" "}
            to save your chats
          </div>
        ) : null}
        <div className="px-3 pb-2 text-[12px] font-medium text-[#676767]">
          Recents
        </div>
        <div className="space-y-0.5">
          {filteredConversations.map((conversation) => (
            <button
              key={conversation.id}
              type="button"
              onClick={() => onSelectConversation(conversation.id)}
              className={`block w-full truncate rounded-lg px-3 py-2 text-left text-[14px] transition-colors hover:bg-[#ececec] ${
                conversation.id === activeConversationId
                  ? "bg-[#ececec] text-[#0d0d0d]"
                  : "text-[#0d0d0d]"
              }`}
            >
              {conversation.title}
            </button>
          ))}
        </div>
      </div>

      <div className="relative border-t border-[#e5e5e5] p-3">
        <button
          type="button"
          onClick={() => setMenuOpen((value) => !value)}
          className="flex w-full items-center gap-3 rounded-lg px-2 py-2 text-left transition-colors hover:bg-[#ececec]"
        >
          <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-[#19c37d] text-[13px] font-semibold text-white">
            {user?.initials ?? "?"}
          </div>
          <div className="min-w-0 flex-1">
            <div className="truncate text-[14px] font-medium text-[#0d0d0d]">
              {displayName(user)}
            </div>
            <div className="text-[12px] text-[#676767]">
              {user ? "Plus" : "Not signed in"}
            </div>
          </div>
          <LayoutGrid className="h-4 w-4 shrink-0 text-[#676767]" strokeWidth={1.75} />
        </button>

        {menuOpen ? (
          <div className="absolute bottom-[calc(100%+4px)] left-3 right-3 rounded-xl border border-[#e5e5e5] bg-white p-1 shadow-[0_8px_24px_rgba(0,0,0,0.08)]">
            {user ? (
              <button
                type="button"
                onClick={() => {
                  setMenuOpen(false);
                  void handleSignOut();
                }}
                className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-[14px] text-[#0d0d0d] transition-colors hover:bg-[#ececec]"
              >
                <LogOut className="h-4 w-4 text-[#676767]" strokeWidth={1.75} />
                Log out
              </button>
            ) : (
              <a
                href="/login"
                onClick={() => setMenuOpen(false)}
                className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-[14px] text-[#0d0d0d] transition-colors hover:bg-[#ececec]"
              >
                <LogIn className="h-4 w-4 text-[#676767]" strokeWidth={1.75} />
                Sign in
              </a>
            )}
          </div>
        ) : null}
      </div>
    </aside>
  );
}
