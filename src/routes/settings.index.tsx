import { PUBLIC_SITE_URL } from "@/lib/site";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useCurrentDojo } from "@/hooks/use-current-dojo";
import { PageHeader } from "@/components/PageHeader";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { toast } from "sonner";
import { MemberSignupLinkCard } from "@/components/MemberSignupLinkCard";
import { EmailSettingsCard } from "@/components/EmailSettingsCard";
import { BrandingCard } from "@/components/BrandingCard";
import { DataExportCard } from "@/components/DataExportCard";
import { DataRetentionCard } from "@/components/DataRetentionCard";
import { PartnerMatchingCard } from "@/components/PartnerMatchingCard";
import { useAuth } from "@/hooks/use-auth";
import { CreditCard, ListChecks, ChevronRight, AlertTriangle, Copy, FileText, Mail } from "lucide-react";

export const Route = createFileRoute("/settings/")({
  head: () => ({
    meta: [
      { title: "Settings \u2014 Sthenos" },
      { name: "description", content: "Configure your dojo profile, team, and public signup page." },
      { property: "og:title", content: "Settings \u2014 Sthenos" },
      { property: "og:description", content: "Configure your dojo profile, team, and public signup page." },
      { property: "og:url", content: `${PUBLIC_SITE_URL}/settings` },
      { name: "twitter:title", content: "Settings \u2014 Sthenos" },
      { name: "twitter:description", content: "Configure your dojo profile, team, and public signup page." },
    ],
    links: [
      { rel: "canonical", href: `${PUBLIC_SITE_URL}/settings` },
    ],
  }),
  component: SettingsPage,
});

const ACTIVE_DOJO_KEY = "sthenos.activeDojoId";

type DojoRow = {
  id: string;
  name: string;
  slug: string;
  public_page_enabled: boolean;
  contact_email: string | null;
  description: string | null;
  archived_at: string | null;
};

type StaffRow = {
  user_id: string;
  role: string;
  email: string | null;
  display_name: string | null;
};

function SettingsPage() {
  const { activeDojoId, activeDojo, refresh } = useCurrentDojo();
  const role = activeDojo?.role;
  const isOwner = role === "owner";
  const canEdit = isOwner || role === "admin";

  return (
    <main>
      <PageHeader title="Settings" subtitle="Dojo preferences, staff roles, and integrations" />
      <div className="mx-auto max-w-4xl space-y-6 p-6">
        {!canEdit && (
          <div className="rounded-lg border border-amber-300 bg-amber-100 px-4 py-3 text-sm text-amber-900">
            You need admin access to edit settings.
          </div>
        )}

        <Tabs defaultValue="general">
          <TabsList>
            <TabsTrigger value="general">General</TabsTrigger>
            <TabsTrigger value="team">Team</TabsTrigger>
            <TabsTrigger value="public">Public Page</TabsTrigger>
            <TabsTrigger value="danger">Danger Zone</TabsTrigger>
          </TabsList>

          <TabsContent value="general" className="mt-4 space-y-4">
            <GeneralTab dojoId={activeDojoId} canEdit={canEdit} onSaved={refresh} />
            <BrandingCard dojoId={activeDojoId} canEdit={canEdit} />
            <MemberSignupLinkCard dojoId={activeDojoId} canEdit={canEdit} />
            <EmailSettingsCard dojoId={activeDojoId!} canEdit={canEdit} />
            <DojoCodeCard dojoId={activeDojoId} canEdit={canEdit} />
            <PartnerMatchingCard dojoId={activeDojoId} canEdit={canEdit} />
            <DataExportCard dojoId={activeDojoId} canExport={canEdit} />
            <DataRetentionCard dojoId={activeDojoId} canEdit={canEdit} />
            <MoreSettingsLinks />
          </TabsContent>

          <TabsContent value="team" className="mt-4">
            <TeamTab dojoId={activeDojoId} isOwner={isOwner} canEdit={canEdit} />
          </TabsContent>

          <TabsContent value="public" className="mt-4">
            <PublicPageTab dojoId={activeDojoId} canEdit={canEdit} />
          </TabsContent>

          <TabsContent value="danger" className="mt-4">
            <div className="space-y-4">
              <ArchivedDojosCard isOwner={isOwner} />
              <DangerZone dojoId={activeDojoId} dojoName={activeDojo?.name ?? ""} isOwner={isOwner} />
            </div>
          </TabsContent>
        </Tabs>
      </div>
    </main>
  );
}

