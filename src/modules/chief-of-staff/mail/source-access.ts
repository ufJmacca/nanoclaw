/** Source alias is `s`; allowed identities are host-checked and profile-qualified.
 * Retention uses the database wall clock even when provider polling is unavailable. */
export function mailSourceAccess(parameter: string): string {
  return `COALESCE((
    (s.provenance->>'origin' IS DISTINCT FROM 'mail_message' AND NOT s.access_policy ? 'mail_binding_id')
    OR (s.provenance->>'origin'='mail_message'
      AND ('mail:'||(s.access_policy->>'mail_binding_id'))=ANY(${parameter}::text[])
      AND EXISTS(SELECT 1 FROM cos.mail_messages mm
        JOIN cos.mail_bindings mb ON mb.scope_id=mm.scope_id AND mb.id=mm.binding_id
        JOIN cos.mail_states ms ON ms.scope_id=mm.scope_id AND ms.binding_id=mm.binding_id
        WHERE mm.scope_id=s.scope_id AND mm.source_id=s.id AND mb.auth='ready'
          AND mb.id::text=s.access_policy->>'mail_binding_id'
          AND mb.mailbox_email=s.access_policy->>'mailbox_email'
          AND mb.permission_scopes=ARRAY['https://www.googleapis.com/auth/gmail.readonly']::text[]
          AND mm.provider_message_id=s.access_policy->>'provider_message_id'
          AND mm.provider_thread_id=s.access_policy->>'provider_thread_id'
          AND mm.selection_id::text=s.access_policy->>'selection_id'
          AND mm.last_capture=ms.current_capture
          AND mm.internal_date>=clock_timestamp()-interval '30 days' AND mm.internal_date<=clock_timestamp()
          AND mm.message->>'trust'='untrusted_mail_evidence'
          AND (mm.message->'labels') ?| ARRAY['INBOX','SENT']
          AND NOT ((mm.message->'labels') ?| ARRAY['SPAM','TRASH','DRAFT'])))
    ),false)`;
}
