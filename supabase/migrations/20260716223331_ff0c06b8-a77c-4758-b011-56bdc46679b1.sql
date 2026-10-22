
-- 1) class_bookings table
CREATE TYPE public.class_booking_status AS ENUM ('booked','attended','no_show');

CREATE TABLE public.class_bookings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  dojo_id UUID NOT NULL REFERENCES public.dojos(id) ON DELETE CASCADE,
  class_id UUID NOT NULL REFERENCES public.classes(id) ON DELETE CASCADE,
  member_id UUID NOT NULL REFERENCES public.members(id) ON DELETE CASCADE,
  booked_for_date DATE NOT NULL,
  status public.class_booking_status NOT NULL DEFAULT 'booked',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (class_id, member_id, booked_for_date)
);

CREATE INDEX class_bookings_dojo_date_idx
  ON public.class_bookings (dojo_id, booked_for_date);
CREATE INDEX class_bookings_class_date_idx
  ON public.class_bookings (class_id, booked_for_date);
CREATE INDEX class_bookings_member_idx
  ON public.class_bookings (member_id);

-- 2) Grants (service_role always; authenticated for staff + member reads/writes)
GRANT SELECT, INSERT, UPDATE, DELETE ON public.class_bookings TO authenticated;
GRANT ALL ON public.class_bookings TO service_role;

-- 3) Enable RLS
ALTER TABLE public.class_bookings ENABLE ROW LEVEL SECURITY;

-- 4) Policies
-- Staff (owner/admin/manager/coach) full access within their dojo
CREATE POLICY "class_bookings staff full access"
  ON public.class_bookings
  FOR ALL
  TO authenticated
  USING (public.is_dojo_staff(auth.uid(), dojo_id))
  WITH CHECK (public.is_dojo_staff(auth.uid(), dojo_id));

-- Members can read their own bookings
CREATE POLICY "class_bookings member read own"
  ON public.class_bookings
  FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.members m
      WHERE m.id = class_bookings.member_id
        AND m.user_id = auth.uid()
    )
  );

-- Members can insert bookings for themselves
CREATE POLICY "class_bookings member insert own"
  ON public.class_bookings
  FOR INSERT
  TO authenticated
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.members m
      WHERE m.id = class_bookings.member_id
        AND m.user_id = auth.uid()
        AND m.dojo_id = class_bookings.dojo_id
    )
  );

-- updated_at trigger
CREATE TRIGGER class_bookings_updated_at
BEFORE UPDATE ON public.class_bookings
FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();
