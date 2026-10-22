
CREATE TABLE public.conversations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  dojo_id UUID NOT NULL REFERENCES public.dojos(id) ON DELETE CASCADE,
  member_id UUID NOT NULL REFERENCES public.members(id) ON DELETE CASCADE,
  last_message_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (dojo_id, member_id)
);
CREATE INDEX conversations_dojo_last_msg_idx ON public.conversations (dojo_id, last_message_at DESC);
CREATE INDEX conversations_member_idx ON public.conversations (member_id);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.conversations TO authenticated;
GRANT ALL ON public.conversations TO service_role;

ALTER TABLE public.conversations ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Staff read conversations in their dojo"
  ON public.conversations FOR SELECT TO authenticated
  USING (public.is_dojo_staff(auth.uid(), dojo_id));

CREATE POLICY "Members read their own conversation"
  ON public.conversations FOR SELECT TO authenticated
  USING (EXISTS (
    SELECT 1 FROM public.members m
    WHERE m.id = member_id AND m.user_id = auth.uid()
  ));

CREATE POLICY "Staff insert conversations in their dojo"
  ON public.conversations FOR INSERT TO authenticated
  WITH CHECK (public.is_dojo_staff(auth.uid(), dojo_id));

CREATE POLICY "Members insert their own conversation"
  ON public.conversations FOR INSERT TO authenticated
  WITH CHECK (EXISTS (
    SELECT 1 FROM public.members m
    WHERE m.id = member_id AND m.user_id = auth.uid() AND m.dojo_id = dojo_id
  ));

CREATE POLICY "Staff update conversations in their dojo"
  ON public.conversations FOR UPDATE TO authenticated
  USING (public.is_dojo_staff(auth.uid(), dojo_id))
  WITH CHECK (public.is_dojo_staff(auth.uid(), dojo_id));

CREATE POLICY "Members update their own conversation"
  ON public.conversations FOR UPDATE TO authenticated
  USING (EXISTS (SELECT 1 FROM public.members m WHERE m.id = member_id AND m.user_id = auth.uid()))
  WITH CHECK (EXISTS (SELECT 1 FROM public.members m WHERE m.id = member_id AND m.user_id = auth.uid()));

CREATE TRIGGER conversations_updated_at
  BEFORE UPDATE ON public.conversations
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();


CREATE TABLE public.messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id UUID NOT NULL REFERENCES public.conversations(id) ON DELETE CASCADE,
  dojo_id UUID NOT NULL REFERENCES public.dojos(id) ON DELETE CASCADE,
  member_id UUID NOT NULL REFERENCES public.members(id) ON DELETE CASCADE,
  sender_type TEXT NOT NULL CHECK (sender_type IN ('staff','member')),
  sender_user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  channel TEXT NOT NULL DEFAULT 'in_app' CHECK (channel IN ('in_app','email','sms')),
  body TEXT NOT NULL,
  read_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX messages_conversation_created_idx ON public.messages (conversation_id, created_at);
CREATE INDEX messages_dojo_idx ON public.messages (dojo_id);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.messages TO authenticated;
GRANT ALL ON public.messages TO service_role;

ALTER TABLE public.messages ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Staff read messages in their dojo"
  ON public.messages FOR SELECT TO authenticated
  USING (public.is_dojo_staff(auth.uid(), dojo_id));

CREATE POLICY "Members read their own messages"
  ON public.messages FOR SELECT TO authenticated
  USING (EXISTS (
    SELECT 1 FROM public.members m
    WHERE m.id = member_id AND m.user_id = auth.uid()
  ));

CREATE POLICY "Staff insert messages in their dojo"
  ON public.messages FOR INSERT TO authenticated
  WITH CHECK (public.is_dojo_staff(auth.uid(), dojo_id) AND sender_type = 'staff');

CREATE POLICY "Members insert their own messages"
  ON public.messages FOR INSERT TO authenticated
  WITH CHECK (
    sender_type = 'member'
    AND EXISTS (
      SELECT 1 FROM public.members m
      WHERE m.id = member_id AND m.user_id = auth.uid() AND m.dojo_id = dojo_id
    )
  );

CREATE POLICY "Staff update messages in their dojo"
  ON public.messages FOR UPDATE TO authenticated
  USING (public.is_dojo_staff(auth.uid(), dojo_id))
  WITH CHECK (public.is_dojo_staff(auth.uid(), dojo_id));

CREATE POLICY "Members update their own messages read state"
  ON public.messages FOR UPDATE TO authenticated
  USING (EXISTS (SELECT 1 FROM public.members m WHERE m.id = member_id AND m.user_id = auth.uid()))
  WITH CHECK (EXISTS (SELECT 1 FROM public.members m WHERE m.id = member_id AND m.user_id = auth.uid()));
