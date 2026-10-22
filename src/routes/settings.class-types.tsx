import { PUBLIC_SITE_URL } from "@/lib/site";
import { useState } from "react";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { PageHeader } from "@/components/PageHeader";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Plus, Pencil, Trash2, ArrowLeft } from "lucide-react";
import { toast } from "sonner";
import { useCurrentDojo } from "@/hooks/use-current-dojo";
import {
  listClassTypes,
  upsertClassType,
  deleteClassType,
  type ClassType,
  type Discipline,
} from "@/lib/class-types.functions";

export const Route = createFileRoute("/settings/class-types")({
  head: () => ({
    meta: [
      { title: "Class types \u2014 Settings \u2014 Sthenos" },
      { name: "description", content: "Manage class types and disciplines available in your dojo." },
      { property: "og:title", content: "Class types \u2014 Settings \u2014 Sthenos" },
      { property: "og:description", content: "Manage class types and disciplines available in your dojo." },
      { property: "og:url", content: `${PUBLIC_SITE_URL}/settings/class-types` },
      { name: "twitter:title", content: "Class types \u2014 Settings \u2014 Sthenos" },
      { name: "twitter:description", content: "Manage class types and disciplines available in your dojo." },
    ],
    links: [
      { rel: "canonical", href: `${PUBLIC_SITE_URL}/settings/class-types` },
    ],
  }),
  component: ClassTypesPage,
});

const disciplines: Discipline[] = ["BJJ", "Judo", "Karate", "Muay Thai"];

type FormState = {
  id?: string;
  name: string;
  discipline: Discipline;
  sortOrder: number;
};

const emptyForm: FormState = { name: "", discipline: "BJJ", sortOrder: 0 };

function ClassTypesPage() {
  const { activeDojoId, activeDojo } = useCurrentDojo();
  const qc = useQueryClient();
  const listFn = useServerFn(listClassTypes);
  const upsertFn = useServerFn(upsertClassType);
  const deleteFn = useServerFn(deleteClassType);

  const isStaff =
    activeDojo?.role === "owner" ||
    activeDojo?.role === "admin" ||
    activeDojo?.role === "coach";

  const { data, isLoading } = useQuery({
    queryKey: ["class-types", activeDojoId],
    queryFn: () => listFn({ data: { dojoId: activeDojoId! } }),
    enabled: !!activeDojoId,
  });

  const [open, setOpen] = useState(false);
  const [form, setForm] = useState<FormState>(emptyForm);

  const upsertMut = useMutation({
    mutationFn: (input: FormState) =>
      upsertFn({
        data: {
          id: input.id,
          dojoId: activeDojoId!,
          name: input.name,
          discipline: input.discipline,
          sortOrder: input.sortOrder,
        },
      }),
    onSuccess: () => {
      toast.success(form.id ? "Class type updated" : "Class type added");
      qc.invalidateQueries({ queryKey: ["class-types", activeDojoId] });
      setOpen(false);
      setForm(emptyForm);
    },
    onError: (e: any) => toast.error(e?.message ?? "Failed to save"),
  });

  const deleteMut = useMutation({
    mutationFn: (id: string) => deleteFn({ data: { id } }),
    onSuccess: () => {
      toast.success("Removed");
      qc.invalidateQueries({ queryKey: ["class-types", activeDojoId] });
    },
    onError: (e: any) => toast.error(e?.message ?? "Failed to remove"),
  });

  const types = data?.types ?? [];

  return (
    <main>
      <PageHeader
        title="Class types"
        subtitle="The dropdown options shown when scheduling a class"
        actions={
          <div className="flex items-center gap-2">
            <Link to="/settings">
              <Button variant="outline" size="sm">
                <ArrowLeft className="size-4" /> Settings
              </Button>
            </Link>
            {isStaff && (
              <Button
                size="sm"
                onClick={() => {
                  setForm(emptyForm);
                  setOpen(true);
                }}
                className="bg-brand text-brand-foreground hover:bg-brand/90"
              >
                <Plus className="size-4" /> Add type
              </Button>
            )}
          </div>
        }
      />

      <div className="mx-auto max-w-3xl p-8">
        <div className="overflow-hidden rounded-xl bg-card ring-1 ring-black/5">
          {isLoading ? (
            <div className="p-8 text-center text-sm text-muted-foreground">
              Loading…
            </div>
          ) : types.length === 0 ? (
            <div className="p-10 text-center text-sm text-muted-foreground">
              No class types yet.
              {isStaff && (
                <>
                  {" "}
                  <button
                    onClick={() => {
                      setForm(emptyForm);
                      setOpen(true);
                    }}
                    className="font-medium text-brand hover:underline"
                  >
                    Add your first one
                  </button>
                  .
                </>
              )}
            </div>
          ) : (
            <ul className="divide-y divide-zinc-100">
              {types.map((t) => (
                <li
                  key={t.id}
                  className="flex items-center gap-3 px-5 py-3"
                >
                  <div className="flex-1">
                    <div className="text-sm font-medium">{t.name}</div>
                    <div className="text-xs text-muted-foreground">
                      {t.discipline}
                    </div>
                  </div>
                  {isStaff && (
                    <div className="flex items-center gap-1">
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => {
                          setForm({
                            id: t.id,
                            name: t.name,
                            discipline: t.discipline,
                            sortOrder: t.sort_order,
                          });
                          setOpen(true);
                        }}
                      >
                        <Pencil className="size-4" />
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => {
                          if (confirm(`Remove "${t.name}"?`))
                            deleteMut.mutate(t.id);
                        }}
                      >
                        <Trash2 className="size-4 text-red-600" />
                      </Button>
                    </div>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>
              {form.id ? "Edit class type" : "New class type"}
            </DialogTitle>
            <DialogDescription>
              Shown in the dropdown when adding a class.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="grid gap-1.5">
              <Label htmlFor="name">Name</Label>
              <Input
                id="name"
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
                placeholder="Kids BJJ"
              />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="grid gap-1.5">
                <Label>Discipline</Label>
                <Select
                  value={form.discipline}
                  onValueChange={(v) =>
                    setForm({ ...form, discipline: v as Discipline })
                  }
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {disciplines.map((d) => (
                      <SelectItem key={d} value={d}>
                        {d}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="sort">Sort order</Label>
                <Input
                  id="sort"
                  type="number"
                  value={form.sortOrder}
                  onChange={(e) =>
                    setForm({
                      ...form,
                      sortOrder: Number(e.target.value) || 0,
                    })
                  }
                />
              </div>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button
              disabled={upsertMut.isPending || !form.name.trim()}
              onClick={() => upsertMut.mutate(form)}
              className="bg-brand text-brand-foreground hover:bg-brand/90"
            >
              {upsertMut.isPending ? "Saving…" : form.id ? "Save" : "Add"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </main>
  );
}
