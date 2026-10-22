import { useEffect, useRef, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { Sparkles, Send, Loader2, X, Copy, FileText, FileSpreadsheet } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { askSensei, getAnalyticsSnapshot } from "@/lib/sensei.functions";
import { useAuth } from "@/hooks/use-auth";
import { useCurrentDojo } from "@/hooks/use-current-dojo";
import { cn } from "@/lib/utils";

type Msg = { role: "user" | "assistant"; content: string };

const SUGGESTIONS = [
  "Who's at risk of quitting and why?",
  "Who's ready to grade?",
  "Which members owe me money this month?",
  "Where am I losing members?",
  "How's my retention trending?",
  "Explain what I'm looking at on this screen",
  "Attendance patterns for members who churned last year",
  "Which plan drives the most lifetime revenue?",
  "Which weekday is underutilised?",
];

export function SenseiWidget() {
  const { session, viewAs } = useAuth();
  const { activeDojo, activeDojoId } = useCurrentDojo();
  const realRole = activeDojo?.role;
  const isRealDojoStaff = realRole === "owner" || realRole === "admin" || realRole === "coach";
  const ask = useServerFn(askSensei);
  const getSnapshot = useServerFn(getAnalyticsSnapshot);
  const [open, setOpen] = useState(false);
  const [messages, setMessages] = useState<Msg[]>([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [phase, setPhase] = useState<"idle" | "snapshot" | "ai">("idle");
  const scrollRef = useRef<HTMLDivElement>(null);
  const hidden = !session || !activeDojoId || !isRealDojoStaff || viewAs === "member";

  useEffect(() => {
    if (open) {
      requestAnimationFrame(() => {
        scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
      });
    }
  }, [open, messages, loading]);

  if (hidden) return null;


  /**
   * Where the user is, and nothing more.
   *
   * This used to send up to 2,800 characters of the page's visible text, so
   * asking Sensei anything while a member's profile was open sent that
   * member's details out to the AI -- names tokenised, but still one person's
   * record. Sensei has the aggregate snapshot and the question the user
   * actually typed; it does not need a copy of the screen.
   *
   * Ids are stripped from the path for the same reason: /members/<uuid> is an
   * identifier, and no identifier leaves the system.
   */
  function capturePageContext() {
    if (typeof window === "undefined") return undefined;
    const path = window.location.pathname.replace(
      /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi,
      ":id",
    );
    const title = document.title;
    const heading =
      document.querySelector("h1")?.textContent?.trim() ??
      document.querySelector("h2")?.textContent?.trim() ??
      "";
    return { path, title, heading };
  }

  async function send(text: string) {
    const trimmed = text.trim();
    if (!trimmed || loading || !activeDojoId) return;
    const next: Msg[] = [...messages, { role: "user", content: trimmed }];
    setMessages(next);
    setInput("");
    setLoading(true);
    setPhase("snapshot");
    try {
      const pageContext = capturePageContext();
      const snapshot = await getSnapshot({ data: { dojoId: activeDojoId } });
      setPhase("ai");
      const result = await ask({ data: { messages: next, snapshot, pageContext, dojoId: activeDojoId } });
      setMessages((prev) => [
        ...prev,
        { role: "assistant", content: result.reply ?? result.error ?? "No response." },
      ]);
    } catch {
      setMessages((prev) => [
        ...prev,
        { role: "assistant", content: "Sensei is unavailable right now." },
      ]);
    } finally {
      setLoading(false);
      setPhase("idle");
    }
  }

  function transcriptText() {
    const now = new Date().toLocaleString();
    const header = `Sensei Chat Transcript\nExported: ${now}\n---\n`;
    const body = messages.map((m) => `${m.role === "user" ? "You" : "Sensei"}: ${m.content}`).join("\n\n");
    return header + body + "\n";
  }

  function downloadText() {
    const blob = new Blob([transcriptText()], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `sensei-transcript-${new Date().toISOString().slice(0, 10)}.txt`;
    a.click();
    URL.revokeObjectURL(url);
  }

  function downloadCSV() {
    const rows = messages.map((m) => ({
      timestamp: new Date().toISOString(),
      role: m.role,
      content: `"${m.content.replace(/"/g, '""')}"`,
    }));
    const header = "timestamp,role,content\n";
    const csv = header + rows.map((r) => `${r.timestamp},${r.role},${r.content}`).join("\n") + "\n";
    const blob = new Blob([csv], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `sensei-transcript-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  async function copyTranscript() {
    try {
      await navigator.clipboard.writeText(transcriptText());
    } catch {
      // ignore
    }
  }

  return (
    <>
      {/* Floating launcher */}
      <button
        data-sensei-widget
        aria-label="Open Sensei AI"
        onClick={() => setOpen((v) => !v)}
        className={cn(
          "fixed bottom-6 right-6 z-50 flex h-14 w-14 items-center justify-center rounded-full bg-primary text-primary-foreground shadow-lg transition-transform hover:scale-105",
          open && "scale-90",
        )}
      >
        {open ? <X className="h-5 w-5" /> : <Sparkles className="h-5 w-5" />}
      </button>

      {/* Panel */}
      {open ? (
        <div data-sensei-widget className="fixed bottom-24 right-6 z-50 flex h-[560px] max-h-[calc(100vh-8rem)] w-[380px] max-w-[calc(100vw-3rem)] flex-col overflow-hidden rounded-xl border border-zinc-950/10 bg-card shadow-2xl">
          <div className="flex items-center gap-2 border-b border-zinc-950/5 px-4 py-3">
            <div className="flex h-8 w-8 items-center justify-center rounded-md bg-primary/10 text-primary">
              <Sparkles className="h-4 w-4" />
            </div>
            <div className="flex-1">
              <div className="font-display text-sm font-medium">Sensei</div>
              <div className="text-[11px] text-muted-foreground">
                Your dojo's analytics co-pilot
              </div>
            </div>
            <button
              onClick={() => setOpen(false)}
              className="rounded-md p-1 text-muted-foreground hover:bg-muted"
              aria-label="Close"
            >
              <X className="h-4 w-4" />
            </button>
          </div>

          <div ref={scrollRef} className="flex-1 space-y-3 overflow-y-auto px-4 py-4">
            {messages.length === 0 ? (
              <div className="space-y-3">
                <p className="text-xs text-muted-foreground">
                  Ask about revenue, churn, retention, LTV, attendance, fill rate, members…
                </p>
                <div className="flex flex-wrap gap-2">
                  {SUGGESTIONS.map((s) => (
                    <button
                      key={s}
                      onClick={() => send(s)}
                      className="rounded-full border border-zinc-950/10 bg-background px-3 py-1.5 text-xs hover:bg-muted"
                    >
                      {s}
                    </button>
                  ))}
                </div>
              </div>
            ) : (
              messages.map((m, i) => (
                <div
                  key={i}
                  className={
                    m.role === "user"
                      ? "ml-auto max-w-[85%] rounded-lg bg-primary px-3 py-2 text-sm text-primary-foreground"
                      : "mr-auto max-w-[90%] whitespace-pre-wrap rounded-lg bg-muted px-3 py-2 text-sm text-foreground"
                  }
                >
                  {m.content}
                </div>
              ))
            )}
            {loading ? (
              <div className="mr-auto flex items-center gap-2 rounded-lg bg-muted px-3 py-2 text-sm text-muted-foreground">
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                {phase === "snapshot"
                  ? "Pulling latest analytics snapshot…"
                  : "Sensei is thinking…"}
              </div>
            ) : null}
          </div>

          <form
            onSubmit={(e) => {
              e.preventDefault();
              send(input);
            }}
            className="flex items-center gap-2 border-t border-zinc-950/5 px-3 py-3"
          >
            <Input
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder={activeDojoId ? "Ask Sensei…" : "Select a dojo to use Sensei."}
              disabled={loading || !activeDojoId}
              className="h-9"
            />
            <Button type="submit" disabled={loading || !input.trim() || !activeDojoId} size="sm">
              <Send className="h-4 w-4" />
            </Button>
          </form>
          {messages.length > 0 && (
            <div className="flex items-center justify-between border-t border-zinc-950/5 px-3 py-2">
              <span className="text-[11px] text-muted-foreground">{messages.length} messages</span>
              <div className="flex items-center gap-1">
                <button
                  onClick={copyTranscript}
                  className="rounded-md p-1.5 text-muted-foreground hover:bg-muted"
                  title="Copy transcript"
                >
                  <Copy className="h-3.5 w-3.5" />
                </button>
                <button
                  onClick={downloadText}
                  className="rounded-md p-1.5 text-muted-foreground hover:bg-muted"
                  title="Download as text"
                >
                  <FileText className="h-3.5 w-3.5" />
                </button>
                <button
                  onClick={downloadCSV}
                  className="rounded-md p-1.5 text-muted-foreground hover:bg-muted"
                  title="Download as CSV"
                >
                  <FileSpreadsheet className="h-3.5 w-3.5" />
                </button>
              </div>
            </div>
          )}
        </div>
      ) : null}
    </>
  );
}
