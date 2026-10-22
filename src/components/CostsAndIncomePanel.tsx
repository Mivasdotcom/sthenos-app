import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import {
  Dialog,
  DialogContent,
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
import {
  listOverheads,
  upsertOverhead,
  archiveOverhead,
  deleteOverhead,
  listManualRevenue,
  upsertManualRevenue,
  deleteManualRevenue,
  type Overhead,
  type ManualRevenue,
  type OverheadCategory,
  type OverheadRecurrence,
} from "@/lib/finance.functions";
import { Plus, Pencil, Trash2, Archive, ArchiveRestore } from "lucide-react";
import { toast } from "sonner";

const CATEGORY_LABELS: Record<OverheadCategory, string> = {
  rent: "Rent",
  utilities: "Utilities",
  payroll: "Payroll",
  equipment: "Equipment",
  marketing: "Marketing",
  insurance: "Insurance",
  software: "Software",
  other: "Other",
};

const RECURRENCE_LABELS: Record<OverheadRecurrence, string> = {
  one_off: "One-off",
  monthly: "Monthly",
  yearly: "Yearly",
};

function fmtMoney(cents: number, currency: string) {
  return (cents / 100).toLocaleString(undefined, {
    style: "currency",
    currency: currency.toUpperCase(),
  });
}

/**
 * What the gym spends, and what it earns outside memberships.
 *
 * This was a page of its own under Settings, titled "Overheads & revenue".
 * Settings is where you configure the app; an owner recording last month's
 * rent or a seminar's takings is doing their books, and goes to Billing --
 * which showed every number except the two that turn income into profit. So it
 * lives there now, and nobody has to know it exists to find it.
 */
export function CostsAndIncomePanel({ dojoId }: { dojoId: string }) {
  return (
    <Tabs defaultValue="overheads">
      <TabsList>
        <TabsTrigger value="overheads">Overheads</TabsTrigger>
        <TabsTrigger value="revenue">Other income</TabsTrigger>
      </TabsList>
      <TabsContent value="overheads" className="mt-6">
        <OverheadsTab dojoId={dojoId} />
      </TabsContent>
      <TabsContent value="revenue" className="mt-6">
        <ManualRevenueTab dojoId={dojoId} />
      </TabsContent>
    </Tabs>
  );
}

// ---------------- Overheads tab ----------------

function OverheadsTab({ dojoId }: { dojoId: string }) {
  const qc = useQueryClient();
  const listFn = useServerFn(listOverheads);
  const archiveFn = useServerFn(archiveOverhead);
  const deleteFn = useServerFn(deleteOverhead);
  const [edit, setEdit] = useState<{ open: boolean; item: Overhead | null }>({
    open: false,
    item: null,
  });

  const { data, isLoading } = useQuery({
    queryKey: ["overheads", dojoId, "all"],
    queryFn: () => listFn({ data: { dojoId, includeArchived: true } }),
  });

  const archiveMut = useMutation({
    mutationFn: (vars: { id: string; archived: boolean }) =>
      archiveFn({ data: { ...vars, dojoId } }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["overheads"] });
      qc.invalidateQueries({ queryKey: ["pnl"] });
    },
  });
  const deleteMut = useMutation({
    mutationFn: (id: string) => deleteFn({ data: { id, dojoId } }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["overheads"] });
      qc.invalidateQueries({ queryKey: ["pnl"] });
      toast.success("Overhead deleted");
    },
  });

  const items = data?.overheads ?? [];

  return (
    <div className="space-y-4">
      <div className="flex justify-end">
        <Button
          size="sm"
          className="bg-brand text-brand-foreground hover:bg-brand/90"
          onClick={() => setEdit({ open: true, item: null })}
        >
          <Plus className="size-4" /> New overhead
        </Button>
      </div>

      {isLoading ? (
        <div className="rounded-xl bg-card p-8 text-center text-sm text-muted-foreground ring-1 ring-black/5">
          Loading overheads…
        </div>
      ) : items.length === 0 ? (
        <div className="rounded-xl border border-dashed border-zinc-950/10 bg-card/40 p-10 text-center">
          <p className="text-sm text-muted-foreground">
            No overheads yet. Add rent, utilities, salaries, or any recurring
            costs to compare against revenue.
          </p>
          <Button
            className="mt-4 bg-brand text-brand-foreground hover:bg-brand/90"
            onClick={() => setEdit({ open: true, item: null })}
          >
            <Plus className="size-4" /> Add your first overhead
          </Button>
        </div>
      ) : (
        <div className="overflow-hidden rounded-xl bg-card ring-1 ring-black/5">
          <table className="w-full border-collapse text-left">
            <thead>
              <tr className="border-b border-zinc-950/5 bg-zinc-50/50">
                <th className="px-6 py-3 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                  Name
                </th>
                <th className="px-6 py-3 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                  Category
                </th>
                <th className="px-6 py-3 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                  Amount
                </th>
                <th className="px-6 py-3 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                  Recurrence
                </th>
                <th className="px-6 py-3 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                  Period
                </th>
                <th className="px-6 py-3 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                  Status
                </th>
                <th className="px-6 py-3" />
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-950/5">
              {items.map((o) => (
                <tr
                  key={o.id}
                  className="transition-colors hover:bg-zinc-50/40"
                >
                  <td className="px-6 py-3 text-sm font-medium">{o.name}</td>
                  <td className="px-6 py-3 text-sm text-zinc-600">
                    {CATEGORY_LABELS[o.category]}
                  </td>
                  <td className="px-6 py-3 text-sm tabular-nums">
                    {fmtMoney(o.amount_cents, o.currency)}
                  </td>
                  <td className="px-6 py-3 text-sm text-zinc-600">
                    {RECURRENCE_LABELS[o.recurrence]}
                  </td>
                  <td className="px-6 py-3 text-xs text-muted-foreground tabular-nums">
                    {o.starts_on}
                    {o.ends_on ? ` → ${o.ends_on}` : ""}
                  </td>
                  <td className="px-6 py-3">
                    <span
                      className={
                        o.is_active
                          ? "rounded bg-emerald-50 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider text-emerald-700 ring-1 ring-inset ring-emerald-500/20"
                          : "rounded bg-zinc-100 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider text-zinc-600 ring-1 ring-inset ring-zinc-400/20"
                      }
                    >
                      {o.is_active ? "Active" : "Archived"}
                    </span>
                  </td>
                  <td className="px-6 py-3 text-right">
                    <div className="flex justify-end gap-1">
                      <Button
                        size="sm"
                        variant="ghost"
                        className="h-7 gap-1.5 text-xs"
                        onClick={() => setEdit({ open: true, item: o })}
                      >
                        <Pencil className="size-3.5" /> Edit
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        className="h-7 gap-1.5 text-xs"
                        onClick={() =>
                          archiveMut.mutate({
                            id: o.id,
                            archived: o.is_active,
                          })
                        }
                      >
                        {o.is_active ? (
                          <>
                            <Archive className="size-3.5" /> Archive
                          </>
                        ) : (
                          <>
                            <ArchiveRestore className="size-3.5" /> Restore
                          </>
                        )}
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        className="h-7 gap-1.5 text-xs text-red-600 hover:text-red-700"
                        onClick={() => {
                          if (confirm(`Delete "${o.name}"?`))
                            deleteMut.mutate(o.id);
                        }}
                      >
                        <Trash2 className="size-3.5" />
                      </Button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <OverheadEditDialog
        state={edit}
        dojoId={dojoId}
        onClose={() => setEdit({ open: false, item: null })}
        onSaved={() => {
          qc.invalidateQueries({ queryKey: ["overheads"] });
          qc.invalidateQueries({ queryKey: ["pnl"] });
          setEdit({ open: false, item: null });
        }}
      />
    </div>
  );
}

function OverheadEditDialog({
  state,
  dojoId,
  onClose,
  onSaved,
}: {
  state: { open: boolean; item: Overhead | null };
  dojoId: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const upsertFn = useServerFn(upsertOverhead);
  const item = state.item;
  const today = new Date().toISOString().slice(0, 10);

  const [name, setName] = useState(item?.name ?? "");
  const [category, setCategory] = useState<OverheadCategory>(
    item?.category ?? "rent",
  );
  const [amount, setAmount] = useState(
    item ? (item.amount_cents / 100).toString() : "",
  );
  const [currency, setCurrency] = useState(item?.currency ?? "usd");
  const [recurrence, setRecurrence] = useState<OverheadRecurrence>(
    item?.recurrence ?? "monthly",
  );
  const [startsOn, setStartsOn] = useState(item?.starts_on ?? today);
  const [endsOn, setEndsOn] = useState(item?.ends_on ?? "");
  const [notes, setNotes] = useState(item?.notes ?? "");

  const mut = useMutation({
    mutationFn: () =>
      upsertFn({
        data: {
          id: item?.id,
          dojoId,
          name,
          category,
          amountCents: Math.round(parseFloat(amount || "0") * 100),
          currency,
          recurrence,
          startsOn,
          endsOn: endsOn || null,
          notes,
        },
      }),
    onSuccess: () => {
      toast.success(item ? "Overhead updated" : "Overhead added");
      onSaved();
    },
    onError: (e: any) => toast.error(e.message ?? "Could not save"),
  });

  return (
    <Dialog
      open={state.open}
      onOpenChange={(o) => {
        if (!o) onClose();
      }}
    >
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{item ? "Edit overhead" : "New overhead"}</DialogTitle>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="oh-name">Name</Label>
            <Input
              id="oh-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Studio rent"
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label>Category</Label>
              <Select
                value={category}
                onValueChange={(v) => setCategory(v as OverheadCategory)}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {(Object.keys(CATEGORY_LABELS) as OverheadCategory[]).map(
                    (k) => (
                      <SelectItem key={k} value={k}>
                        {CATEGORY_LABELS[k]}
                      </SelectItem>
                    ),
                  )}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label>Recurrence</Label>
              <Select
                value={recurrence}
                onValueChange={(v) => setRecurrence(v as OverheadRecurrence)}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {(
                    Object.keys(RECURRENCE_LABELS) as OverheadRecurrence[]
                  ).map((k) => (
                    <SelectItem key={k} value={k}>
                      {RECURRENCE_LABELS[k]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="grid grid-cols-3 gap-3">
            <div className="col-span-2 space-y-1.5">
              <Label htmlFor="oh-amount">Amount</Label>
              <Input
                id="oh-amount"
                type="number"
                min="0"
                step="0.01"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                placeholder="2500.00"
              />
            </div>
            <div className="space-y-1.5">
              <Label>Currency</Label>
              <Select value={currency} onValueChange={setCurrency}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="usd">USD</SelectItem>
                  <SelectItem value="eur">EUR</SelectItem>
                  <SelectItem value="gbp">GBP</SelectItem>
                  <SelectItem value="cad">CAD</SelectItem>
                  <SelectItem value="aud">AUD</SelectItem>
                  <SelectItem value="brl">BRL</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="oh-start">Starts on</Label>
              <Input
                id="oh-start"
                type="date"
                value={startsOn}
                onChange={(e) => setStartsOn(e.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="oh-end">Ends on (optional)</Label>
              <Input
                id="oh-end"
                type="date"
                value={endsOn ?? ""}
                onChange={(e) => setEndsOn(e.target.value)}
              />
            </div>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="oh-notes">Notes (optional)</Label>
            <Textarea
              id="oh-notes"
              value={notes ?? ""}
              onChange={(e) => setNotes(e.target.value)}
              rows={2}
            />
          </div>
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            className="bg-brand text-brand-foreground hover:bg-brand/90"
            disabled={!name.trim() || mut.isPending}
            onClick={() => mut.mutate()}
          >
            {mut.isPending ? "Saving…" : item ? "Save" : "Add overhead"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ---------------- Manual revenue tab ----------------

function ManualRevenueTab({ dojoId }: { dojoId: string }) {
  const qc = useQueryClient();
  const listFn = useServerFn(listManualRevenue);
  const deleteFn = useServerFn(deleteManualRevenue);
  const [edit, setEdit] = useState<{
    open: boolean;
    item: ManualRevenue | null;
  }>({ open: false, item: null });

  const { data, isLoading } = useQuery({
    queryKey: ["manual-revenue", dojoId],
    queryFn: () => listFn({ data: { dojoId } }),
  });

  const deleteMut = useMutation({
    mutationFn: (id: string) => deleteFn({ data: { id } }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["manual-revenue"] });
      qc.invalidateQueries({ queryKey: ["pnl"] });
      toast.success("Entry deleted");
    },
  });

  const items = data?.entries ?? [];

  return (
    <div className="space-y-4">
      <div className="flex items-end justify-between">
        <p className="max-w-xl text-xs text-muted-foreground">
          Log income that doesn't come from membership invoices — merch sales,
          seminars, cash drop-ins, etc. Membership payments are already counted
          automatically.
        </p>
        <Button
          size="sm"
          className="bg-brand text-brand-foreground hover:bg-brand/90"
          onClick={() => setEdit({ open: true, item: null })}
        >
          <Plus className="size-4" /> New entry
        </Button>
      </div>

      {isLoading ? (
        <div className="rounded-xl bg-card p-8 text-center text-sm text-muted-foreground ring-1 ring-black/5">
          Loading entries…
        </div>
      ) : items.length === 0 ? (
        <div className="rounded-xl border border-dashed border-zinc-950/10 bg-card/40 p-10 text-center text-sm text-muted-foreground">
          No manual revenue logged yet.
        </div>
      ) : (
        <div className="overflow-hidden rounded-xl bg-card ring-1 ring-black/5">
          <table className="w-full border-collapse text-left">
            <thead>
              <tr className="border-b border-zinc-950/5 bg-zinc-50/50">
                <th className="px-6 py-3 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                  Date
                </th>
                <th className="px-6 py-3 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                  Description
                </th>
                <th className="px-6 py-3 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                  Category
                </th>
                <th className="px-6 py-3 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                  Amount
                </th>
                <th className="px-6 py-3" />
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-950/5">
              {items.map((e) => (
                <tr
                  key={e.id}
                  className="transition-colors hover:bg-zinc-50/40"
                >
                  <td className="px-6 py-3 text-sm tabular-nums">
                    {e.received_on}
                  </td>
                  <td className="px-6 py-3 text-sm font-medium">
                    {e.description}
                  </td>
                  <td className="px-6 py-3 text-sm text-zinc-600">
                    {e.category ?? "—"}
                  </td>
                  <td className="px-6 py-3 text-sm tabular-nums">
                    {fmtMoney(e.amount_cents, e.currency)}
                  </td>
                  <td className="px-6 py-3 text-right">
                    <div className="flex justify-end gap-1">
                      <Button
                        size="sm"
                        variant="ghost"
                        className="h-7 gap-1.5 text-xs"
                        onClick={() => setEdit({ open: true, item: e })}
                      >
                        <Pencil className="size-3.5" /> Edit
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        className="h-7 gap-1.5 text-xs text-red-600 hover:text-red-700"
                        onClick={() => {
                          if (confirm("Delete this entry?"))
                            deleteMut.mutate(e.id);
                        }}
                      >
                        <Trash2 className="size-3.5" />
                      </Button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <ManualRevenueEditDialog
        state={edit}
        dojoId={dojoId}
        onClose={() => setEdit({ open: false, item: null })}
        onSaved={() => {
          qc.invalidateQueries({ queryKey: ["manual-revenue"] });
          qc.invalidateQueries({ queryKey: ["pnl"] });
          setEdit({ open: false, item: null });
        }}
      />
    </div>
  );
}

function ManualRevenueEditDialog({
  state,
  dojoId,
  onClose,
  onSaved,
}: {
  state: { open: boolean; item: ManualRevenue | null };
  dojoId: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const upsertFn = useServerFn(upsertManualRevenue);
  const item = state.item;
  const today = new Date().toISOString().slice(0, 10);

  const [description, setDescription] = useState(item?.description ?? "");
  const [amount, setAmount] = useState(
    item ? (item.amount_cents / 100).toString() : "",
  );
  const [currency, setCurrency] = useState(item?.currency ?? "usd");
  const [receivedOn, setReceivedOn] = useState(item?.received_on ?? today);
  const [category, setCategory] = useState(item?.category ?? "");
  const [notes, setNotes] = useState(item?.notes ?? "");

  const mut = useMutation({
    mutationFn: () =>
      upsertFn({
        data: {
          id: item?.id,
          dojoId,
          description,
          amountCents: Math.round(parseFloat(amount || "0") * 100),
          currency,
          receivedOn,
          category,
          notes,
        },
      }),
    onSuccess: () => {
      toast.success(item ? "Entry updated" : "Entry added");
      onSaved();
    },
    onError: (e: any) => toast.error(e.message ?? "Could not save"),
  });

  return (
    <Dialog
      open={state.open}
      onOpenChange={(o) => {
        if (!o) onClose();
      }}
    >
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{item ? "Edit entry" : "New revenue entry"}</DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="mr-desc">Description</Label>
            <Input
              id="mr-desc"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="T-shirt sale"
            />
          </div>
          <div className="grid grid-cols-3 gap-3">
            <div className="col-span-2 space-y-1.5">
              <Label htmlFor="mr-amount">Amount</Label>
              <Input
                id="mr-amount"
                type="number"
                min="0"
                step="0.01"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label>Currency</Label>
              <Select value={currency} onValueChange={setCurrency}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="usd">USD</SelectItem>
                  <SelectItem value="eur">EUR</SelectItem>
                  <SelectItem value="gbp">GBP</SelectItem>
                  <SelectItem value="cad">CAD</SelectItem>
                  <SelectItem value="aud">AUD</SelectItem>
                  <SelectItem value="brl">BRL</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="mr-date">Received on</Label>
              <Input
                id="mr-date"
                type="date"
                value={receivedOn}
                onChange={(e) => setReceivedOn(e.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="mr-cat">Category (optional)</Label>
              <Input
                id="mr-cat"
                value={category ?? ""}
                onChange={(e) => setCategory(e.target.value)}
                placeholder="merch, seminar…"
              />
            </div>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="mr-notes">Notes (optional)</Label>
            <Textarea
              id="mr-notes"
              value={notes ?? ""}
              onChange={(e) => setNotes(e.target.value)}
              rows={2}
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            className="bg-brand text-brand-foreground hover:bg-brand/90"
            disabled={!description.trim() || mut.isPending}
            onClick={() => mut.mutate()}
          >
            {mut.isPending ? "Saving…" : item ? "Save" : "Add entry"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
