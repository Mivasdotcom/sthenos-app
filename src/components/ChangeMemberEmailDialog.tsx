import { useEffect, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { changeMemberEmail } from "@/lib/member-email.functions";

/**
 * One place to change an email address. It updates the member record, the login
 * account (so password resets and auth emails arrive) and the Stripe customer
 * (so receipts follow) as a single operation.
 */
export function ChangeMemberEmailDialog({
  memberId,
  currentEmail,
  loginEmail,
  open,
  onOpenChange,
}: {
  memberId: string;
  currentEmail: string | null;
  loginEmail?: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [email, setEmail] = useState(currentEmail ?? "");
  const qc = useQueryClient();
  const change = useServerFn(changeMemberEmail);

  useEffect(() => {
    if (open) setEmail(currentEmail ?? "");
  }, [open, currentEmail]);

  const save = useMutation({
    mutationFn: async () => {
      const value = email.trim().toLowerCase();
      if (!value || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(value)) {
        throw new Error("Enter a valid email address");
      }
      return change({ data: { memberId, email: value } });
    },
    onSuccess: (res) => {
      toast.success(
        res.loginEmail
          ? "Email updated — member record, login and receipts are now in sync"
          : "Email updated",
      );
      qc.invalidateQueries({ queryKey: ["member", memberId] });
      qc.invalidateQueries({ queryKey: ["member-login-email", memberId] });
      qc.invalidateQueries({ queryKey: ["members"] });
      qc.invalidateQueries({ queryKey: ["email-drift"] });
      qc.invalidateQueries({ queryKey: ["portal"] });
      onOpenChange(false);
    },
    onError: (e: any) => toast.error(e?.message ?? "Could not change the email"),
  });

  const mismatch =
    loginEmail && currentEmail && loginEmail.toLowerCase() !== currentEmail.toLowerCase();

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Change email address</DialogTitle>
          <DialogDescription>
            This updates the member record, their login (so password resets and other
            account emails arrive) and their payment receipts together. The new address
            becomes the login straight away.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          {mismatch && (
            <p className="rounded-md bg-amber-100 p-3 text-xs text-amber-800">
              Their login email is currently <strong>{loginEmail}</strong> while their
              member record says <strong>{currentEmail}</strong>. Saving here sets both to
              the address below.
            </p>
          )}
          <div className="space-y-1.5">
            <Label htmlFor="change-email">New email</Label>
            <Input
              id="change-email"
              type="email"
              autoFocus
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              maxLength={320}
            />
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={save.isPending}>
            Cancel
          </Button>
          <Button onClick={() => save.mutate()} disabled={save.isPending}>
            {save.isPending ? "Saving…" : "Update everywhere"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
