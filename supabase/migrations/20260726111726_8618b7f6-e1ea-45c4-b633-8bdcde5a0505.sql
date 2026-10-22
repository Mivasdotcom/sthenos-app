DROP POLICY "Members insert their own conversation" ON public.conversations;
CREATE POLICY "Members insert their own conversation" ON public.conversations
FOR INSERT TO authenticated
WITH CHECK (EXISTS (
  SELECT 1 FROM public.members m
  WHERE m.id = conversations.member_id
    AND m.user_id = auth.uid()
    AND m.dojo_id = conversations.dojo_id
));

DROP POLICY "Members insert their own messages" ON public.messages;
CREATE POLICY "Members insert their own messages" ON public.messages
FOR INSERT TO authenticated
WITH CHECK (
  sender_type = 'member'
  AND EXISTS (
    SELECT 1 FROM public.members m
    WHERE m.id = messages.member_id
      AND m.user_id = auth.uid()
      AND m.dojo_id = messages.dojo_id
  )
);