import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { LOGO_BUCKET } from "@/lib/dojo-logo";

const ONE_WEEK = 60 * 60 * 24 * 7;

/**
 * Resolve a displayable URL for a dojo logo stored at `logoPath`.
 * Returns null when the dojo has no logo (callers fall back to Sthenos branding).
 */
export function useDojoLogoUrl(logoPath: string | null | undefined) {
  const { data } = useQuery({
    queryKey: ["dojo-logo-url", logoPath],
    enabled: !!logoPath,
    staleTime: 1000 * 60 * 60,
    queryFn: async () => {
      const { data, error } = await supabase.storage
        .from(LOGO_BUCKET)
        .createSignedUrl(logoPath!, ONE_WEEK);
      if (error) return null;
      return data?.signedUrl ?? null;
    },
  });
  return data ?? null;
}
