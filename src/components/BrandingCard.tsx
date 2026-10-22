import { useRef, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Logo } from "@/components/Logo";
import { useDojoLogoUrl } from "@/hooks/use-dojo-logo";
import { useCurrentDojo } from "@/hooks/use-current-dojo";
import { uploadDojoLogo, removeDojoLogo } from "@/lib/branding.functions";
import {
  LOGO_ACCEPT,
  LOGO_MAX_DIMENSION,
  bytesToBase64,
  validateLogoBytes,
} from "@/lib/dojo-logo";
import { ImageUp, Trash2, Loader2 } from "lucide-react";

/**
 * Settings → Branding. Owners/admins upload their gym logo, preview how it
 * looks in the sidebar, and can remove it to revert to Sthenos branding.
 */
export function BrandingCard({ dojoId, canEdit }: { dojoId: string | null; canEdit: boolean }) {
  const qc = useQueryClient();
  const { activeDojo, refresh } = useCurrentDojo();
  const logoUrl = useDojoLogoUrl(activeDojo?.logoPath);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  const upload = useServerFn(uploadDojoLogo);
  const remove = useServerFn(removeDojoLogo);

  const afterChange = async () => {
    qc.invalidateQueries({ queryKey: ["dojo-logo-url"] });
    qc.invalidateQueries({ queryKey: ["dojo-settings", dojoId] });
    await refresh();
  };

  const uploadMutation = useMutation({
    mutationFn: async (file: File) => {
      if (!dojoId) throw new Error("No active dojo");
      const bytes = new Uint8Array(await file.arrayBuffer());
      // Client-side check for fast feedback; the server re-verifies the bytes.
      validateLogoBytes(bytes);
      return upload({ data: { dojoId, fileBase64: bytesToBase64(bytes) } });
    },
    onSuccess: async () => {
      setError(null);
      toast.success("Logo updated");
      await afterChange();
    },
    onError: (e: Error) => {
      setError(e.message);
      toast.error(e.message);
    },
  });

  const removeMutation = useMutation({
    mutationFn: async () => {
      if (!dojoId) throw new Error("No active dojo");
      return remove({ data: { dojoId } });
    },
    onSuccess: async () => {
      setError(null);
      toast.success("Logo removed — using Sthenos branding");
      await afterChange();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const busy = uploadMutation.isPending || removeMutation.isPending;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Branding</CardTitle>
        <CardDescription>
          Use your own logo and gym name in the sidebar, member portal and public signup page.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="rounded-lg border bg-sidebar p-4">
          <div className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-sidebar-foreground/50">
            Sidebar preview
          </div>
          {logoUrl ? (
            <div className="flex min-w-0 items-center gap-3">
              <img
                src={logoUrl}
                alt={`${activeDojo?.name ?? "Dojo"} logo`}
                className="size-9 shrink-0 rounded-md object-contain"
              />
              <span className="truncate font-display text-lg font-semibold leading-tight tracking-tight text-sidebar-foreground">
                {activeDojo?.name ?? "Dojo"}
              </span>
            </div>
          ) : (
            <Logo
              markClassName="text-brand"
              wordmarkClassName="text-sidebar-foreground"
              taglineClassName="text-sidebar-foreground/60 opacity-100"
              showTagline
            />
          )}
        </div>

        <input
          ref={inputRef}
          type="file"
          accept={LOGO_ACCEPT}
          className="hidden"
          onChange={(e) => {
            const file = e.target.files?.[0];
            e.target.value = "";
            if (!file) return;
            setError(null);
            uploadMutation.mutate(file);
          }}
        />

        <div className="flex flex-wrap gap-2">
          <Button
            type="button"
            variant="outline"
            disabled={!canEdit || busy}
            onClick={() => inputRef.current?.click()}
          >
            {uploadMutation.isPending ? (
              <Loader2 className="mr-2 size-4 animate-spin" />
            ) : (
              <ImageUp className="mr-2 size-4" />
            )}
            {activeDojo?.logoPath ? "Replace logo" : "Upload logo"}
          </Button>
          {activeDojo?.logoPath && (
            <Button
              type="button"
              variant="ghost"
              disabled={!canEdit || busy}
              onClick={() => removeMutation.mutate()}
            >
              <Trash2 className="mr-2 size-4" />
              Remove logo
            </Button>
          )}
        </div>

        {error && (
          <p className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
            {error}
          </p>
        )}

        <p className="text-xs text-muted-foreground">
          PNG, JPG or WEBP up to 2MB and {LOGO_MAX_DIMENSION}x{LOGO_MAX_DIMENSION}px. SVG files are
          not accepted. A square logo looks best.
        </p>
      </CardContent>
    </Card>
  );
}
