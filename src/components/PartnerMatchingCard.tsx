import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

export function PartnerMatchingCard({
  dojoId,
  canEdit,
}: {
  dojoId: string | null;
  canEdit: boolean;
}) {
  const qc = useQueryClient();
  const { data } = useQuery({
    queryKey: ["partner-matching-setting", dojoId],
    enabled: !!dojoId,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("dojos")
        .select("partner_matching_enabled")
        .eq("id", dojoId!)
        .maybeSingle();
      if (error) throw error;
      return data;
    },
  });

  const save = useMutation({
    mutationFn: async (enabled: boolean) => {
      const { error } = await supabase
        .from("dojos")
        .update({ partner_matching_enabled: enabled })
        .eq("id", dojoId!);
      if (error) throw error;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["partner-matching-setting", dojoId] });
      toast.success("Privacy setting saved");
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const enabled = data?.partner_matching_enabled !== false;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Training partner matching</CardTitle>
        <CardDescription>
          When on, members who opt in can see other opted-in members of a similar belt level in
          the same discipline. Members are never shown unless they opt in themselves, and no
          attendance or training-time information is ever shared. Turn this off to disable the
          feature for the whole gym.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div className="flex items-center gap-3">
          <Switch
            id="partner-matching"
            checked={enabled}
            disabled={!canEdit || save.isPending || !dojoId}
            onCheckedChange={(v) => save.mutate(v)}
          />
          <Label htmlFor="partner-matching">
            {enabled ? "Available to members who opt in" : "Disabled for this gym"}
          </Label>
        </div>
      </CardContent>
    </Card>
  );
}
