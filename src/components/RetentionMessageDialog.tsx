import { useEffect, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Loader2, Mail, Send } from "lucide-react";
import { toast } from "sonner";
import { sendMessage } from "@/lib/communications.functions";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

export function RetentionMessageDialog({
  open,
  onOpenChange,
  dojoId,
  memberId,
  memberName,
  daysSinceLastSeen,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  dojoId: string;
  memberId: string;
  memberName: string;
  daysSinceLastSeen: number;
}) {
  const send = useServerFn(sendMessage);
  const queryClient = useQueryClient();
  const firstName = memberName.trim().split(/\s+/)[0] || memberName;
  const absence = daysSinceLastSeen >= 999
    ? "We haven't seen you at training for a while"
    : `We haven't seen you at training for ${daysSinceLastSeen} days`;
  const defaultBody = `Hi ${firstName},\n\n${absence}, so I wanted to check in and see how you're doing. Is there anything we can help with? We'd love to see you back when you're ready.\n\nTake care`;
  const [body, setBody] = useState(defaultBody);

  useEffect(() => {
    if (open) setBody(defaultBody);
  }, [defaultBody, open]);

  const mutation = useMutation({
    mutationFn: () => send({
      data: { dojoId, memberId, body, channel: "email", retentionOutreach: true },
    }),
    onSuccess: (result) => {
      if (result.deliveryNotice) toast.warning(result.deliveryNotice);
      else toast.success(`Email sent to ${memberName}`);
      queryClient.invalidateQueries({ queryKey: ["retention-impact"] });
      queryClient.invalidateQueries({ queryKey: ["member-interventions", dojoId, memberId] });
      queryClient.invalidateQueries({ queryKey: ["conversation", dojoId, memberId] });
      queryClient.invalidateQueries({ queryKey: ["conversations", dojoId] });
      onOpenChange(false);
    },
    onError: (error: Error) => toast.error(error.message || "Could not send message"),
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Mail className="size-5" /> Message {memberName}
          </DialogTitle>
          <DialogDescription>
            Sent from your gym email and saved to this member's contact history.
          </DialogDescription>
        </DialogHeader>
        <Textarea
          value={body}
          onChange={(event) => setBody(event.target.value)}
          rows={8}
          maxLength={5000}
          aria-label={`Message to ${memberName}`}
        />
        <div className="text-right text-xs text-muted-foreground">{body.length}/5000</div>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            type="button"
            onClick={() => mutation.mutate()}
            disabled={mutation.isPending || !body.trim()}
          >
            {mutation.isPending ? <Loader2 className="size-4 animate-spin" /> : <Send className="size-4" />}
            Send email
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}