function GeneralTab({
  dojoId,
  canEdit,
  onSaved,
}: {
  dojoId: string | null;
  canEdit: boolean;
  onSaved: () => Promise<void>;
}) {
  const qc = useQueryClient();
  const { data, isLoading } = useQuery({
    queryKey: ["dojo-settings", dojoId],
    enabled: !!dojoId,
    queryFn: async (): Promise<DojoRow | null> => {
      const { data, error } = await supabase
        .from("dojos")
        .select("id, name, slug, public_page_enabled, contact_email, description, archived_at")
        .eq("id", dojoId!)
        .maybeSingle();
      if (error) throw error;
      return (data ?? null) as DojoRow | null;
    },
  });

  const [name, setName] = useState("");
  const [contactEmail, setContactEmail] = useState("");
  const [description, setDescription] = useState("");

  useEffect(() => {
    if (!data) return;
    setName(data.name ?? "");
    setContactEmail(data.contact_email ?? "");
    setDescription(data.description ?? "");
  }, [data]);

  const save = useMutation({
    mutationFn: async () => {
      if (!dojoId) throw new Error("No active dojo");
      if (!name.trim()) throw new Error("Dojo name is required");
      const { error } = await supabase
        .from("dojos")
        .update({
          name: name.trim(),
          contact_email: contactEmail.trim() || null,
          description: description.trim() || null,
        } as never)
        .eq("id", dojoId);
      if (error) throw error;
    },
    onSuccess: async () => {
      toast.success("Settings saved");
      qc.invalidateQueries({ queryKey: ["dojo-settings", dojoId] });
      await onSaved();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const publicUrl = data?.slug ? `${PUBLIC_SITE_URL}/j/${data.slug}` : "";

  const disabled = !canEdit || isLoading;

  return (
    <Card>
      <CardHeader>
        <CardTitle>General</CardTitle>
        <CardDescription>Basic information about your dojo.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="space-y-2">
          <Label htmlFor="dojo-name">Dojo name</Label>
          <Input
            id="dojo-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            disabled={disabled}
          />
        </div>

        <div className="space-y-2">
          <Label>Public page URL</Label>
          <div className="flex gap-2">
            <Input
              readOnly
              value={publicUrl || `${origin}/j/${data?.slug ?? ""}`}
              className="bg-muted/40 text-muted-foreground"
            />
            <Button
              type="button"
              variant="outline"
              size="icon"
              onClick={() => {
                if (!publicUrl) return;
                navigator.clipboard.writeText(publicUrl);
                toast.success("Link copied");
              }}
              disabled={!publicUrl}
              aria-label="Copy link"
            >
              <Copy className="size-4" />
            </Button>
          </div>
        </div>

        <div className="space-y-2">
          <Label htmlFor="dojo-email">Contact email</Label>
          <Input
            id="dojo-email"
            type="email"
            value={contactEmail}
            onChange={(e) => setContactEmail(e.target.value)}
            disabled={disabled}
          />
        </div>

        <div className="space-y-2">
          <Label htmlFor="dojo-desc">Description</Label>
          <Textarea
            id="dojo-desc"
            rows={4}
            maxLength={300}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            disabled={disabled}
          />
          <div className="text-right text-xs text-muted-foreground">{description.length}/300</div>
        </div>

        <div className="flex justify-end">
          <Button onClick={() => save.mutate()} disabled={disabled || save.isPending || !name.trim()}>
            {save.isPending ? "Saving…" : "Save changes"}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

function TeamTab({
  dojoId,
  isOwner,
  canEdit,
}: {
  dojoId: string | null;
  isOwner: boolean;
  canEdit: boolean;
}) {
  const qc = useQueryClient();

  const { data: staff, isLoading } = useQuery({
    queryKey: ["settings-team", dojoId],
    enabled: !!dojoId,
    queryFn: async (): Promise<StaffRow[]> => {
      const { data: rows, error } = await supabase
        .from("dojo_memberships")
        .select("user_id, role")
        .eq("dojo_id", dojoId!)
        .in("role", ["owner", "admin", "coach"]);
      if (error) throw error;
      const ids = (rows ?? []).map((r) => r.user_id);
      if (ids.length === 0) return [];
      const { data: profiles } = await supabase
        .from("profiles")
        .select("user_id, email, display_name")
        .in("user_id", ids);
      const map = new Map(profiles?.map((p) => [p.user_id, p]) ?? []);
      return (rows ?? []).map((r) => ({
        user_id: r.user_id,
        role: r.role,
        email: map.get(r.user_id)?.email ?? null,
        display_name: map.get(r.user_id)?.display_name ?? null,
      }));
    },
  });

  const changeRole = useMutation({
    mutationFn: async ({ userId, role }: { userId: string; role: "admin" | "coach" }) => {
      if (!dojoId) throw new Error("No active dojo");
      const { error } = await supabase
        .from("dojo_memberships")
        .upsert({ user_id: userId, dojo_id: dojoId, role }, { onConflict: "user_id,dojo_id" });
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success("Role updated");
      qc.invalidateQueries({ queryKey: ["settings-team", dojoId] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const remove = useMutation({
    mutationFn: async (userId: string) => {
      if (!dojoId) throw new Error("No active dojo");
      const { error } = await supabase
        .from("dojo_memberships")
        .upsert({ user_id: userId, dojo_id: dojoId, role: "member" }, { onConflict: "user_id,dojo_id" });
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success("Removed from team");
      qc.invalidateQueries({ queryKey: ["settings-team", dojoId] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle>Team</CardTitle>
        <CardDescription>Staff with access to manage this dojo.</CardDescription>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : (staff ?? []).length === 0 ? (
          <p className="text-sm text-muted-foreground">No staff yet.</p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>Email</TableHead>
                <TableHead>Role</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {(staff ?? []).map((s) => {
                const isProtected = s.role === "owner";
                return (
                  <TableRow key={s.user_id}>
                    <TableCell>{s.display_name ?? "—"}</TableCell>
                    <TableCell className="text-muted-foreground">{s.email ?? "—"}</TableCell>
                    <TableCell>
                      <Badge variant="secondary" className="capitalize">{s.role}</Badge>
                    </TableCell>
                    <TableCell className="text-right">
                      {isOwner && !isProtected ? (
                        <div className="flex items-center justify-end gap-2">
                          <Select
                            value={s.role}
                            onValueChange={(v) =>
                              changeRole.mutate({ userId: s.user_id, role: v as "admin" | "coach" })
                            }
                          >
                            <SelectTrigger className="h-8 w-32">
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              <SelectItem value="admin">Admin</SelectItem>
                              <SelectItem value="coach">Coach</SelectItem>
                            </SelectContent>
                          </Select>
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => remove.mutate(s.user_id)}
                            disabled={remove.isPending}
                          >
                            Remove
                          </Button>
                        </div>
                      ) : (
                        <span className="text-xs text-muted-foreground">
                          {canEdit ? "Owner only" : "—"}
                        </span>
                      )}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  );
}

type ArchivedDojo = { id: string; name: string; slug: string; archived_at: string | null };

function ArchivedDojosCard({ isOwner }: { isOwner: boolean }) {
  const { user } = useAuth();
  const { refresh } = useCurrentDojo();
  const qc = useQueryClient();
  const { data = [], isLoading } = useQuery({
    queryKey: ["archived-dojos", user?.id],
    enabled: isOwner && !!user?.id,
    queryFn: async (): Promise<ArchivedDojo[]> => {
      const { data, error } = await supabase
        .from("dojos")
        .select("id, name, slug, archived_at")
        .eq("owner_user_id", user!.id)
        .not("archived_at", "is", null)
        .order("archived_at", { ascending: false });
      if (error) throw error;
      return (data ?? []) as ArchivedDojo[];
    },
  });

  const restore = useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase
        .from("dojos")
        .update({ archived_at: null } as never)
        .eq("id", id);
      if (error) throw error;
    },
    onSuccess: async () => {
      toast.success("Dojo restored");
      qc.invalidateQueries({ queryKey: ["archived-dojos", user?.id] });
      await refresh();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  if (!isOwner) return null;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Archived dojos</CardTitle>
        <CardDescription>
          Archived dojos are hidden from the switcher but nothing is deleted. Restore one to bring it
          back.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : data.length === 0 ? (
          <p className="text-sm text-muted-foreground">No archived dojos.</p>
        ) : (
          <div className="space-y-2">
            {data.map((d) => (
              <div key={d.id} className="flex items-center justify-between rounded-lg border p-3">
                <div>
                  <div className="text-sm font-semibold">{d.name}</div>
                  <div className="text-xs text-muted-foreground">
                    Archived{" "}
                    {d.archived_at ? new Date(d.archived_at).toLocaleDateString() : ""} · /j/{d.slug}
                  </div>
                </div>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={restore.isPending}
                  onClick={() => restore.mutate(d.id)}
                >
                  Restore
                </Button>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function DangerZone({
  dojoId,
  dojoName,
  isOwner,
}: {
  dojoId: string | null;
  dojoName: string;
  isOwner: boolean;
}) {
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [confirm, setConfirm] = useState("");

  const archive = useMutation({
    mutationFn: async () => {
      if (!dojoId) throw new Error("No active dojo");
      const { error } = await supabase
        .from("dojos")
        .update({ archived_at: new Date().toISOString() } as never)
        .eq("id", dojoId);
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success("Dojo archived");
      if (typeof window !== "undefined") window.localStorage.removeItem(ACTIVE_DOJO_KEY);
      setOpen(false);
      navigate({ to: "/onboarding" });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  if (!isOwner) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Danger zone</CardTitle>
          <CardDescription>Only the dojo owner can access destructive actions.</CardDescription>
        </CardHeader>
      </Card>
    );
  }

  return (
    <Card className="border-destructive/40">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-destructive">
          <AlertTriangle className="size-5" /> Danger zone
        </CardTitle>
        <CardDescription>
          Archiving hides the dojo from staff and members. Nothing is deleted — members, invoices
          and history are kept, and you can restore it from “Archived dojos” above.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <Button variant="destructive" onClick={() => setOpen(true)}>
          Archive dojo
        </Button>
      </CardContent>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Archive “{dojoName}”?</DialogTitle>
            <DialogDescription>
              Type the dojo name <span className="font-semibold">{dojoName}</span> to confirm.
            </DialogDescription>
          </DialogHeader>
          <Input
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            placeholder={dojoName}
          />
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              disabled={confirm !== dojoName || archive.isPending}
              onClick={() => archive.mutate()}
            >
              {archive.isPending ? "Archiving…" : "Archive dojo"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}

function DojoCodeCard({ dojoId, canEdit }: { dojoId: string | null; canEdit: boolean }) {
  const { data } = useQuery({
    queryKey: ["dojo-code", dojoId],
    enabled: !!dojoId && canEdit,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("dojos")
        .select("slug")
        .eq("id", dojoId!)
        .maybeSingle();
      if (error) throw error;
      return data;
    },
  });

  if (!canEdit) return null;
  const code = data?.slug ?? "";

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Your dojo code</CardTitle>
        <CardDescription>
          Share this code with members so they can join via the "Join existing" flow.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div className="flex gap-2">
          <Input readOnly value={code} className="bg-muted/40 font-mono" />
          <Button
            type="button"
            variant="outline"
            size="icon"
            onClick={() => {
              if (!code) return;
              navigator.clipboard.writeText(code);
              toast.success("Dojo code copied");
            }}
            disabled={!code}
            aria-label="Copy dojo code"
          >
            <Copy className="size-4" />
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

function MoreSettingsLinks() {
  const items = [
    { to: "/settings/payments", icon: CreditCard, title: "Payment setup", description: "Connect Stripe to accept member payments." },
    { to: "/settings/plans", icon: CreditCard, title: "Membership plans", description: "Plans athletes choose at signup." },
    { to: "/settings/class-types", icon: ListChecks, title: "Class types", description: "Class types for scheduling." },
    // "Overheads & revenue" was here. It lives on Billing now, beside the rest
    // of the money, because recording rent is bookkeeping rather than setup.
    { to: "/settings/agreements", icon: FileText, title: "Member agreements", description: "Waiver, terms & conditions and consent options." },
    { to: "/settings/email", icon: Mail, title: "Email health", description: "What has been sent, what failed, and a test send." },
    
    
    
  ] as const;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">More settings</CardTitle>
      </CardHeader>
      <CardContent className="space-y-2">
        {items.map((s) => (
          <Link
            key={s.to}
            to={s.to}
            className="flex items-center gap-4 rounded-lg p-3 ring-1 ring-black/5 transition-colors hover:bg-zinc-50/60"
          >
            <div className="grid size-9 place-items-center rounded-lg bg-brand/10 text-brand">
              <s.icon className="size-4" />
            </div>
            <div className="flex-1">
              <div className="text-sm font-semibold">{s.title}</div>
              <div className="text-xs text-muted-foreground">{s.description}</div>
            </div>
            <ChevronRight className="size-4 text-muted-foreground" />
          </Link>
        ))}
      </CardContent>
    </Card>
  );
}

function PublicPageTab({ dojoId, canEdit }: { dojoId: string | null; canEdit: boolean }) {
  const qc = useQueryClient();
  const { data, isLoading } = useQuery({
    queryKey: ["dojo-settings", dojoId],
    enabled: !!dojoId,
    queryFn: async (): Promise<DojoRow | null> => {
      const { data, error } = await supabase
        .from("dojos")
        .select("id, name, slug, public_page_enabled, contact_email, description, archived_at")
        .eq("id", dojoId!)
        .maybeSingle();
      if (error) throw error;
      return (data ?? null) as DojoRow | null;
    },
  });

  const [enabled, setEnabled] = useState(false);
  useEffect(() => {
    if (data) setEnabled(!!data.public_page_enabled);
  }, [data]);

  const toggle = useMutation({
    mutationFn: async (next: boolean) => {
      if (!dojoId) throw new Error("No active dojo");
      const { error } = await supabase
        .from("dojos")
        .update({ public_page_enabled: next } as never)
        .eq("id", dojoId);
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success("Updated");
      qc.invalidateQueries({ queryKey: ["dojo-settings", dojoId] });
    },
    onError: (e: Error) => {
      setEnabled((v) => !v);
      toast.error(e.message);
    },
  });

  const publicUrl = data?.slug ? `${PUBLIC_SITE_URL}/j/${data.slug}` : "";
  const disabled = !canEdit || isLoading;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Public Page</CardTitle>
        <CardDescription>Control your dojo's public signup page.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex items-center justify-between rounded-lg border p-3">
          <div>
            <div className="text-sm font-medium">Enable public signup page</div>
            <div className="text-xs text-muted-foreground">
              Allow new athletes to join via your public link.
            </div>
          </div>
          <Switch
            checked={enabled}
            disabled={disabled}
            onCheckedChange={(v) => {
              setEnabled(v);
              toggle.mutate(v);
            }}
          />
        </div>

        {enabled ? (
          <div className="space-y-2">
            <Label>Signup URL</Label>
            <div className="flex gap-2">
              <Input readOnly value={publicUrl} className="bg-muted/40" />
              <Button
                type="button"
                variant="outline"
                size="icon"
                onClick={() => {
                  if (!publicUrl) return;
                  navigator.clipboard.writeText(publicUrl);
                  toast.success("Link copied");
                }}
                aria-label="Copy link"
              >
                <Copy className="size-4" />
              </Button>
            </div>
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">Public signup is disabled</p>
        )}
      </CardContent>
    </Card>
  );
}
