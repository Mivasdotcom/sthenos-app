import { PUBLIC_SITE_URL } from "@/lib/site";
import { useState } from "react";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { PageHeader } from "@/components/PageHeader";
import { WEEK_DISPLAY } from "@/lib/weekdays";


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
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { CalendarPlus, Trash2, Settings as SettingsIcon } from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { useCurrentDojo } from "@/hooks/use-current-dojo";
import { useAuth } from "@/hooks/use-auth";
import {
  listClasses,
  upsertClass,
  deleteClass,
  type ClassRow,
} from "@/lib/classes.functions";
import { listClassTypes } from "@/lib/class-types.functions";


export const Route = createFileRoute("/classes")({
  head: () => ({
    meta: [
      { title: "Classes \u2014 Sthenos" },
      { name: "description", content: "Weekly class schedule across all disciplines, instructors, and tatami." },
      { property: "og:title", content: "Classes \u2014 Sthenos" },
      { property: "og:description", content: "Weekly class schedule across all disciplines, instructors, and tatami." },
      { property: "og:url", content: `${PUBLIC_SITE_URL}/classes` },
      { name: "twitter:title", content: "Classes \u2014 Sthenos" },
      { name: "twitter:description", content: "Weekly class schedule across all disciplines, instructors, and tatami." },
    ],
    links: [
      { rel: "canonical", href: `${PUBLIC_SITE_URL}/classes` },
    ],
  }),
  component: ClassesPage,
});

// Monday-first display order; stored weekday keeps JS getDay() indexing.
const week = WEEK_DISPLAY;

const hours = Array.from({ length: 11 }, (_, i) => 9 + i); // 9..19

type FormState = {
  id?: string;
  name: string;
  discipline: ClassRow["discipline"];
  instructor: string;
  weekday: number;
  startTime: string;
  endTime: string;
  capacity: number;
};

const emptyForm: FormState = {
  name: "",
  discipline: "BJJ",
  instructor: "",
  weekday: 1, // Monday (JS getDay indexing)
  startTime: "18:00",
  endTime: "19:00",
  capacity: 20,
};

