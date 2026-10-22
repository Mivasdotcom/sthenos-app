import { createFileRoute } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useState, useMemo } from "react";
import { formatDistanceToNow } from "date-fns";
import { MessageSquare, Loader2, Megaphone } from "lucide-react";
import { PageHeader } from "@/components/PageHeader";
import { ConversationView } from "@/components/ConversationView";
import { BroadcastsPanel } from "@/components/BroadcastsPanel";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useCurrentDojo } from "@/hooks/use-current-dojo";
import { useAuth } from "@/hooks/use-auth";
import { listConversations } from "@/lib/communications.functions";
import { cn } from "@/lib/utils";

type CommsTab = "conversations" | "broadcasts";

export const Route = createFileRoute("/communications")({
  // Optional, so every existing plain link to /communications stays valid;
  // /marketing redirects here with tab=broadcasts.
  validateSearch: (s: Record<string, unknown>): { tab?: CommsTab } =>
    s.tab === "broadcasts" ? { tab: "broadcasts" } : {},
  head: () => ({
    meta: [
      { title: "Communications — Sthenos" },
      {
        name: "description",
        content: "Message members one-to-one, or email your whole roster or a saved segment.",
      },
      { property: "og:title", content: "Communications — Sthenos" },
      {
        property: "og:description",
        content: "Message members one-to-one, or email your whole roster or a saved segment.",
      },
    ],
  }),
  component: CommunicationsPage,
});

/**
 * Everything a gym says to its members, in one place: one-to-one
 * conversations, and broadcasts to the whole roster or a segment. These were
 * separate "Communications" and "Marketing" menu items, which meant a coach had
 * to know which one held which kind of message.
 */
function CommunicationsPage() {
  const { isRealStaff } = useAuth();
  const search = Route.useSearch();
  const [tab, setTab] = useState<CommsTab>(search.tab ?? "conversations");

  if (!isRealStaff) {
    return (
      <div className="p-6">
        <PageHeader title="Communications" subtitle="Staff only" />
      </div>
    );
  }

  return (
    <main>
      <PageHeader
        title="Communications"
        subtitle="Message members one-to-one, or email your whole roster or a saved segment."
      />
      <div className="mx-auto max-w-7xl px-6 pb-6">
        <Tabs value={tab} onValueChange={(v) => setTab(v as CommsTab)}>
          <TabsList>
            <TabsTrigger value="conversations" className="gap-2">
              <MessageSquare className="size-3.5" /> Conversations
            </TabsTrigger>
            <TabsTrigger value="broadcasts" className="gap-2">
              <Megaphone className="size-3.5" /> Broadcasts
            </TabsTrigger>
          </TabsList>
          <TabsContent value="conversations" className="mt-6">
            <ConversationsInbox />
          </TabsContent>
          <TabsContent value="broadcasts" className="mt-6">
            <BroadcastsPanel />
          </TabsContent>
        </Tabs>
      </div>
    </main>
  );
}

function ConversationsInbox() {
  const { activeDojoId } = useCurrentDojo();
  const { isRealStaff } = useAuth();
  const load = useServerFn(listConversations);
  const [selectedMemberId, setSelectedMemberId] = useState<string | null>(null);
  const [search, setSearch] = useState("");

  const { data, isLoading } = useQuery({
    queryKey: ["conversations", activeDojoId],
    enabled: !!activeDojoId && isRealStaff,
    queryFn: () => load({ data: { dojoId: activeDojoId! } }),
    refetchInterval: 20_000,
  });

  const conversations = data?.conversations ?? [];
  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return conversations;
    return conversations.filter(
      (c: any) =>
        c.memberName?.toLowerCase().includes(q) || c.memberEmail?.toLowerCase().includes(q),
    );
  }, [conversations, search]);

  return (
    // A fixed height lets the list and the open thread scroll independently,
    // as the full-page inbox did before it moved into a tab.
    <div className="grid h-[calc(100vh-14rem)] min-h-[420px] grid-cols-1 gap-4 md:grid-cols-[320px_1fr]">
      <div className="flex min-h-0 flex-col rounded-lg border bg-card">
        <div className="border-b p-3">
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search members…"
            className="w-full rounded-md border bg-background px-3 py-1.5 text-sm outline-none focus:ring-2 focus:ring-ring"
          />
        </div>
        <div className="flex-1 overflow-y-auto">
          {isLoading ? (
            <div className="flex items-center justify-center py-8 text-muted-foreground">
              <Loader2 className="mr-2 size-4 animate-spin" /> Loading…
            </div>
          ) : filtered.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-12 text-center text-muted-foreground">
              <MessageSquare className="mb-2 size-6" />
              <div className="text-sm">No conversations yet.</div>
              <div className="mt-1 text-xs">Open a member profile to start a thread.</div>
            </div>
          ) : (
            <ul>
              {filtered.map((c: any) => {
                const active = c.memberId === selectedMemberId;
                return (
                  <li key={c.id}>
                    <button
                      onClick={() => setSelectedMemberId(c.memberId)}
                      className={cn(
                        "w-full border-b px-3 py-3 text-left transition-colors hover:bg-muted/50",
                        active && "bg-muted",
                      )}
                    >
                      <div className="flex items-center justify-between gap-2">
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-2">
                            <span className="truncate text-sm font-semibold">{c.memberName}</span>
                            {c.unread > 0 && (
                              <span className="rounded-full bg-primary px-1.5 text-[10px] font-semibold text-primary-foreground">
                                {c.unread}
                              </span>
                            )}
                          </div>
                          <div className="truncate text-xs text-muted-foreground">
                            {c.preview ?? "No messages yet"}
                          </div>
                        </div>
                        {c.lastMessageAt && (
                          <div className="shrink-0 text-[10px] text-muted-foreground">
                            {formatDistanceToNow(new Date(c.lastMessageAt), { addSuffix: true })}
                          </div>
                        )}
                      </div>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </div>
      <div className="flex min-h-0 flex-col rounded-lg border bg-card p-4">
        {selectedMemberId && activeDojoId ? (
          <ConversationView dojoId={activeDojoId} memberId={selectedMemberId} viewerRole="staff" />
        ) : (
          <div className="flex flex-1 items-center justify-center text-center text-muted-foreground">
            <div>
              <MessageSquare className="mx-auto mb-2 size-8" />
              <div className="text-sm">Select a conversation to start messaging.</div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
