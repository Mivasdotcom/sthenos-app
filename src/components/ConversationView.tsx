import { useEffect, useRef, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { format } from "date-fns";
import { Loader2, Send, Mail, MessageSquare } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { getConversation, sendMessage } from "@/lib/communications.functions";

type Channel = "in_app" | "email";

export function ConversationView({
  dojoId,
  memberId,
  viewerRole,
  className,
}: {
  dojoId: string;
  memberId: string;
  viewerRole: "staff" | "member";
  className?: string;
}) {
  const queryClient = useQueryClient();
  const load = useServerFn(getConversation);
  const send = useServerFn(sendMessage);
  const [body, setBody] = useState("");
  const [channel, setChannel] = useState<Channel>("in_app");
  const scrollRef = useRef<HTMLDivElement>(null);

  const queryKey = ["conversation", dojoId, memberId] as const;
  const { data, isLoading } = useQuery({
    queryKey,
    enabled: !!dojoId && !!memberId,
    queryFn: () => load({ data: { dojoId, memberId } }),
    refetchInterval: 15_000,
  });

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [data?.messages?.length]);

  const mutation = useMutation({
    mutationFn: (input: { body: string; channel: Channel }) =>
      send({ data: { dojoId, memberId, body: input.body, channel: input.channel } }),
    onSuccess: (res) => {
      setBody("");
      queryClient.invalidateQueries({ queryKey });
      queryClient.invalidateQueries({ queryKey: ["conversations", dojoId] });
      queryClient.invalidateQueries({ queryKey: ["comms-unread", dojoId] });
      queryClient.invalidateQueries({ queryKey: ["member-interventions", dojoId, memberId] });
      queryClient.invalidateQueries({ queryKey: ["retention-impact"] });
      if (res?.deliveryNotice) toast.info(res.deliveryNotice);
    },
    onError: (err: any) => toast.error(err?.message ?? "Failed to send"),
  });

  const messages = data?.messages ?? [];

  return (
    <div className={cn("flex h-full min-h-0 flex-col", className)}>
      <div
        ref={scrollRef}
        className="flex-1 overflow-y-auto space-y-3 p-4 bg-muted/20 rounded-md border"
      >
        {isLoading ? (
          <div className="flex items-center justify-center py-10 text-muted-foreground">
            <Loader2 className="mr-2 size-4 animate-spin" /> Loading…
          </div>
        ) : messages.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-10 text-center text-muted-foreground">
            <MessageSquare className="mb-2 size-6" />
            <div className="text-sm">No messages yet — say hello.</div>
          </div>
        ) : (
          messages.map((m: any) => {
            const mine = m.senderType === viewerRole;
            return (
              <div key={m.id} className={cn("flex", mine ? "justify-end" : "justify-start")}>
                <div
                  className={cn(
                    "max-w-[75%] rounded-lg px-3 py-2 text-sm shadow-sm",
                    mine
                      ? "bg-primary text-primary-foreground"
                      : "bg-background border",
                  )}
                >
                    {m.senderName && (
                      <div className={cn("mb-1 text-[11px] font-semibold", mine ? "text-primary-foreground/80" : "text-foreground")}>
                        {m.senderName}
                      </div>
                    )}
                  <div className="whitespace-pre-wrap break-words">{m.body}</div>
                  <div
                    className={cn(
                      "mt-1 flex items-center gap-1 text-[10px] uppercase tracking-wide",
                      mine ? "text-primary-foreground/70" : "text-muted-foreground",
                    )}
                  >
                    <span>{format(new Date(m.createdAt), "MMM d, h:mm a")}</span>
                    {m.channel === "email" && (
                      <span className="inline-flex items-center gap-0.5">
                        · <Mail className="size-3" /> email
                      </span>
                    )}
                  </div>
                </div>
              </div>
            );
          })
        )}
      </div>

      <form
        onSubmit={(e) => {
          e.preventDefault();
          const trimmed = body.trim();
          if (!trimmed) return;
          mutation.mutate({ body: trimmed, channel });
        }}
        className="mt-3 space-y-2"
      >
        <Textarea
          value={body}
          onChange={(e) => setBody(e.target.value)}
          placeholder="Write a message…"
          rows={3}
          maxLength={5000}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              const trimmed = body.trim();
              if (trimmed) mutation.mutate({ body: trimmed, channel });
            }
          }}
        />
        <div className="flex items-center justify-between gap-2">
          {viewerRole === "staff" ? (
            <div className="flex items-center gap-1 text-xs">
              <button
                type="button"
                onClick={() => setChannel("in_app")}
                className={cn(
                  "rounded-md px-2 py-1 font-medium",
                  channel === "in_app"
                    ? "bg-primary/10 text-primary"
                    : "text-muted-foreground hover:bg-muted",
                )}
              >
                In-app
              </button>
              <button
                type="button"
                onClick={() => setChannel("email")}
                className={cn(
                  "inline-flex items-center gap-1 rounded-md px-2 py-1 font-medium",
                  channel === "email"
                    ? "bg-primary/10 text-primary"
                    : "text-muted-foreground hover:bg-muted",
                )}
              >
                <Mail className="size-3" /> Email
              </button>
            </div>
          ) : (
            <div className="text-xs text-muted-foreground">
              Cmd/Ctrl+Enter to send
            </div>
          )}
          <Button type="submit" size="sm" disabled={mutation.isPending || !body.trim()}>
            {mutation.isPending ? (
              <Loader2 className="mr-1 size-4 animate-spin" />
            ) : (
              <Send className="mr-1 size-4" />
            )}
            Send
          </Button>
        </div>
      </form>
    </div>
  );
}