function ClassesPage() {
  const { activeDojoId, activeDojo } = useCurrentDojo();
  const { viewAs } = useAuth();
  const qc = useQueryClient();
  const listFn = useServerFn(listClasses);
  const upsertFn = useServerFn(upsertClass);
  const deleteFn = useServerFn(deleteClass);
  const listTypesFn = useServerFn(listClassTypes);

  const role = activeDojo?.role;
  const isStaffRole = role === "owner" || role === "admin" || role === "coach";
  const canView = isStaffRole;
  const canEdit = (role === "owner" || role === "admin") && viewAs === "staff";

  const { data, isLoading } = useQuery({
    queryKey: ["classes", activeDojoId],
    queryFn: () => listFn({ data: { dojoId: activeDojoId! } }),
    enabled: !!activeDojoId,
  });

  const { data: typesData } = useQuery({
    queryKey: ["class-types", activeDojoId],
    queryFn: () => listTypesFn({ data: { dojoId: activeDojoId! } }),
    enabled: !!activeDojoId,
  });
  const classTypes = typesData?.types ?? [];


  const [open, setOpen] = useState(false);
  const [form, setForm] = useState<FormState>(emptyForm);
  const [confirmDelete, setConfirmDelete] = useState<ClassRow | null>(null);

  const upsertMut = useMutation({
    mutationFn: (input: FormState) =>
      upsertFn({
        data: {
          id: input.id,
          dojoId: activeDojoId!,
          name: input.name,
          discipline: input.discipline,
          instructor: input.instructor,
          weekday: input.weekday,
          startTime: input.startTime,
          endTime: input.endTime,
          capacity: input.capacity,
        },
      }),
    onSuccess: () => {
      toast.success(form.id ? "Class updated" : "Class added");
      qc.invalidateQueries({ queryKey: ["classes", activeDojoId] });
      setOpen(false);
      setForm(emptyForm);
    },
    onError: (e: any) => toast.error(e?.message ?? "Failed to save class"),
  });

  const deleteMut = useMutation({
    mutationFn: (id: string) => deleteFn({ data: { id } }),
    onSuccess: () => {
      toast.success("Class removed");
      qc.invalidateQueries({ queryKey: ["classes", activeDojoId] });
      setConfirmDelete(null);
    },
    onError: (e: any) => toast.error(e?.message ?? "Failed to remove class"),
  });

  // Who's booked, and cancelling a place, live on the Attendance page's class
  // list. This page is for editing the timetable.
  const classes = data?.classes ?? [];
  // Group by weekday in Monday-first display order; stored weekday keeps
  // JS Date#getDay() indexing (0=Sun..6=Sat).
  const byDay: ClassRow[][] = week.map((d) =>
    classes.filter((c) => c.weekday === d.index),
  );


  function openCreate() {
    setForm(emptyForm);
    setOpen(true);
  }

  function openEdit(c: ClassRow) {
    setForm({
      id: c.id,
      name: c.name,
      discipline: c.discipline,
      instructor: c.instructor,
      weekday: c.weekday,
      startTime: c.start_time.slice(0, 5),
      endTime: c.end_time.slice(0, 5),
      capacity: c.capacity,
    });
    setOpen(true);
  }

  return (
    <main>
      <PageHeader
        title="Class Schedule"
        subtitle={
          isLoading
            ? "Loading…"
            : `${classes.length} class${classes.length === 1 ? "" : "es"} this week`
        }
        actions={
          canEdit ? (
            <Button
              size="sm"
              onClick={openCreate}
              className="bg-brand text-brand-foreground hover:bg-brand/90"
            >
              <CalendarPlus className="size-4" /> New Class
            </Button>
          ) : null
        }
      />

      <div className="mx-auto max-w-7xl space-y-6 p-8">
        <div className="overflow-hidden rounded-xl bg-card ring-1 ring-black/5">
          <div className="grid grid-cols-[60px_repeat(7,1fr)] border-b border-zinc-950/5 bg-zinc-50/50">
            <div />
            {week.map((d, i) => (
              <div
                key={d.index}
                className={cn(
                  "px-3 py-3 text-center text-[10px] font-semibold uppercase tracking-wider text-muted-foreground",
                  i === 0 && "text-brand",
                )}
              >
                {d.label}
              </div>
            ))}

          </div>
          <div className="grid grid-cols-[60px_repeat(7,1fr)]">
            <div className="border-r border-zinc-950/5">
              {hours.map((h) => (
                <div
                  key={h}
                  className="h-20 px-2 pt-1 text-right text-[10px] font-mono tabular-nums text-muted-foreground"
                >
                  {h.toString().padStart(2, "0")}:00
                </div>
              ))}
            </div>
            {byDay.map((dayClasses, di) => (
              <div
                key={di}
                className="relative border-r border-zinc-950/5 last:border-r-0"
              >
                {hours.map((h) => (
                  <div
                    key={h}
                    className="h-20 border-b border-zinc-950/5"
                  />
                ))}
                {dayClasses.map((c) => {
                  const [sh, sm] = c.start_time.split(":").map(Number);
                  const [eh, em] = c.end_time.split(":").map(Number);
                  const top = (sh - 9) * 80 + (sm / 60) * 80;
                  const height = (eh - sh) * 80 + ((em - sm) / 60) * 80;
                  if (top < 0 || top > 11 * 80) return null;
                  return (
                    <div
                      key={c.id}
                      className="group absolute inset-x-1 cursor-pointer overflow-hidden rounded-md bg-brand/10 px-2 py-1.5 ring-1 ring-inset ring-brand/20 transition-shadow hover:shadow-md"
                      style={{ top, height: Math.max(20, height - 2) }}
                      onClick={() => canEdit && openEdit(c)}
                    >
                      <div className="flex items-start justify-between gap-1">
                        <div className="min-w-0 flex-1">
                          <div className="truncate text-[11px] font-semibold leading-tight text-brand">
                            {c.name}
                          </div>
                          <div className="truncate text-[10px] text-zinc-600">
                            {c.instructor}
                          </div>
                          <div className="mt-0.5 text-[10px] tabular-nums text-muted-foreground">
                            {c.start_time.slice(0, 5)}–{c.end_time.slice(0, 5)}
                          </div>
                        </div>
                        {canEdit && (
                          <button
                            type="button"
                            className="opacity-0 transition-opacity group-hover:opacity-100"
                            onClick={(e) => {
                              e.stopPropagation();
                              setConfirmDelete(c);
                            }}
                            aria-label="Remove class"
                          >
                            <Trash2 className="size-3 text-zinc-500 hover:text-red-600" />
                          </button>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            ))}
          </div>
        </div>

        {!isLoading && classes.length === 0 && (
          <div className="rounded-xl border border-dashed border-zinc-300 p-10 text-center text-sm text-muted-foreground">
            No classes yet.
            {canEdit && (
              <>
                {" "}
                <button
                  onClick={openCreate}
                  className="font-medium text-brand hover:underline"
                >
                  Add your first class
                </button>
                .
              </>
            )}
          </div>
        )}
      </div>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{form.id ? "Edit class" : "New class"}</DialogTitle>
            <DialogDescription>
              {form.id
                ? "Update the class details."
                : "Add a class to the weekly schedule."}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="grid gap-1.5">
              <Label htmlFor="name">Name</Label>
              <Input
                id="name"
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
                placeholder="Adult BJJ — Gi"
              />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="grid gap-1.5">
                <div className="flex items-center justify-between">
                  <Label>Class type</Label>
                  <Link
                    to="/settings/class-types"
                    className="inline-flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground"
                  >
                    <SettingsIcon className="size-3" /> Manage
                  </Link>
                </div>
                {classTypes.length === 0 ? (
                  <div className="rounded-md border border-dashed border-zinc-300 px-2 py-1.5 text-[11px] text-muted-foreground">
                    No class types yet —{" "}
                    <Link
                      to="/settings/class-types"
                      className="font-medium text-brand hover:underline"
                    >
                      add one
                    </Link>
                    .
                  </div>
                ) : (
                  <Select
                    value={
                      classTypes.find(
                        (t) =>
                          t.name === form.name &&
                          t.discipline === form.discipline,
                      )?.id ?? ""
                    }
                    onValueChange={(id) => {
                      const t = classTypes.find((x) => x.id === id);
                      if (t)
                        setForm({
                          ...form,
                          name: form.id ? form.name : t.name,
                          discipline: t.discipline,
                        });
                    }}
                  >
                    <SelectTrigger>
                      <SelectValue placeholder="Select a type" />
                    </SelectTrigger>
                    <SelectContent>
                      {classTypes.map((t) => (
                        <SelectItem key={t.id} value={t.id}>
                          {t.name}{" "}
                          <span className="text-muted-foreground">
                            · {t.discipline}
                          </span>
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}
              </div>

              <div className="grid gap-1.5">
                <Label>Day</Label>
                <Select
                  value={String(form.weekday)}
                  onValueChange={(v) =>
                    setForm({ ...form, weekday: Number(v) })
                  }
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {week.map((d) => (
                      <SelectItem key={d.index} value={String(d.index)}>
                        {d.longLabel}
                      </SelectItem>
                    ))}

                  </SelectContent>
                </Select>
              </div>
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="instructor">Instructor</Label>
              <Input
                id="instructor"
                value={form.instructor}
                onChange={(e) =>
                  setForm({ ...form, instructor: e.target.value })
                }
                placeholder="Coach name"
              />
            </div>
            <div className="grid grid-cols-3 gap-3">
              <div className="grid gap-1.5">
                <Label htmlFor="start">Start</Label>
                <Input
                  id="start"
                  type="time"
                  value={form.startTime}
                  onChange={(e) =>
                    setForm({ ...form, startTime: e.target.value })
                  }
                />
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="end">End</Label>
                <Input
                  id="end"
                  type="time"
                  value={form.endTime}
                  onChange={(e) =>
                    setForm({ ...form, endTime: e.target.value })
                  }
                />
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="capacity">Capacity</Label>
                <Input
                  id="capacity"
                  type="number"
                  min={1}
                  value={form.capacity}
                  onChange={(e) =>
                    setForm({
                      ...form,
                      capacity: Number(e.target.value) || 1,
                    })
                  }
                />
              </div>
            </div>
          </div>
          <DialogFooter className="gap-2 sm:gap-2">
            {form.id && (
              <Button
                variant="outline"
                className="mr-auto text-red-600 hover:text-red-700"
                onClick={() => {
                  const cls = classes.find((c) => c.id === form.id);
                  if (cls) {
                    setOpen(false);
                    setConfirmDelete(cls);
                  }
                }}
              >
                <Trash2 className="size-4" /> Remove
              </Button>
            )}
            <Button variant="outline" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button
              disabled={
                upsertMut.isPending ||
                !form.name.trim() ||
                !form.instructor.trim()
              }
              onClick={() => upsertMut.mutate(form)}
              className="bg-brand text-brand-foreground hover:bg-brand/90"
            >
              {upsertMut.isPending ? "Saving…" : form.id ? "Save" : "Add class"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <AlertDialog
        open={!!confirmDelete}
        onOpenChange={(o) => !o && setConfirmDelete(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove class?</AlertDialogTitle>
            <AlertDialogDescription>
              "{confirmDelete?.name}" will be removed from the schedule. Past
              attendance records are preserved.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() =>
                confirmDelete && deleteMut.mutate(confirmDelete.id)
              }
              className="bg-red-600 text-white hover:bg-red-700"
            >
              Remove
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </main>
  );
}
