import { createFileRoute } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";
import { PageHeader } from "@/components/PageHeader";
import { ConversationView } from "@/components/ConversationView";
import { useAuth } from "@/hooks/use-auth";
import { useCurrentDojo } from "@/hooks/use-current-dojo";
import { supabase } from "@/integrations/supabase/client";

export const Route = createFileRoute("/messages")({
  head: () => ({
    meta: [
      { title: "Messages — Sthenos" },
      { name: "description", content: "Message your gym directly." },
      { property: "og:title", content: "Messages — Sthenos" },
      { property: "og:description", content: "Message your gym directly." },
    ],
  }),
  component: MessagesPage,
});

function MessagesPage() {
  const { user } = useAuth();
  const { activeDojoId, activeDojo } = useCurrentDojo();

  const { data: member, isLoading } = useQuery({
    queryKey: ["messages-member", user?.id, activeDojoId],
    enabled: !!user?.id && !!activeDojoId,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("members")
        .select("id")
        .eq("user_id", user!.id)
        .eq("dojo_id", activeDojoId!)
        .maybeSingle();
      if (error) throw error;
      return data;
    },
  });

  return (
    <main>
      <PageHeader
        title="Messages"
        subtitle={activeDojo?.name ? `Chat with ${activeDojo.name}` : "Chat with your gym"}
      />
      <div className="mx-auto max-w-3xl p-6">
        <div className="h-[70vh] rounded-lg border bg-card p-4">
          {isLoading ? (
            <div className="flex items-center justify-center py-10 text-muted-foreground">
              <Loader2 className="mr-2 size-4 animate-spin" /> Loading…
            </div>
          ) : !member?.id || !activeDojoId ? (
            <div className="flex items-center justify-center py-10 text-center text-sm text-muted-foreground">
              Your profile isn't set up yet. Contact your gym manager.
            </div>
          ) : (
            <ConversationView
              dojoId={activeDojoId}
              memberId={member.id}
              viewerRole="member"
              className="h-full"
            />
          )}
        </div>
      </div>
    </main>
  );
}
