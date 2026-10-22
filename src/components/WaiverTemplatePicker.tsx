import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { FileText, LibraryBig, ShieldAlert, ArrowLeft } from "lucide-react";

type WaiverTemplate = {
  id: string;
  name: string;
  discipline: string | null;
  body_markdown: string;
};

/**
 * "Start from a template" helper inside the waiver editor.
 * Lists the shared waiver_templates library (RLS scopes it to the gym's own
 * templates plus the shared ones), previews one, and inserts it into the editor.
 */
export function WaiverTemplatePicker({
  onInsert,
}: {
  onInsert: (template: { name: string; body: string }) => void;
}) {
  const [open, setOpen] = useState(false);
  const [previewId, setPreviewId] = useState<string | null>(null);

  const query = useQuery<WaiverTemplate[], { code?: string; message: string }>({
    queryKey: ["waiver-templates"],
    enabled: open,
    retry: false,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("waiver_templates")
        .select("id, name, discipline, body_markdown")
        .order("name");
      if (error) throw { code: error.code, message: error.message };
      return (data ?? []) as WaiverTemplate[];
    },
  });

  const preview = query.data?.find((t) => t.id === previewId) ?? null;

  function close() {
    setOpen(false);
    setPreviewId(null);
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        setOpen(v);
        if (!v) setPreviewId(null);
      }}
    >
      <DialogTrigger asChild>
        <Button type="button" variant="outline" size="sm" className="gap-2">
          <LibraryBig className="size-4" /> Start from a template
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>{preview ? preview.name : "Waiver templates"}</DialogTitle>
          <DialogDescription>
            {preview
              ? "Preview the wording, then insert it into the editor to customise before publishing."
              : "Pick a starting point from the shared library. Inserting replaces the text in the editor — nothing is published until you save."}
          </DialogDescription>
        </DialogHeader>

        {query.isLoading ? (
          <div className="space-y-3">
            <Skeleton className="h-20 w-full" />
            <Skeleton className="h-20 w-full" />
          </div>
        ) : query.isError ? (
          <Alert variant="destructive">
            <ShieldAlert className="size-4" />
            <AlertTitle>Couldn't load templates</AlertTitle>
            <AlertDescription className="space-y-2">
              <p>
                {query.error?.code === "42501" ||
                /permission|denied|rls/i.test(query.error?.message ?? "")
                  ? "Your account isn't authorised to read waiver templates. Ask an owner to restore your access."
                  : query.error?.message || "Something went wrong. Please try again."}
              </p>
              <Button size="sm" variant="outline" onClick={() => query.refetch()}>
                Try again
              </Button>
            </AlertDescription>
          </Alert>
        ) : preview ? (
          <div className="space-y-3">
            {preview.discipline ? <Badge variant="secondary">{preview.discipline}</Badge> : null}
            <pre className="max-h-72 overflow-auto whitespace-pre-wrap rounded-md bg-muted p-3 text-sm">
              {preview.body_markdown}
            </pre>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <Button variant="ghost" size="sm" className="gap-2" onClick={() => setPreviewId(null)}>
                <ArrowLeft className="size-4" /> Back to templates
              </Button>
              <Button
                className="gap-2"
                onClick={() => {
                  onInsert({ name: preview.name, body: preview.body_markdown });
                  close();
                }}
              >
                <FileText className="size-4" /> Use this template
              </Button>
            </div>
          </div>
        ) : (query.data?.length ?? 0) === 0 ? (
          <p className="text-sm text-muted-foreground">
            The shared waiver library is empty. Write your own waiver in the editor instead.
          </p>
        ) : (
          <div className="max-h-80 space-y-2 overflow-auto pr-1">
            {query.data?.map((t) => (
              <button
                key={t.id}
                type="button"
                onClick={() => setPreviewId(t.id)}
                className="flex w-full flex-col items-start gap-1 rounded-md border border-border p-3 text-left transition-colors hover:bg-accent"
              >
                <span className="flex items-center gap-2 text-sm font-medium">
                  <FileText className="size-4 text-brand" /> {t.name}
                </span>
                {t.discipline ? (
                  <Badge variant="secondary" className="text-[11px]">
                    {t.discipline}
                  </Badge>
                ) : null}
                <span className="line-clamp-2 text-xs text-muted-foreground">
                  {t.body_markdown}
                </span>
              </button>
            ))}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
