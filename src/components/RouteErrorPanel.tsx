import { useRouter } from "@tanstack/react-router";
import { AlertTriangle } from "lucide-react";
import { Button } from "@/components/ui/button";

/**
 * Visible fallback for a route that failed to render, so staff never get a
 * blank screen when a component throws.
 */
export function RouteErrorPanel({
  error,
  reset,
  title = "This page didn't load",
}: {
  error: Error;
  reset: () => void;
  title?: string;
}) {
  const router = useRouter();
  return (
    <div className="mx-auto max-w-xl p-6">
      <div className="rounded-xl border border-destructive/30 bg-destructive/5 p-6">
        <h1 className="flex items-center gap-2 text-base font-semibold">
          <AlertTriangle className="size-4 text-destructive" /> {title}
        </h1>
        <p className="mt-2 text-sm text-muted-foreground">
          Something went wrong while showing this page. Nothing was changed. You can try
          again, and if it keeps happening send us the message below.
        </p>
        <pre className="mt-3 max-h-48 overflow-auto rounded-lg bg-background/80 p-3 text-xs text-destructive">
          {error?.message ?? String(error)}
        </pre>
        <div className="mt-4 flex gap-2">
          <Button
            size="sm"
            onClick={() => {
              router.invalidate();
              reset();
            }}
          >
            Try again
          </Button>
          <Button size="sm" variant="outline" onClick={() => router.navigate({ to: "/" })}>
            Back to dashboard
          </Button>
        </div>
      </div>
    </div>
  );
}
