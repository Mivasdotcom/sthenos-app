export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "14.5"
  }
  public: {
    Tables: {
      attendances: {
        Row: {
          booking_id: string | null
          checked_in_at: string
          class_id: string | null
          created_at: string
          dojo_id: string
          id: string
          member_id: string
          trial_override_at: string | null
          trial_override_by: string | null
          trial_override_reason: string | null
        }
        Insert: {
          booking_id?: string | null
          checked_in_at?: string
          class_id?: string | null
          created_at?: string
          dojo_id: string
          id?: string
          member_id: string
          trial_override_at?: string | null
          trial_override_by?: string | null
          trial_override_reason?: string | null
        }
        Update: {
          booking_id?: string | null
          checked_in_at?: string
          class_id?: string | null
          created_at?: string
          dojo_id?: string
          id?: string
          member_id?: string
          trial_override_at?: string | null
          trial_override_by?: string | null
          trial_override_reason?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "attendances_booking_id_fkey"
            columns: ["booking_id"]
            isOneToOne: false
            referencedRelation: "class_bookings"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "attendances_class_id_fkey"
            columns: ["class_id"]
            isOneToOne: false
            referencedRelation: "classes"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "attendances_dojo_id_fkey"
            columns: ["dojo_id"]
            isOneToOne: false
            referencedRelation: "dojos"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "attendances_member_id_fkey"
            columns: ["member_id"]
            isOneToOne: false
            referencedRelation: "members"
            referencedColumns: ["id"]
          },
        ]
      }
      cancellation_audit_log: {
        Row: {
          access_until: string | null
          action: string
          actor_user_id: string | null
          cancel_mode: string | null
          created_at: string
          dojo_id: string
          id: string
          member_id: string
          reason: string | null
          stripe_subscription_canceled: boolean
          stripe_subscription_id: string | null
        }
        Insert: {
          access_until?: string | null
          action: string
          actor_user_id?: string | null
          cancel_mode?: string | null
          created_at?: string
          dojo_id: string
          id?: string
          member_id: string
          reason?: string | null
          stripe_subscription_canceled?: boolean
          stripe_subscription_id?: string | null
        }
        Update: {
          access_until?: string | null
          action?: string
          actor_user_id?: string | null
          cancel_mode?: string | null
          created_at?: string
          dojo_id?: string
          id?: string
          member_id?: string
          reason?: string | null
          stripe_subscription_canceled?: boolean
          stripe_subscription_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "cancellation_audit_log_dojo_id_fkey"
            columns: ["dojo_id"]
            isOneToOne: false
            referencedRelation: "dojos"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "cancellation_audit_log_member_id_fkey"
            columns: ["member_id"]
            isOneToOne: false
            referencedRelation: "members"
            referencedColumns: ["id"]
          },
        ]
      }
      cash_payments: {
        Row: {
          amount_cents: number
          created_at: string
          currency: string
          dojo_id: string
          id: string
          member_id: string
          note: string | null
          paid_on: string
          period_end: string
          period_start: string
          recorded_by: string | null
        }
        Insert: {
          amount_cents: number
          created_at?: string
          currency?: string
          dojo_id: string
          id?: string
          member_id: string
          note?: string | null
          paid_on?: string
          period_end: string
          period_start: string
          recorded_by?: string | null
        }
        Update: {
          amount_cents?: number
          created_at?: string
          currency?: string
          dojo_id?: string
          id?: string
          member_id?: string
          note?: string | null
          paid_on?: string
          period_end?: string
          period_start?: string
          recorded_by?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "cash_payments_dojo_id_fkey"
            columns: ["dojo_id"]
            isOneToOne: false
            referencedRelation: "dojos"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "cash_payments_member_id_fkey"
            columns: ["member_id"]
            isOneToOne: false
            referencedRelation: "members"
            referencedColumns: ["id"]
          },
        ]
      }
      class_bookings: {
        Row: {
          booked_for_date: string
          class_id: string
          created_at: string
          dojo_id: string
          id: string
          member_id: string
          status: Database["public"]["Enums"]["class_booking_status"]
          updated_at: string
        }
        Insert: {
          booked_for_date: string
          class_id: string
          created_at?: string
          dojo_id: string
          id?: string
          member_id: string
          status?: Database["public"]["Enums"]["class_booking_status"]
          updated_at?: string
        }
        Update: {
          booked_for_date?: string
          class_id?: string
          created_at?: string
          dojo_id?: string
          id?: string
          member_id?: string
          status?: Database["public"]["Enums"]["class_booking_status"]
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "class_bookings_class_id_fkey"
            columns: ["class_id"]
            isOneToOne: false
            referencedRelation: "classes"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "class_bookings_dojo_id_fkey"
            columns: ["dojo_id"]
            isOneToOne: false
            referencedRelation: "dojos"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "class_bookings_member_id_fkey"
            columns: ["member_id"]
            isOneToOne: false
            referencedRelation: "members"
            referencedColumns: ["id"]
          },
        ]
      }
      classes: {
        Row: {
          capacity: number
          created_at: string
          discipline: string
          dojo_id: string
          end_time: string
          id: string
          instructor: string
          name: string
          start_time: string
          updated_at: string
          weekday: number
        }
        Insert: {
          capacity?: number
          created_at?: string
          discipline: string
          dojo_id: string
          end_time: string
          id?: string
          instructor: string
          name: string
          start_time: string
          updated_at?: string
          weekday: number
        }
        Update: {
          capacity?: number
          created_at?: string
          discipline?: string
          dojo_id?: string
          end_time?: string
          id?: string
          instructor?: string
          name?: string
          start_time?: string
          updated_at?: string
          weekday?: number
        }
        Relationships: [
          {
            foreignKeyName: "classes_dojo_id_fkey"
            columns: ["dojo_id"]
            isOneToOne: false
            referencedRelation: "dojos"
            referencedColumns: ["id"]
          },
        ]
      }
      conversations: {
        Row: {
          created_at: string
          dojo_id: string
          id: string
          last_message_at: string | null
          member_id: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          dojo_id: string
          id?: string
          last_message_at?: string | null
          member_id: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          dojo_id?: string
          id?: string
          last_message_at?: string | null
          member_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "conversations_dojo_id_fkey"
            columns: ["dojo_id"]
            isOneToOne: false
            referencedRelation: "dojos"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "conversations_member_id_fkey"
            columns: ["member_id"]
            isOneToOne: false
            referencedRelation: "members"
            referencedColumns: ["id"]
          },
        ]
      }
      data_retention_events: {
        Row: {
          action: string
          created_at: string
          departed_at: string | null
          details: Json
          dojo_id: string
          id: string
          member_id: string | null
          policy_months: number | null
          reason: string | null
          run_id: string | null
        }
        Insert: {
          action: string
          created_at?: string
          departed_at?: string | null
          details?: Json
          dojo_id: string
          id?: string
          member_id?: string | null
          policy_months?: number | null
          reason?: string | null
          run_id?: string | null
        }
        Update: {
          action?: string
          created_at?: string
          departed_at?: string | null
          details?: Json
          dojo_id?: string
          id?: string
          member_id?: string | null
          policy_months?: number | null
          reason?: string | null
          run_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "data_retention_events_dojo_id_fkey"
            columns: ["dojo_id"]
            isOneToOne: false
            referencedRelation: "dojos"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "data_retention_events_member_id_fkey"
            columns: ["member_id"]
            isOneToOne: false
            referencedRelation: "members"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "data_retention_events_run_id_fkey"
            columns: ["run_id"]
            isOneToOne: false
            referencedRelation: "data_retention_runs"
            referencedColumns: ["id"]
          },
        ]
      }
      data_retention_runs: {
        Row: {
          created_at: string
          details: Json
          dojo_id: string | null
          error: string | null
          failures: number
          finished_at: string | null
          id: string
          members_anonymised: number
          members_considered: number
          members_skipped: number
          notices_raised: number
          started_at: string
          status: string
          trigger_source: string
          updated_at: string
          waivers_anonymised: number
        }
        Insert: {
          created_at?: string
          details?: Json
          dojo_id?: string | null
          error?: string | null
          failures?: number
          finished_at?: string | null
          id?: string
          members_anonymised?: number
          members_considered?: number
          members_skipped?: number
          notices_raised?: number
          started_at?: string
          status?: string
          trigger_source?: string
          updated_at?: string
          waivers_anonymised?: number
        }
        Update: {
          created_at?: string
          details?: Json
          dojo_id?: string | null
          error?: string | null
          failures?: number
          finished_at?: string | null
          id?: string
          members_anonymised?: number
          members_considered?: number
          members_skipped?: number
          notices_raised?: number
          started_at?: string
          status?: string
          trigger_source?: string
          updated_at?: string
          waivers_anonymised?: number
        }
        Relationships: [
          {
            foreignKeyName: "data_retention_runs_dojo_id_fkey"
            columns: ["dojo_id"]
            isOneToOne: false
            referencedRelation: "dojos"
            referencedColumns: ["id"]
          },
        ]
      }
      disputes: {
        Row: {
          amount_cents: number
          closed_at: string | null
          created_at: string
          currency: string
          dojo_id: string
          evidence_due_by: string | null
          id: string
          invoice_id: string | null
          last_event_at: string | null
          member_id: string | null
          outcome: string | null
          reason: string | null
          status: string
          stripe_charge_id: string | null
          stripe_dispute_id: string
          stripe_payment_intent_id: string | null
          updated_at: string
        }
        Insert: {
          amount_cents: number
          closed_at?: string | null
          created_at?: string
          currency?: string
          dojo_id: string
          evidence_due_by?: string | null
          id?: string
          invoice_id?: string | null
          last_event_at?: string | null
          member_id?: string | null
          outcome?: string | null
          reason?: string | null
          status: string
          stripe_charge_id?: string | null
          stripe_dispute_id: string
          stripe_payment_intent_id?: string | null
          updated_at?: string
        }
        Update: {
          amount_cents?: number
          closed_at?: string | null
          created_at?: string
          currency?: string
          dojo_id?: string
          evidence_due_by?: string | null
          id?: string
          invoice_id?: string | null
          last_event_at?: string | null
          member_id?: string | null
          outcome?: string | null
          reason?: string | null
          status?: string
          stripe_charge_id?: string | null
          stripe_dispute_id?: string
          stripe_payment_intent_id?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "disputes_dojo_id_fkey"
            columns: ["dojo_id"]
            isOneToOne: false
            referencedRelation: "dojos"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "disputes_invoice_id_fkey"
            columns: ["invoice_id"]
            isOneToOne: false
            referencedRelation: "invoices"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "disputes_member_id_fkey"
            columns: ["member_id"]
            isOneToOne: false
            referencedRelation: "members"
            referencedColumns: ["id"]
          },
        ]
      }
      dojo_access_denials: {
        Row: {
          created_at: string
          dojo_id: string | null
          function_name: string | null
          id: string
          metadata: Json | null
          reason: string
          role: string | null
          user_id: string | null
        }
        Insert: {
          created_at?: string
          dojo_id?: string | null
          function_name?: string | null
          id?: string
          metadata?: Json | null
          reason: string
          role?: string | null
          user_id?: string | null
        }
        Update: {
          created_at?: string
          dojo_id?: string | null
          function_name?: string | null
          id?: string
          metadata?: Json | null
          reason?: string
          role?: string | null
          user_id?: string | null
        }
        Relationships: []
      }
      dojo_class_types: {
        Row: {
          created_at: string
          discipline: string
          dojo_id: string
          id: string
          name: string
          sort_order: number
          updated_at: string
        }
        Insert: {
          created_at?: string
          discipline: string
          dojo_id: string
          id?: string
          name: string
          sort_order?: number
          updated_at?: string
        }
        Update: {
          created_at?: string
          discipline?: string
          dojo_id?: string
          id?: string
          name?: string
          sort_order?: number
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "dojo_class_types_dojo_id_fkey"
            columns: ["dojo_id"]
            isOneToOne: false
            referencedRelation: "dojos"
            referencedColumns: ["id"]
          },
        ]
      }
      dojo_memberships: {
        Row: {
          created_at: string
          dojo_id: string
          id: string
          role: Database["public"]["Enums"]["dojo_role"]
          user_id: string
        }
        Insert: {
          created_at?: string
          dojo_id: string
          id?: string
          role?: Database["public"]["Enums"]["dojo_role"]
          user_id: string
        }
        Update: {
          created_at?: string
          dojo_id?: string
          id?: string
          role?: Database["public"]["Enums"]["dojo_role"]
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "dojo_memberships_dojo_id_fkey"
            columns: ["dojo_id"]
            isOneToOne: false
            referencedRelation: "dojos"
            referencedColumns: ["id"]
          },
        ]
      }
      dojo_overheads: {
        Row: {
          amount_cents: number
          category: Database["public"]["Enums"]["overhead_category"]
          created_at: string
          currency: string
          dojo_id: string
          ends_on: string | null
          id: string
          is_active: boolean
          name: string
          notes: string | null
          recurrence: Database["public"]["Enums"]["overhead_recurrence"]
          starts_on: string
          updated_at: string
        }
        Insert: {
          amount_cents: number
          category?: Database["public"]["Enums"]["overhead_category"]
          created_at?: string
          currency?: string
          dojo_id: string
          ends_on?: string | null
          id?: string
          is_active?: boolean
          name: string
          notes?: string | null
          recurrence?: Database["public"]["Enums"]["overhead_recurrence"]
          starts_on?: string
          updated_at?: string
        }
        Update: {
          amount_cents?: number
          category?: Database["public"]["Enums"]["overhead_category"]
          created_at?: string
          currency?: string
          dojo_id?: string
          ends_on?: string | null
          id?: string
          is_active?: boolean
          name?: string
          notes?: string | null
          recurrence?: Database["public"]["Enums"]["overhead_recurrence"]
          starts_on?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "dojo_overheads_dojo_id_fkey"
            columns: ["dojo_id"]
            isOneToOne: false
            referencedRelation: "dojos"
            referencedColumns: ["id"]
          },
        ]
      }
      dojo_plans: {
        Row: {
          created_at: string
          currency: string
          description: string | null
          dojo_id: string
          id: string
          interval: string
          is_active: boolean
          max_family_members: number | null
          name: string
          plan_type: string
          price_cents: number
          sort_order: number
          stripe_price_id: string | null
          updated_at: string
        }
        Insert: {
          created_at?: string
          currency?: string
          description?: string | null
          dojo_id: string
          id?: string
          interval?: string
          is_active?: boolean
          max_family_members?: number | null
          name: string
          plan_type?: string
          price_cents: number
          sort_order?: number
          stripe_price_id?: string | null
          updated_at?: string
        }
        Update: {
          created_at?: string
          currency?: string
          description?: string | null
          dojo_id?: string
          id?: string
          interval?: string
          is_active?: boolean
          max_family_members?: number | null
          name?: string
          plan_type?: string
          price_cents?: number
          sort_order?: number
          stripe_price_id?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "dojo_plans_dojo_id_fkey"
            columns: ["dojo_id"]
            isOneToOne: false
            referencedRelation: "dojos"
            referencedColumns: ["id"]
          },
        ]
      }
      dojo_privacy_notices: {
        Row: {
          body_markdown: string
          created_at: string
          dojo_id: string
          id: string
          is_current: boolean
          published_at: string | null
          published_by: string | null
          title: string
          updated_at: string
          version: number
        }
        Insert: {
          body_markdown?: string
          created_at?: string
          dojo_id: string
          id?: string
          is_current?: boolean
          published_at?: string | null
          published_by?: string | null
          title?: string
          updated_at?: string
          version?: number
        }
        Update: {
          body_markdown?: string
          created_at?: string
          dojo_id?: string
          id?: string
          is_current?: boolean
          published_at?: string | null
          published_by?: string | null
          title?: string
          updated_at?: string
          version?: number
        }
        Relationships: [
          {
            foreignKeyName: "dojo_privacy_notices_dojo_id_fkey"
            columns: ["dojo_id"]
            isOneToOne: false
            referencedRelation: "dojos"
            referencedColumns: ["id"]
          },
        ]
      }
      dojo_terms: {
        Row: {
          body_markdown: string
          created_at: string
          created_by: string | null
          dojo_id: string
          id: string
          is_current: boolean
          title: string
          updated_at: string
          version: number
        }
        Insert: {
          body_markdown?: string
          created_at?: string
          created_by?: string | null
          dojo_id: string
          id?: string
          is_current?: boolean
          title?: string
          updated_at?: string
          version?: number
        }
        Update: {
          body_markdown?: string
          created_at?: string
          created_by?: string | null
          dojo_id?: string
          id?: string
          is_current?: boolean
          title?: string
          updated_at?: string
          version?: number
        }
        Relationships: [
          {
            foreignKeyName: "dojo_terms_dojo_id_fkey"
            columns: ["dojo_id"]
            isOneToOne: false
            referencedRelation: "dojos"
            referencedColumns: ["id"]
          },
        ]
      }
      dojo_waivers: {
        Row: {
          audience: string
          body_markdown: string
          created_at: string
          created_by: string | null
          dojo_id: string
          id: string
          is_current: boolean
          title: string
          updated_at: string
          version: number
        }
        Insert: {
          audience?: string
          body_markdown: string
          created_at?: string
          created_by?: string | null
          dojo_id: string
          id?: string
          is_current?: boolean
          title?: string
          updated_at?: string
          version?: number
        }
        Update: {
          audience?: string
          body_markdown?: string
          created_at?: string
          created_by?: string | null
          dojo_id?: string
          id?: string
          is_current?: boolean
          title?: string
          updated_at?: string
          version?: number
        }
        Relationships: [
          {
            foreignKeyName: "dojo_waivers_dojo_id_fkey"
            columns: ["dojo_id"]
            isOneToOne: false
            referencedRelation: "dojos"
            referencedColumns: ["id"]
          },
        ]
      }
      dojos: {
        Row: {
          archived_at: string | null
          billing_day_of_month: number
          billing_mode: string
          collect_media_consent: boolean
          contact_email: string | null
          country: string
          created_at: string
          default_currency: string
          description: string | null
          family_pricing_mode: string
          hero_image_url: string | null
          hold_grace_days: number
          id: string
          logo_path: string | null
          name: string
          owner_user_id: string
          partner_matching_enabled: boolean
          pass_platform_fee_to_members: boolean
          paused_members_can_book: boolean
          payment_methods: string[] | null
          plan: string
          price_change_notice_days: number
          privacy_contact_email: string | null
          public_page_enabled: boolean
          retention_auto_enabled: boolean
          retention_departed_months: number | null
          retention_notice_days: number
          retention_waiver_months: number | null
          signup_free_days: number
          slug: string
          stripe_account_country: string | null
          stripe_account_id: string | null
          stripe_charges_enabled: boolean
          stripe_details_submitted: boolean
          tagline: string | null
          timezone: string
          trial_class_allowance: number | null
          trial_classes_per_day: number
          trial_length_days: number | null
          trial_max_total_classes: number | null
          trial_reminder_enabled: boolean
          updated_at: string
        }
        Insert: {
          archived_at?: string | null
          billing_day_of_month?: number
          billing_mode?: string
          collect_media_consent?: boolean
          contact_email?: string | null
          country?: string
          created_at?: string
          default_currency?: string
          description?: string | null
          family_pricing_mode?: string
          hero_image_url?: string | null
          hold_grace_days?: number
          id?: string
          logo_path?: string | null
          name: string
          owner_user_id: string
          partner_matching_enabled?: boolean
          pass_platform_fee_to_members?: boolean
          paused_members_can_book?: boolean
          payment_methods?: string[] | null
          plan?: string
          price_change_notice_days?: number
          privacy_contact_email?: string | null
          public_page_enabled?: boolean
          retention_auto_enabled?: boolean
          retention_departed_months?: number | null
          retention_notice_days?: number
          retention_waiver_months?: number | null
          signup_free_days?: number
          slug: string
          stripe_account_country?: string | null
          stripe_account_id?: string | null
          stripe_charges_enabled?: boolean
          stripe_details_submitted?: boolean
          tagline?: string | null
          timezone?: string
          trial_class_allowance?: number | null
          trial_classes_per_day?: number
          trial_length_days?: number | null
          trial_max_total_classes?: number | null
          trial_reminder_enabled?: boolean
          updated_at?: string
        }
        Update: {
          archived_at?: string | null
          billing_day_of_month?: number
          billing_mode?: string
          collect_media_consent?: boolean
          contact_email?: string | null
          country?: string
          created_at?: string
          default_currency?: string
          description?: string | null
          family_pricing_mode?: string
          hero_image_url?: string | null
          hold_grace_days?: number
          id?: string
          logo_path?: string | null
          name?: string
          owner_user_id?: string
          partner_matching_enabled?: boolean
          pass_platform_fee_to_members?: boolean
          paused_members_can_book?: boolean
          payment_methods?: string[] | null
          plan?: string
          price_change_notice_days?: number
          privacy_contact_email?: string | null
          public_page_enabled?: boolean
          retention_auto_enabled?: boolean
          retention_departed_months?: number | null
          retention_notice_days?: number
          retention_waiver_months?: number | null
          signup_free_days?: number
          slug?: string
          stripe_account_country?: string | null
          stripe_account_id?: string | null
          stripe_charges_enabled?: boolean
          stripe_details_submitted?: boolean
          tagline?: string | null
          timezone?: string
          trial_class_allowance?: number | null
          trial_classes_per_day?: number
          trial_length_days?: number | null
          trial_max_total_classes?: number | null
          trial_reminder_enabled?: boolean
          updated_at?: string
        }
        Relationships: []
      }
      dunning_notices: {
        Row: {
          amount_cents: number
          created_at: string
          currency: string
          dojo_id: string
          emailed: boolean
          first_failed_at: string
          hosted_invoice_url: string | null
          id: string
          member_id: string
          payment_method: string | null
          resolved_at: string | null
          send_error: string | null
          stage: string
          stripe_invoice_id: string
          updated_at: string
        }
        Insert: {
          amount_cents?: number
          created_at?: string
          currency?: string
          dojo_id: string
          emailed?: boolean
          first_failed_at?: string
          hosted_invoice_url?: string | null
          id?: string
          member_id: string
          payment_method?: string | null
          resolved_at?: string | null
          send_error?: string | null
          stage: string
          stripe_invoice_id: string
          updated_at?: string
        }
        Update: {
          amount_cents?: number
          created_at?: string
          currency?: string
          dojo_id?: string
          emailed?: boolean
          first_failed_at?: string
          hosted_invoice_url?: string | null
          id?: string
          member_id?: string
          payment_method?: string | null
          resolved_at?: string | null
          send_error?: string | null
          stage?: string
          stripe_invoice_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "dunning_notices_dojo_id_fkey"
            columns: ["dojo_id"]
            isOneToOne: false
            referencedRelation: "dojos"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "dunning_notices_member_id_fkey"
            columns: ["member_id"]
            isOneToOne: false
            referencedRelation: "members"
            referencedColumns: ["id"]
          },
        ]
      }
      email_send_log: {
        Row: {
          created_at: string
          error_message: string | null
          id: string
          message_id: string | null
          metadata: Json | null
          recipient_email: string
          status: string
          template_name: string
        }
        Insert: {
          created_at?: string
          error_message?: string | null
          id?: string
          message_id?: string | null
          metadata?: Json | null
          recipient_email: string
          status: string
          template_name: string
        }
        Update: {
          created_at?: string
          error_message?: string | null
          id?: string
          message_id?: string | null
          metadata?: Json | null
          recipient_email?: string
          status?: string
          template_name?: string
        }
        Relationships: []
      }
      email_send_state: {
        Row: {
          auth_email_ttl_minutes: number
          batch_size: number
          id: number
          retry_after_until: string | null
          send_delay_ms: number
          transactional_email_ttl_minutes: number
          updated_at: string
        }
        Insert: {
          auth_email_ttl_minutes?: number
          batch_size?: number
          id?: number
          retry_after_until?: string | null
          send_delay_ms?: number
          transactional_email_ttl_minutes?: number
          updated_at?: string
        }
        Update: {
          auth_email_ttl_minutes?: number
          batch_size?: number
          id?: number
          retry_after_until?: string | null
          send_delay_ms?: number
          transactional_email_ttl_minutes?: number
          updated_at?: string
        }
        Relationships: []
      }
      email_settings: {
        Row: {
          dojo_id: string
          from_address: string
          from_name: string
          id: string
          updated_at: string
          updated_by: string | null
        }
        Insert: {
          dojo_id: string
          from_address?: string
          from_name?: string
          id?: string
          updated_at?: string
          updated_by?: string | null
        }
        Update: {
          dojo_id?: string
          from_address?: string
          from_name?: string
          id?: string
          updated_at?: string
          updated_by?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "email_settings_dojo_id_fkey"
            columns: ["dojo_id"]
            isOneToOne: false
            referencedRelation: "dojos"
            referencedColumns: ["id"]
          },
        ]
      }
      email_unsubscribe_tokens: {
        Row: {
          created_at: string
          email: string
          id: string
          token: string
          used_at: string | null
        }
        Insert: {
          created_at?: string
          email: string
          id?: string
          token: string
          used_at?: string | null
        }
        Update: {
          created_at?: string
          email?: string
          id?: string
          token?: string
          used_at?: string | null
        }
        Relationships: []
      }
      family_discount_tiers: {
        Row: {
          created_at: string
          discount_percent: number
          dojo_id: string
          id: string
          min_members: number
          updated_at: string
        }
        Insert: {
          created_at?: string
          discount_percent: number
          dojo_id: string
          id?: string
          min_members: number
          updated_at?: string
        }
        Update: {
          created_at?: string
          discount_percent?: number
          dojo_id?: string
          id?: string
          min_members?: number
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "family_discount_tiers_dojo_id_fkey"
            columns: ["dojo_id"]
            isOneToOne: false
            referencedRelation: "dojos"
            referencedColumns: ["id"]
          },
        ]
      }
      family_groups: {
        Row: {
          created_at: string
          dojo_id: string
          id: string
          name: string
          payer_member_id: string | null
          updated_at: string
        }
        Insert: {
          created_at?: string
          dojo_id: string
          id?: string
          name: string
          payer_member_id?: string | null
          updated_at?: string
        }
        Update: {
          created_at?: string
          dojo_id?: string
          id?: string
          name?: string
          payer_member_id?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "family_groups_dojo_id_fkey"
            columns: ["dojo_id"]
            isOneToOne: false
            referencedRelation: "dojos"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "family_groups_payer_member_id_fkey"
            columns: ["payer_member_id"]
            isOneToOne: false
            referencedRelation: "members"
            referencedColumns: ["id"]
          },
        ]
      }
      internal_tasks: {
        Row: {
          completed_at: string | null
          created_at: string
          created_by: string | null
          description: string | null
          dojo_id: string
          due_date: string | null
          id: string
          member_id: string | null
          source_workflow_id: string | null
          status: Database["public"]["Enums"]["task_status"]
          title: string
          updated_at: string
        }
        Insert: {
          completed_at?: string | null
          created_at?: string
          created_by?: string | null
          description?: string | null
          dojo_id: string
          due_date?: string | null
          id?: string
          member_id?: string | null
          source_workflow_id?: string | null
          status?: Database["public"]["Enums"]["task_status"]
          title: string
          updated_at?: string
        }
        Update: {
          completed_at?: string | null
          created_at?: string
          created_by?: string | null
          description?: string | null
          dojo_id?: string
          due_date?: string | null
          id?: string
          member_id?: string | null
          source_workflow_id?: string | null
          status?: Database["public"]["Enums"]["task_status"]
          title?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "internal_tasks_dojo_id_fkey"
            columns: ["dojo_id"]
            isOneToOne: false
            referencedRelation: "dojos"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "internal_tasks_member_id_fkey"
            columns: ["member_id"]
            isOneToOne: false
            referencedRelation: "members"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "internal_tasks_source_workflow_id_fkey"
            columns: ["source_workflow_id"]
            isOneToOne: false
            referencedRelation: "workflows"
            referencedColumns: ["id"]
          },
        ]
      }
      invoice_line_items: {
        Row: {
          amount_cents: number
          created_at: string
          description: string
          id: string
          invoice_id: string
          metadata: Json
          plan_id: string | null
          quantity: number
          unit_amount_cents: number
        }
        Insert: {
          amount_cents: number
          created_at?: string
          description: string
          id?: string
          invoice_id: string
          metadata?: Json
          plan_id?: string | null
          quantity?: number
          unit_amount_cents: number
        }
        Update: {
          amount_cents?: number
          created_at?: string
          description?: string
          id?: string
          invoice_id?: string
          metadata?: Json
          plan_id?: string | null
          quantity?: number
          unit_amount_cents?: number
        }
        Relationships: [
          {
            foreignKeyName: "invoice_line_items_invoice_id_fkey"
            columns: ["invoice_id"]
            isOneToOne: false
            referencedRelation: "invoices"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "invoice_line_items_plan_id_fkey"
            columns: ["plan_id"]
            isOneToOne: false
            referencedRelation: "dojo_plans"
            referencedColumns: ["id"]
          },
        ]
      }
      invoices: {
        Row: {
          amount_cents: number
          created_at: string
          currency: string
          dojo_id: string
          due_date: string
          hosted_invoice_url: string | null
          id: string
          invoice_number: string | null
          member_id: string | null
          paid_at: string | null
          payment_method: string | null
          period_end: string | null
          period_start: string | null
          plan: Database["public"]["Enums"]["plan_type"]
          refunded_amount_cents: number
          status: Database["public"]["Enums"]["invoice_status"]
          stripe_invoice_id: string | null
          subscription_id: string | null
          updated_at: string
          voided_at: string | null
        }
        Insert: {
          amount_cents: number
          created_at?: string
          currency?: string
          dojo_id: string
          due_date: string
          hosted_invoice_url?: string | null
          id?: string
          invoice_number?: string | null
          member_id?: string | null
          paid_at?: string | null
          payment_method?: string | null
          period_end?: string | null
          period_start?: string | null
          plan: Database["public"]["Enums"]["plan_type"]
          refunded_amount_cents?: number
          status?: Database["public"]["Enums"]["invoice_status"]
          stripe_invoice_id?: string | null
          subscription_id?: string | null
          updated_at?: string
          voided_at?: string | null
        }
        Update: {
          amount_cents?: number
          created_at?: string
          currency?: string
          dojo_id?: string
          due_date?: string
          hosted_invoice_url?: string | null
          id?: string
          invoice_number?: string | null
          member_id?: string | null
          paid_at?: string | null
          payment_method?: string | null
          period_end?: string | null
          period_start?: string | null
          plan?: Database["public"]["Enums"]["plan_type"]
          refunded_amount_cents?: number
          status?: Database["public"]["Enums"]["invoice_status"]
          stripe_invoice_id?: string | null
          subscription_id?: string | null
          updated_at?: string
          voided_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "invoices_dojo_id_fkey"
            columns: ["dojo_id"]
            isOneToOne: false
            referencedRelation: "dojos"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "invoices_member_id_fkey"
            columns: ["member_id"]
            isOneToOne: false
            referencedRelation: "members"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "invoices_subscription_id_fkey"
            columns: ["subscription_id"]
            isOneToOne: false
            referencedRelation: "member_subscriptions"
            referencedColumns: ["id"]
          },
        ]
      }
      manual_revenue: {
        Row: {
          amount_cents: number
          category: string | null
          created_at: string
          currency: string
          description: string
          dojo_id: string
          id: string
          notes: string | null
          received_on: string
          updated_at: string
        }
        Insert: {
          amount_cents: number
          category?: string | null
          created_at?: string
          currency?: string
          description: string
          dojo_id: string
          id?: string
          notes?: string | null
          received_on?: string
          updated_at?: string
        }
        Update: {
          amount_cents?: number
          category?: string | null
          created_at?: string
          currency?: string
          description?: string
          dojo_id?: string
          id?: string
          notes?: string | null
          received_on?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "manual_revenue_dojo_id_fkey"
            columns: ["dojo_id"]
            isOneToOne: false
            referencedRelation: "dojos"
            referencedColumns: ["id"]
          },
        ]
      }
      marketing_broadcasts: {
        Row: {
          body_html: string
          created_at: string
          created_by: string
          dojo_id: string
          error: string | null
          failed_count: number
          filter_snapshot: Json | null
          from_name: string | null
          id: string
          name: string
          recipient_count: number
          scheduled_at: string | null
          segment_id: string | null
          segment_type: string | null
          sent_at: string | null
          sent_count: number
          status: Database["public"]["Enums"]["broadcast_status"]
          subject: string
          updated_at: string
        }
        Insert: {
          body_html: string
          created_at?: string
          created_by: string
          dojo_id: string
          error?: string | null
          failed_count?: number
          filter_snapshot?: Json | null
          from_name?: string | null
          id?: string
          name: string
          recipient_count?: number
          scheduled_at?: string | null
          segment_id?: string | null
          segment_type?: string | null
          sent_at?: string | null
          sent_count?: number
          status?: Database["public"]["Enums"]["broadcast_status"]
          subject: string
          updated_at?: string
        }
        Update: {
          body_html?: string
          created_at?: string
          created_by?: string
          dojo_id?: string
          error?: string | null
          failed_count?: number
          filter_snapshot?: Json | null
          from_name?: string | null
          id?: string
          name?: string
          recipient_count?: number
          scheduled_at?: string | null
          segment_id?: string | null
          segment_type?: string | null
          sent_at?: string | null
          sent_count?: number
          status?: Database["public"]["Enums"]["broadcast_status"]
          subject?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "marketing_broadcasts_dojo_id_fkey"
            columns: ["dojo_id"]
            isOneToOne: false
            referencedRelation: "dojos"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "marketing_broadcasts_segment_id_fkey"
            columns: ["segment_id"]
            isOneToOne: false
            referencedRelation: "segments"
            referencedColumns: ["id"]
          },
        ]
      }
      member_deletion_audit_log: {
        Row: {
          actor_user_id: string | null
          deleted_at: string
          dojo_id: string
          id: string
          member_email: string | null
          member_id: string | null
          member_name: string
          metadata: Json
          reason: string | null
          stripe_subscription_canceled: boolean
        }
        Insert: {
          actor_user_id?: string | null
          deleted_at?: string
          dojo_id: string
          id?: string
          member_email?: string | null
          member_id?: string | null
          member_name: string
          metadata?: Json
          reason?: string | null
          stripe_subscription_canceled?: boolean
        }
        Update: {
          actor_user_id?: string | null
          deleted_at?: string
          dojo_id?: string
          id?: string
          member_email?: string | null
          member_id?: string | null
          member_name?: string
          metadata?: Json
          reason?: string | null
          stripe_subscription_canceled?: boolean
        }
        Relationships: [
          {
            foreignKeyName: "member_deletion_audit_log_dojo_id_fkey"
            columns: ["dojo_id"]
            isOneToOne: false
            referencedRelation: "dojos"
            referencedColumns: ["id"]
          },
        ]
      }
      member_managers: {
        Row: {
          created_at: string
          dojo_id: string
          id: string
          member_id: string
          relationship: string | null
          user_id: string
        }
        Insert: {
          created_at?: string
          dojo_id: string
          id?: string
          member_id: string
          relationship?: string | null
          user_id: string
        }
        Update: {
          created_at?: string
          dojo_id?: string
          id?: string
          member_id?: string
          relationship?: string | null
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "member_managers_dojo_id_fkey"
            columns: ["dojo_id"]
            isOneToOne: false
            referencedRelation: "dojos"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "member_managers_member_id_fkey"
            columns: ["member_id"]
            isOneToOne: false
            referencedRelation: "members"
            referencedColumns: ["id"]
          },
        ]
      }
      member_payment_methods: {
        Row: {
          brand: string | null
          created_at: string
          dojo_id: string
          exp_month: number | null
          exp_year: number | null
          id: string
          last4: string | null
          member_id: string
          stripe_customer_id: string
          stripe_payment_method_id: string | null
          updated_at: string
        }
        Insert: {
          brand?: string | null
          created_at?: string
          dojo_id: string
          exp_month?: number | null
          exp_year?: number | null
          id?: string
          last4?: string | null
          member_id: string
          stripe_customer_id: string
          stripe_payment_method_id?: string | null
          updated_at?: string
        }
        Update: {
          brand?: string | null
          created_at?: string
          dojo_id?: string
          exp_month?: number | null
          exp_year?: number | null
          id?: string
          last4?: string | null
          member_id?: string
          stripe_customer_id?: string
          stripe_payment_method_id?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "member_payment_methods_dojo_id_fkey"
            columns: ["dojo_id"]
            isOneToOne: false
            referencedRelation: "dojos"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "member_payment_methods_member_id_fkey"
            columns: ["member_id"]
            isOneToOne: true
            referencedRelation: "members"
            referencedColumns: ["id"]
          },
        ]
      }
      member_status_history: {
        Row: {
          changed_at: string
          changed_by: string | null
          dojo_id: string
          from_payment_status:
            | Database["public"]["Enums"]["member_payment_status"]
            | null
          from_status: Database["public"]["Enums"]["member_status"] | null
          id: string
          member_id: string
          reason: string | null
          to_payment_status:
            | Database["public"]["Enums"]["member_payment_status"]
            | null
          to_status: Database["public"]["Enums"]["member_status"]
        }
        Insert: {
          changed_at?: string
          changed_by?: string | null
          dojo_id: string
          from_payment_status?:
            | Database["public"]["Enums"]["member_payment_status"]
            | null
          from_status?: Database["public"]["Enums"]["member_status"] | null
          id?: string
          member_id: string
          reason?: string | null
          to_payment_status?:
            | Database["public"]["Enums"]["member_payment_status"]
            | null
          to_status: Database["public"]["Enums"]["member_status"]
        }
        Update: {
          changed_at?: string
          changed_by?: string | null
          dojo_id?: string
          from_payment_status?:
            | Database["public"]["Enums"]["member_payment_status"]
            | null
          from_status?: Database["public"]["Enums"]["member_status"] | null
          id?: string
          member_id?: string
          reason?: string | null
          to_payment_status?:
            | Database["public"]["Enums"]["member_payment_status"]
            | null
          to_status?: Database["public"]["Enums"]["member_status"]
        }
        Relationships: [
          {
            foreignKeyName: "member_status_history_dojo_id_fkey"
            columns: ["dojo_id"]
            isOneToOne: false
            referencedRelation: "dojos"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "member_status_history_member_id_fkey"
            columns: ["member_id"]
            isOneToOne: false
            referencedRelation: "members"
            referencedColumns: ["id"]
          },
        ]
      }
      member_subscriptions: {
        Row: {
          cancel_at: string | null
          cancel_at_period_end: boolean
          canceled_at: string | null
          created_at: string
          currency: string | null
          current_period_end: string | null
          current_period_start: string | null
          dojo_id: string
          environment: string
          id: string
          last_event_at: string | null
          member_id: string
          metadata: Json
          payment_method: string | null
          plan_id: string
          status: Database["public"]["Enums"]["subscription_status"]
          stripe_customer_id: string | null
          stripe_subscription_id: string | null
          trial_end: string | null
          updated_at: string
        }
        Insert: {
          cancel_at?: string | null
          cancel_at_period_end?: boolean
          canceled_at?: string | null
          created_at?: string
          currency?: string | null
          current_period_end?: string | null
          current_period_start?: string | null
          dojo_id: string
          environment?: string
          id?: string
          last_event_at?: string | null
          member_id: string
          metadata?: Json
          payment_method?: string | null
          plan_id: string
          status?: Database["public"]["Enums"]["subscription_status"]
          stripe_customer_id?: string | null
          stripe_subscription_id?: string | null
          trial_end?: string | null
          updated_at?: string
        }
        Update: {
          cancel_at?: string | null
          cancel_at_period_end?: boolean
          canceled_at?: string | null
          created_at?: string
          currency?: string | null
          current_period_end?: string | null
          current_period_start?: string | null
          dojo_id?: string
          environment?: string
          id?: string
          last_event_at?: string | null
          member_id?: string
          metadata?: Json
          payment_method?: string | null
          plan_id?: string
          status?: Database["public"]["Enums"]["subscription_status"]
          stripe_customer_id?: string | null
          stripe_subscription_id?: string | null
          trial_end?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "member_subscriptions_dojo_id_fkey"
            columns: ["dojo_id"]
            isOneToOne: false
            referencedRelation: "dojos"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "member_subscriptions_member_id_fkey"
            columns: ["member_id"]
            isOneToOne: false
            referencedRelation: "members"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "member_subscriptions_plan_id_fkey"
            columns: ["plan_id"]
            isOneToOne: false
            referencedRelation: "dojo_plans"
            referencedColumns: ["id"]
          },
        ]
      }
      member_waivers: {
        Row: {
          anonymised_at: string | null
          dojo_id: string
          guardian_email: string | null
          guardian_name: string | null
          guardian_phone: string | null
          guardian_relationship: string | null
          id: string
          ip_address: string | null
          member_id: string
          signature_text: string
          signed_at: string
          signed_by: string
          signed_name: string
          user_agent: string | null
          waiver_audience: string
          waiver_id: string | null
          waiver_version: number | null
        }
        Insert: {
          anonymised_at?: string | null
          dojo_id: string
          guardian_email?: string | null
          guardian_name?: string | null
          guardian_phone?: string | null
          guardian_relationship?: string | null
          id?: string
          ip_address?: string | null
          member_id: string
          signature_text: string
          signed_at?: string
          signed_by?: string
          signed_name: string
          user_agent?: string | null
          waiver_audience?: string
          waiver_id?: string | null
          waiver_version?: number | null
        }
        Update: {
          anonymised_at?: string | null
          dojo_id?: string
          guardian_email?: string | null
          guardian_name?: string | null
          guardian_phone?: string | null
          guardian_relationship?: string | null
          id?: string
          ip_address?: string | null
          member_id?: string
          signature_text?: string
          signed_at?: string
          signed_by?: string
          signed_name?: string
          user_agent?: string | null
          waiver_audience?: string
          waiver_id?: string | null
          waiver_version?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "member_waivers_dojo_id_fkey"
            columns: ["dojo_id"]
            isOneToOne: false
            referencedRelation: "dojos"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "member_waivers_member_id_fkey"
            columns: ["member_id"]
            isOneToOne: false
            referencedRelation: "members"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "member_waivers_waiver_id_fkey"
            columns: ["waiver_id"]
            isOneToOne: false
            referencedRelation: "dojo_waivers"
            referencedColumns: ["id"]
          },
        ]
      }
      members: {
        Row: {
          anonymised_at: string | null
          belt_color: Database["public"]["Enums"]["belt_color"]
          belt_label: string
          cancellation_reason: string | null
          cancellation_requested_at: string | null
          created_at: string
          dan: number | null
          date_of_birth: string | null
          departed_at: string | null
          discipline: string
          dojo_id: string
          email: string | null
          family_group_id: string | null
          free_trial_ends_at: string | null
          guardian_email: string | null
          guardian_member_id: string | null
          guardian_name: string | null
          guardian_phone: string | null
          guardian_relationship: string | null
          id: string
          joined_at: string
          last_invited_at: string | null
          last_seen_at: string | null
          lead_source: string | null
          marketing_opt_out: boolean
          media_consent: boolean
          media_consent_at: string | null
          name: string
          partner_matching_opt_in: boolean
          pause_note: string | null
          pause_reason: string | null
          pause_resumes_at: string | null
          paused_at: string | null
          payment_method: string
          payment_status: Database["public"]["Enums"]["member_payment_status"]
          payment_status_updated_at: string
          pending_price_cents: number | null
          pending_price_effective_at: string | null
          phone: string | null
          plan: Database["public"]["Enums"]["plan_type"]
          plan_covered_by: string | null
          plan_price_cents: number | null
          plan_price_locked_at: string | null
          referred_by: string | null
          retention_hold: boolean
          retention_hold_at: string | null
          retention_hold_by: string | null
          retention_hold_reason: string | null
          retention_notified_at: string | null
          retention_risk_factors: Json
          retention_risk_level: string | null
          retention_risk_score: number | null
          retention_scored_at: string | null
          selected_plan_id: string | null
          signup_source: string | null
          status: Database["public"]["Enums"]["member_status"]
          status_before_pause:
            | Database["public"]["Enums"]["member_status"]
            | null
          stripe_customer_id: string | null
          stripes: number
          terms_accepted_at: string | null
          terms_version_accepted: number | null
          trains: boolean
          trial_reminder_sent_at: string | null
          trial_started_at: string | null
          updated_at: string
          user_id: string | null
          waiver_audience_accepted: string | null
          waiver_signed_at: string | null
          waiver_signed_by: string | null
          waiver_version_accepted: number | null
        }
        Insert: {
          anonymised_at?: string | null
          belt_color?: Database["public"]["Enums"]["belt_color"]
          belt_label?: string
          cancellation_reason?: string | null
          cancellation_requested_at?: string | null
          created_at?: string
          dan?: number | null
          date_of_birth?: string | null
          departed_at?: string | null
          discipline: string
          dojo_id: string
          email?: string | null
          family_group_id?: string | null
          free_trial_ends_at?: string | null
          guardian_email?: string | null
          guardian_member_id?: string | null
          guardian_name?: string | null
          guardian_phone?: string | null
          guardian_relationship?: string | null
          id?: string
          joined_at?: string
          last_invited_at?: string | null
          last_seen_at?: string | null
          lead_source?: string | null
          marketing_opt_out?: boolean
          media_consent?: boolean
          media_consent_at?: string | null
          name: string
          partner_matching_opt_in?: boolean
          pause_note?: string | null
          pause_reason?: string | null
          pause_resumes_at?: string | null
          paused_at?: string | null
          payment_method?: string
          payment_status?: Database["public"]["Enums"]["member_payment_status"]
          payment_status_updated_at?: string
          pending_price_cents?: number | null
          pending_price_effective_at?: string | null
          phone?: string | null
          plan?: Database["public"]["Enums"]["plan_type"]
          plan_covered_by?: string | null
          plan_price_cents?: number | null
          plan_price_locked_at?: string | null
          referred_by?: string | null
          retention_hold?: boolean
          retention_hold_at?: string | null
          retention_hold_by?: string | null
          retention_hold_reason?: string | null
          retention_notified_at?: string | null
          retention_risk_factors?: Json
          retention_risk_level?: string | null
          retention_risk_score?: number | null
          retention_scored_at?: string | null
          selected_plan_id?: string | null
          signup_source?: string | null
          status?: Database["public"]["Enums"]["member_status"]
          status_before_pause?:
            | Database["public"]["Enums"]["member_status"]
            | null
          stripe_customer_id?: string | null
          stripes?: number
          terms_accepted_at?: string | null
          terms_version_accepted?: number | null
          trains?: boolean
          trial_reminder_sent_at?: string | null
          trial_started_at?: string | null
          updated_at?: string
          user_id?: string | null
          waiver_audience_accepted?: string | null
          waiver_signed_at?: string | null
          waiver_signed_by?: string | null
          waiver_version_accepted?: number | null
        }
        Update: {
          anonymised_at?: string | null
          belt_color?: Database["public"]["Enums"]["belt_color"]
          belt_label?: string
          cancellation_reason?: string | null
          cancellation_requested_at?: string | null
          created_at?: string
          dan?: number | null
          date_of_birth?: string | null
          departed_at?: string | null
          discipline?: string
          dojo_id?: string
          email?: string | null
          family_group_id?: string | null
          free_trial_ends_at?: string | null
          guardian_email?: string | null
          guardian_member_id?: string | null
          guardian_name?: string | null
          guardian_phone?: string | null
          guardian_relationship?: string | null
          id?: string
          joined_at?: string
          last_invited_at?: string | null
          last_seen_at?: string | null
          lead_source?: string | null
          marketing_opt_out?: boolean
          media_consent?: boolean
          media_consent_at?: string | null
          name?: string
          partner_matching_opt_in?: boolean
          pause_note?: string | null
          pause_reason?: string | null
          pause_resumes_at?: string | null
          paused_at?: string | null
          payment_method?: string
          payment_status?: Database["public"]["Enums"]["member_payment_status"]
          payment_status_updated_at?: string
          pending_price_cents?: number | null
          pending_price_effective_at?: string | null
          phone?: string | null
          plan?: Database["public"]["Enums"]["plan_type"]
          plan_covered_by?: string | null
          plan_price_cents?: number | null
          plan_price_locked_at?: string | null
          referred_by?: string | null
          retention_hold?: boolean
          retention_hold_at?: string | null
          retention_hold_by?: string | null
          retention_hold_reason?: string | null
          retention_notified_at?: string | null
          retention_risk_factors?: Json
          retention_risk_level?: string | null
          retention_risk_score?: number | null
          retention_scored_at?: string | null
          selected_plan_id?: string | null
          signup_source?: string | null
          status?: Database["public"]["Enums"]["member_status"]
          status_before_pause?:
            | Database["public"]["Enums"]["member_status"]
            | null
          stripe_customer_id?: string | null
          stripes?: number
          terms_accepted_at?: string | null
          terms_version_accepted?: number | null
          trains?: boolean
          trial_reminder_sent_at?: string | null
          trial_started_at?: string | null
          updated_at?: string
          user_id?: string | null
          waiver_audience_accepted?: string | null
          waiver_signed_at?: string | null
          waiver_signed_by?: string | null
          waiver_version_accepted?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "members_dojo_id_fkey"
            columns: ["dojo_id"]
            isOneToOne: false
            referencedRelation: "dojos"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "members_family_group_id_fkey"
            columns: ["family_group_id"]
            isOneToOne: false
            referencedRelation: "family_groups"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "members_guardian_member_id_fkey"
            columns: ["guardian_member_id"]
            isOneToOne: false
            referencedRelation: "members"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "members_plan_covered_by_fkey"
            columns: ["plan_covered_by"]
            isOneToOne: false
            referencedRelation: "members"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "members_selected_plan_id_fkey"
            columns: ["selected_plan_id"]
            isOneToOne: false
            referencedRelation: "dojo_plans"
            referencedColumns: ["id"]
          },
        ]
      }
      membership_pauses: {
        Row: {
          created_at: string
          created_by: string | null
          dojo_id: string
          family_group_id: string | null
          id: string
          member_id: string
          note: string | null
          paused_at: string
          payment_status_before:
            | Database["public"]["Enums"]["member_payment_status"]
            | null
          reason: string
          reminder_sent_at: string | null
          resume_at: string | null
          resumed_at: string | null
          scope: string
          status: string
          status_before: Database["public"]["Enums"]["member_status"] | null
          stripe_paused: boolean
          stripe_subscription_id: string | null
          updated_at: string
        }
        Insert: {
          created_at?: string
          created_by?: string | null
          dojo_id: string
          family_group_id?: string | null
          id?: string
          member_id: string
          note?: string | null
          paused_at?: string
          payment_status_before?:
            | Database["public"]["Enums"]["member_payment_status"]
            | null
          reason?: string
          reminder_sent_at?: string | null
          resume_at?: string | null
          resumed_at?: string | null
          scope?: string
          status?: string
          status_before?: Database["public"]["Enums"]["member_status"] | null
          stripe_paused?: boolean
          stripe_subscription_id?: string | null
          updated_at?: string
        }
        Update: {
          created_at?: string
          created_by?: string | null
          dojo_id?: string
          family_group_id?: string | null
          id?: string
          member_id?: string
          note?: string | null
          paused_at?: string
          payment_status_before?:
            | Database["public"]["Enums"]["member_payment_status"]
            | null
          reason?: string
          reminder_sent_at?: string | null
          resume_at?: string | null
          resumed_at?: string | null
          scope?: string
          status?: string
          status_before?: Database["public"]["Enums"]["member_status"] | null
          stripe_paused?: boolean
          stripe_subscription_id?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "membership_pauses_dojo_id_fkey"
            columns: ["dojo_id"]
            isOneToOne: false
            referencedRelation: "dojos"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "membership_pauses_family_group_id_fkey"
            columns: ["family_group_id"]
            isOneToOne: false
            referencedRelation: "family_groups"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "membership_pauses_member_id_fkey"
            columns: ["member_id"]
            isOneToOne: false
            referencedRelation: "members"
            referencedColumns: ["id"]
          },
        ]
      }
      messages: {
        Row: {
          body: string
          channel: string
          conversation_id: string
          created_at: string
          dojo_id: string
          id: string
          member_id: string
          read_at: string | null
          sender_type: string
          sender_user_id: string | null
        }
        Insert: {
          body: string
          channel?: string
          conversation_id: string
          created_at?: string
          dojo_id: string
          id?: string
          member_id: string
          read_at?: string | null
          sender_type: string
          sender_user_id?: string | null
        }
        Update: {
          body?: string
          channel?: string
          conversation_id?: string
          created_at?: string
          dojo_id?: string
          id?: string
          member_id?: string
          read_at?: string | null
          sender_type?: string
          sender_user_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "messages_conversation_id_fkey"
            columns: ["conversation_id"]
            isOneToOne: false
            referencedRelation: "conversations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "messages_dojo_id_fkey"
            columns: ["dojo_id"]
            isOneToOne: false
            referencedRelation: "dojos"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "messages_member_id_fkey"
            columns: ["member_id"]
            isOneToOne: false
            referencedRelation: "members"
            referencedColumns: ["id"]
          },
        ]
      }
      payments: {
        Row: {
          amount_cents: number
          created_at: string
          currency: string
          dojo_id: string
          failure_reason: string | null
          id: string
          invoice_id: string | null
          member_id: string
          metadata: Json
          method: Database["public"]["Enums"]["payment_method"]
          notes: string | null
          processed_at: string | null
          refunded_amount_cents: number
          status: Database["public"]["Enums"]["payment_status"]
          stripe_charge_id: string | null
          stripe_payment_intent_id: string | null
          updated_at: string
        }
        Insert: {
          amount_cents: number
          created_at?: string
          currency?: string
          dojo_id: string
          failure_reason?: string | null
          id?: string
          invoice_id?: string | null
          member_id: string
          metadata?: Json
          method?: Database["public"]["Enums"]["payment_method"]
          notes?: string | null
          processed_at?: string | null
          refunded_amount_cents?: number
          status?: Database["public"]["Enums"]["payment_status"]
          stripe_charge_id?: string | null
          stripe_payment_intent_id?: string | null
          updated_at?: string
        }
        Update: {
          amount_cents?: number
          created_at?: string
          currency?: string
          dojo_id?: string
          failure_reason?: string | null
          id?: string
          invoice_id?: string | null
          member_id?: string
          metadata?: Json
          method?: Database["public"]["Enums"]["payment_method"]
          notes?: string | null
          processed_at?: string | null
          refunded_amount_cents?: number
          status?: Database["public"]["Enums"]["payment_status"]
          stripe_charge_id?: string | null
          stripe_payment_intent_id?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "payments_dojo_id_fkey"
            columns: ["dojo_id"]
            isOneToOne: false
            referencedRelation: "dojos"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "payments_invoice_id_fkey"
            columns: ["invoice_id"]
            isOneToOne: false
            referencedRelation: "invoices"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "payments_member_id_fkey"
            columns: ["member_id"]
            isOneToOne: false
            referencedRelation: "members"
            referencedColumns: ["id"]
          },
        ]
      }
      plan_price_changes: {
        Row: {
          applied_at: string | null
          created_at: string
          currency: string
          decided_at: string
          decided_by: string | null
          dojo_id: string
          effective_at: string
          id: string
          member_ids: string[]
          members_affected: number
          new_price_cents: number
          new_total_cents: number
          notes: string | null
          notice_days: number
          old_price_cents: number
          old_total_cents: number
          plan_id: string
          scope: string
          updated_at: string
        }
        Insert: {
          applied_at?: string | null
          created_at?: string
          currency?: string
          decided_at?: string
          decided_by?: string | null
          dojo_id: string
          effective_at: string
          id?: string
          member_ids?: string[]
          members_affected?: number
          new_price_cents: number
          new_total_cents?: number
          notes?: string | null
          notice_days?: number
          old_price_cents: number
          old_total_cents?: number
          plan_id: string
          scope?: string
          updated_at?: string
        }
        Update: {
          applied_at?: string | null
          created_at?: string
          currency?: string
          decided_at?: string
          decided_by?: string | null
          dojo_id?: string
          effective_at?: string
          id?: string
          member_ids?: string[]
          members_affected?: number
          new_price_cents?: number
          new_total_cents?: number
          notes?: string | null
          notice_days?: number
          old_price_cents?: number
          old_total_cents?: number
          plan_id?: string
          scope?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "plan_price_changes_dojo_id_fkey"
            columns: ["dojo_id"]
            isOneToOne: false
            referencedRelation: "dojos"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "plan_price_changes_plan_id_fkey"
            columns: ["plan_id"]
            isOneToOne: false
            referencedRelation: "dojo_plans"
            referencedColumns: ["id"]
          },
        ]
      }
      platform_subscriptions: {
        Row: {
          cancel_at_period_end: boolean
          created_at: string
          current_period_end: string | null
          current_period_start: string | null
          dojo_id: string
          environment: string
          id: string
          price_id: string | null
          status: string
          stripe_customer_id: string | null
          stripe_subscription_id: string | null
          updated_at: string
        }
        Insert: {
          cancel_at_period_end?: boolean
          created_at?: string
          current_period_end?: string | null
          current_period_start?: string | null
          dojo_id: string
          environment?: string
          id?: string
          price_id?: string | null
          status?: string
          stripe_customer_id?: string | null
          stripe_subscription_id?: string | null
          updated_at?: string
        }
        Update: {
          cancel_at_period_end?: boolean
          created_at?: string
          current_period_end?: string | null
          current_period_start?: string | null
          dojo_id?: string
          environment?: string
          id?: string
          price_id?: string | null
          status?: string
          stripe_customer_id?: string | null
          stripe_subscription_id?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "platform_subscriptions_dojo_id_fkey"
            columns: ["dojo_id"]
            isOneToOne: true
            referencedRelation: "dojos"
            referencedColumns: ["id"]
          },
        ]
      }
      profiles: {
        Row: {
          avatar_url: string | null
          created_at: string
          display_name: string | null
          email: string | null
          id: string
          updated_at: string
          user_id: string
        }
        Insert: {
          avatar_url?: string | null
          created_at?: string
          display_name?: string | null
          email?: string | null
          id?: string
          updated_at?: string
          user_id: string
        }
        Update: {
          avatar_url?: string | null
          created_at?: string
          display_name?: string | null
          email?: string | null
          id?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      promotions: {
        Row: {
          awarded_by: string | null
          created_at: string
          discipline: string
          dojo_id: string
          from_color: Database["public"]["Enums"]["belt_color"]
          from_dan: number | null
          from_label: string
          from_stripes: number
          id: string
          member_id: string
          note: string | null
          promoted_at: string
          to_color: Database["public"]["Enums"]["belt_color"]
          to_dan: number | null
          to_label: string
          to_stripes: number
        }
        Insert: {
          awarded_by?: string | null
          created_at?: string
          discipline: string
          dojo_id: string
          from_color: Database["public"]["Enums"]["belt_color"]
          from_dan?: number | null
          from_label: string
          from_stripes?: number
          id?: string
          member_id: string
          note?: string | null
          promoted_at?: string
          to_color: Database["public"]["Enums"]["belt_color"]
          to_dan?: number | null
          to_label: string
          to_stripes?: number
        }
        Update: {
          awarded_by?: string | null
          created_at?: string
          discipline?: string
          dojo_id?: string
          from_color?: Database["public"]["Enums"]["belt_color"]
          from_dan?: number | null
          from_label?: string
          from_stripes?: number
          id?: string
          member_id?: string
          note?: string | null
          promoted_at?: string
          to_color?: Database["public"]["Enums"]["belt_color"]
          to_dan?: number | null
          to_label?: string
          to_stripes?: number
        }
        Relationships: [
          {
            foreignKeyName: "promotions_dojo_id_fkey"
            columns: ["dojo_id"]
            isOneToOne: false
            referencedRelation: "dojos"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "promotions_member_id_fkey"
            columns: ["member_id"]
            isOneToOne: false
            referencedRelation: "members"
            referencedColumns: ["id"]
          },
        ]
      }
      public_request_attempts: {
        Row: {
          created_at: string
          dojo_id: string | null
          email_hash: string | null
          endpoint: string
          id: string
          ip_hash: string | null
          outcome: string
        }
        Insert: {
          created_at?: string
          dojo_id?: string | null
          email_hash?: string | null
          endpoint: string
          id?: string
          ip_hash?: string | null
          outcome?: string
        }
        Update: {
          created_at?: string
          dojo_id?: string | null
          email_hash?: string | null
          endpoint?: string
          id?: string
          ip_hash?: string | null
          outcome?: string
        }
        Relationships: [
          {
            foreignKeyName: "public_request_attempts_dojo_id_fkey"
            columns: ["dojo_id"]
            isOneToOne: false
            referencedRelation: "dojos"
            referencedColumns: ["id"]
          },
        ]
      }
      refunds: {
        Row: {
          amount_cents: number
          created_at: string
          created_by: string | null
          currency: string
          dojo_id: string
          id: string
          invoice_id: string | null
          member_id: string | null
          reason: string | null
          source: string
          status: string
          stripe_charge_id: string | null
          stripe_payment_intent_id: string | null
          stripe_refund_id: string
          updated_at: string
        }
        Insert: {
          amount_cents: number
          created_at?: string
          created_by?: string | null
          currency?: string
          dojo_id: string
          id?: string
          invoice_id?: string | null
          member_id?: string | null
          reason?: string | null
          source?: string
          status?: string
          stripe_charge_id?: string | null
          stripe_payment_intent_id?: string | null
          stripe_refund_id: string
          updated_at?: string
        }
        Update: {
          amount_cents?: number
          created_at?: string
          created_by?: string | null
          currency?: string
          dojo_id?: string
          id?: string
          invoice_id?: string | null
          member_id?: string | null
          reason?: string | null
          source?: string
          status?: string
          stripe_charge_id?: string | null
          stripe_payment_intent_id?: string | null
          stripe_refund_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "refunds_dojo_id_fkey"
            columns: ["dojo_id"]
            isOneToOne: false
            referencedRelation: "dojos"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "refunds_invoice_id_fkey"
            columns: ["invoice_id"]
            isOneToOne: false
            referencedRelation: "invoices"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "refunds_member_id_fkey"
            columns: ["member_id"]
            isOneToOne: false
            referencedRelation: "members"
            referencedColumns: ["id"]
          },
        ]
      }
      retention_interventions: {
        Row: {
          created_at: string
          dojo_id: string
          flagged_at: string
          id: string
          intervention_at: string | null
          intervention_by: string | null
          intervention_type: string | null
          member_id: string
          notes: string | null
          outcome: string
          outcome_at: string | null
          risk_factors_at_flag: Json
          risk_level_at_flag: string
          risk_score_at_flag: number
          updated_at: string
          workflow_id: string | null
        }
        Insert: {
          created_at?: string
          dojo_id: string
          flagged_at?: string
          id?: string
          intervention_at?: string | null
          intervention_by?: string | null
          intervention_type?: string | null
          member_id: string
          notes?: string | null
          outcome?: string
          outcome_at?: string | null
          risk_factors_at_flag?: Json
          risk_level_at_flag: string
          risk_score_at_flag?: number
          updated_at?: string
          workflow_id?: string | null
        }
        Update: {
          created_at?: string
          dojo_id?: string
          flagged_at?: string
          id?: string
          intervention_at?: string | null
          intervention_by?: string | null
          intervention_type?: string | null
          member_id?: string
          notes?: string | null
          outcome?: string
          outcome_at?: string | null
          risk_factors_at_flag?: Json
          risk_level_at_flag?: string
          risk_score_at_flag?: number
          updated_at?: string
          workflow_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "retention_interventions_dojo_id_fkey"
            columns: ["dojo_id"]
            isOneToOne: false
            referencedRelation: "dojos"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "retention_interventions_member_id_fkey"
            columns: ["member_id"]
            isOneToOne: false
            referencedRelation: "members"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "retention_interventions_workflow_id_fkey"
            columns: ["workflow_id"]
            isOneToOne: false
            referencedRelation: "workflows"
            referencedColumns: ["id"]
          },
        ]
      }
      segments: {
        Row: {
          created_at: string
          created_by: string
          description: string | null
          dojo_id: string
          filter: Json
          id: string
          name: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          created_by: string
          description?: string | null
          dojo_id: string
          filter?: Json
          id?: string
          name: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          created_by?: string
          description?: string | null
          dojo_id?: string
          filter?: Json
          id?: string
          name?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "segments_dojo_id_fkey"
            columns: ["dojo_id"]
            isOneToOne: false
            referencedRelation: "dojos"
            referencedColumns: ["id"]
          },
        ]
      }
      stripe_events: {
        Row: {
          account: string | null
          created_at: string | null
          event_id: string
          processed_at: string | null
          received_at: string
          status: string
          type: string
        }
        Insert: {
          account?: string | null
          created_at?: string | null
          event_id: string
          processed_at?: string | null
          received_at?: string
          status?: string
          type: string
        }
        Update: {
          account?: string | null
          created_at?: string | null
          event_id?: string
          processed_at?: string | null
          received_at?: string
          status?: string
          type?: string
        }
        Relationships: []
      }
      suppressed_emails: {
        Row: {
          created_at: string
          email: string
          id: string
          metadata: Json | null
          reason: string
        }
        Insert: {
          created_at?: string
          email: string
          id?: string
          metadata?: Json | null
          reason: string
        }
        Update: {
          created_at?: string
          email?: string
          id?: string
          metadata?: Json | null
          reason?: string
        }
        Relationships: []
      }
      user_roles: {
        Row: {
          created_at: string
          id: string
          role: Database["public"]["Enums"]["app_role"]
          user_id: string
        }
        Insert: {
          created_at?: string
          id?: string
          role: Database["public"]["Enums"]["app_role"]
          user_id: string
        }
        Update: {
          created_at?: string
          id?: string
          role?: Database["public"]["Enums"]["app_role"]
          user_id?: string
        }
        Relationships: []
      }
      view_switch_audit_log: {
        Row: {
          created_at: string
          dojo_id: string | null
          from_view: string
          id: string
          to_view: string
          user_email: string
          user_id: string
        }
        Insert: {
          created_at?: string
          dojo_id?: string | null
          from_view: string
          id?: string
          to_view: string
          user_email: string
          user_id: string
        }
        Update: {
          created_at?: string
          dojo_id?: string | null
          from_view?: string
          id?: string
          to_view?: string
          user_email?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "view_switch_audit_log_dojo_id_fkey"
            columns: ["dojo_id"]
            isOneToOne: false
            referencedRelation: "dojos"
            referencedColumns: ["id"]
          },
        ]
      }
      waiver_templates: {
        Row: {
          body_markdown: string
          created_at: string
          discipline: string | null
          dojo_id: string | null
          id: string
          name: string
        }
        Insert: {
          body_markdown: string
          created_at?: string
          discipline?: string | null
          dojo_id?: string | null
          id?: string
          name: string
        }
        Update: {
          body_markdown?: string
          created_at?: string
          discipline?: string | null
          dojo_id?: string | null
          id?: string
          name?: string
        }
        Relationships: [
          {
            foreignKeyName: "waiver_templates_dojo_id_fkey"
            columns: ["dojo_id"]
            isOneToOne: false
            referencedRelation: "dojos"
            referencedColumns: ["id"]
          },
        ]
      }
      workflow_member_actions: {
        Row: {
          actioned_at: string
          created_at: string
          dojo_id: string
          id: string
          member_id: string
          workflow_id: string
        }
        Insert: {
          actioned_at?: string
          created_at?: string
          dojo_id: string
          id?: string
          member_id: string
          workflow_id: string
        }
        Update: {
          actioned_at?: string
          created_at?: string
          dojo_id?: string
          id?: string
          member_id?: string
          workflow_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "workflow_member_actions_dojo_id_fkey"
            columns: ["dojo_id"]
            isOneToOne: false
            referencedRelation: "dojos"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "workflow_member_actions_member_id_fkey"
            columns: ["member_id"]
            isOneToOne: false
            referencedRelation: "members"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "workflow_member_actions_workflow_id_fkey"
            columns: ["workflow_id"]
            isOneToOne: false
            referencedRelation: "workflows"
            referencedColumns: ["id"]
          },
        ]
      }
      workflow_runs: {
        Row: {
          details: Json
          dojo_id: string
          error: string | null
          failed_count: number
          finished_at: string | null
          id: string
          matched_count: number
          member_id: string | null
          started_at: string
          status: Database["public"]["Enums"]["workflow_run_status"]
          succeeded_count: number
          trigger_source: string | null
          triggered_at: string
          workflow_id: string
        }
        Insert: {
          details?: Json
          dojo_id: string
          error?: string | null
          failed_count?: number
          finished_at?: string | null
          id?: string
          matched_count?: number
          member_id?: string | null
          started_at?: string
          status?: Database["public"]["Enums"]["workflow_run_status"]
          succeeded_count?: number
          trigger_source?: string | null
          triggered_at?: string
          workflow_id: string
        }
        Update: {
          details?: Json
          dojo_id?: string
          error?: string | null
          failed_count?: number
          finished_at?: string | null
          id?: string
          matched_count?: number
          member_id?: string | null
          started_at?: string
          status?: Database["public"]["Enums"]["workflow_run_status"]
          succeeded_count?: number
          trigger_source?: string | null
          triggered_at?: string
          workflow_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "workflow_runs_dojo_id_fkey"
            columns: ["dojo_id"]
            isOneToOne: false
            referencedRelation: "dojos"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "workflow_runs_member_id_fkey"
            columns: ["member_id"]
            isOneToOne: false
            referencedRelation: "members"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "workflow_runs_workflow_id_fkey"
            columns: ["workflow_id"]
            isOneToOne: false
            referencedRelation: "workflows"
            referencedColumns: ["id"]
          },
        ]
      }
      workflows: {
        Row: {
          action_cooldown_days: number
          actions: Json
          created_at: string
          created_by: string
          description: string | null
          dojo_id: string
          enabled: boolean
          filter: Json
          id: string
          last_run_at: string | null
          name: string
          segment_id: string | null
          template_id: string | null
          trigger_config: Json
          trigger_type: Database["public"]["Enums"]["workflow_trigger_type"]
          updated_at: string
        }
        Insert: {
          action_cooldown_days?: number
          actions?: Json
          created_at?: string
          created_by: string
          description?: string | null
          dojo_id: string
          enabled?: boolean
          filter?: Json
          id?: string
          last_run_at?: string | null
          name: string
          segment_id?: string | null
          template_id?: string | null
          trigger_config?: Json
          trigger_type: Database["public"]["Enums"]["workflow_trigger_type"]
          updated_at?: string
        }
        Update: {
          action_cooldown_days?: number
          actions?: Json
          created_at?: string
          created_by?: string
          description?: string | null
          dojo_id?: string
          enabled?: boolean
          filter?: Json
          id?: string
          last_run_at?: string | null
          name?: string
          segment_id?: string | null
          template_id?: string | null
          trigger_config?: Json
          trigger_type?: Database["public"]["Enums"]["workflow_trigger_type"]
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "workflows_dojo_id_fkey"
            columns: ["dojo_id"]
            isOneToOne: false
            referencedRelation: "dojos"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "workflows_segment_id_fkey"
            columns: ["segment_id"]
            isOneToOne: false
            referencedRelation: "segments"
            referencedColumns: ["id"]
          },
        ]
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      accept_my_agreements: {
        Args: {
          p_accept_terms?: boolean
          p_accept_waiver?: boolean
          p_member_id: string
          p_signed_name?: string
        }
        Returns: {
          anonymised_at: string | null
          belt_color: Database["public"]["Enums"]["belt_color"]
          belt_label: string
          cancellation_reason: string | null
          cancellation_requested_at: string | null
          created_at: string
          dan: number | null
          date_of_birth: string | null
          departed_at: string | null
          discipline: string
          dojo_id: string
          email: string | null
          family_group_id: string | null
          free_trial_ends_at: string | null
          guardian_email: string | null
          guardian_member_id: string | null
          guardian_name: string | null
          guardian_phone: string | null
          guardian_relationship: string | null
          id: string
          joined_at: string
          last_invited_at: string | null
          last_seen_at: string | null
          lead_source: string | null
          marketing_opt_out: boolean
          media_consent: boolean
          media_consent_at: string | null
          name: string
          partner_matching_opt_in: boolean
          pause_note: string | null
          pause_reason: string | null
          pause_resumes_at: string | null
          paused_at: string | null
          payment_method: string
          payment_status: Database["public"]["Enums"]["member_payment_status"]
          payment_status_updated_at: string
          pending_price_cents: number | null
          pending_price_effective_at: string | null
          phone: string | null
          plan: Database["public"]["Enums"]["plan_type"]
          plan_covered_by: string | null
          plan_price_cents: number | null
          plan_price_locked_at: string | null
          referred_by: string | null
          retention_hold: boolean
          retention_hold_at: string | null
          retention_hold_by: string | null
          retention_hold_reason: string | null
          retention_notified_at: string | null
          retention_risk_factors: Json
          retention_risk_level: string | null
          retention_risk_score: number | null
          retention_scored_at: string | null
          selected_plan_id: string | null
          signup_source: string | null
          status: Database["public"]["Enums"]["member_status"]
          status_before_pause:
            | Database["public"]["Enums"]["member_status"]
            | null
          stripe_customer_id: string | null
          stripes: number
          terms_accepted_at: string | null
          terms_version_accepted: number | null
          trains: boolean
          trial_reminder_sent_at: string | null
          trial_started_at: string | null
          updated_at: string
          user_id: string | null
          waiver_audience_accepted: string | null
          waiver_signed_at: string | null
          waiver_signed_by: string | null
          waiver_version_accepted: number | null
        }
        SetofOptions: {
          from: "*"
          to: "members"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      claim_my_member_records: { Args: never; Returns: number }
      delete_email: {
        Args: { message_id: number; queue_name: string }
        Returns: boolean
      }
      dojo_today: { Args: { _dojo_id: string }; Returns: string }
      email_queue_dispatch: { Args: never; Returns: undefined }
      enforce_overdue_grace: { Args: never; Returns: undefined }
      enqueue_email: {
        Args: { payload: Json; queue_name: string }
        Returns: number
      }
      has_dojo_role: {
        Args: {
          _dojo_id: string
          _role: Database["public"]["Enums"]["dojo_role"]
          _user_id: string
        }
        Returns: boolean
      }
      has_role: {
        Args: {
          _role: Database["public"]["Enums"]["app_role"]
          _user_id: string
        }
        Returns: boolean
      }
      is_dojo_staff: {
        Args: { _dojo_id: string; _user_id: string }
        Returns: boolean
      }
      is_staff: { Args: { _user_id: string }; Returns: boolean }
      member_email_drift: {
        Args: { _dojo_id: string }
        Returns: {
          login_email: string
          member_email: string
          member_id: string
          member_name: string
        }[]
      }
      member_login_email: { Args: { _member_id: string }; Returns: string }
      move_to_dlq: {
        Args: {
          dlq_name: string
          message_id: number
          payload: Json
          source_queue: string
        }
        Returns: number
      }
      read_email_batch: {
        Args: { batch_size: number; queue_name: string; vt: number }
        Returns: {
          message: Json
          msg_id: number
          read_ct: number
        }[]
      }
      recompute_member_payment_statuses: {
        Args: { _dojo_id?: string }
        Returns: number
      }
      request_my_cancellation: {
        Args: { p_member_id: string; p_reason: string }
        Returns: {
          anonymised_at: string | null
          belt_color: Database["public"]["Enums"]["belt_color"]
          belt_label: string
          cancellation_reason: string | null
          cancellation_requested_at: string | null
          created_at: string
          dan: number | null
          date_of_birth: string | null
          departed_at: string | null
          discipline: string
          dojo_id: string
          email: string | null
          family_group_id: string | null
          free_trial_ends_at: string | null
          guardian_email: string | null
          guardian_member_id: string | null
          guardian_name: string | null
          guardian_phone: string | null
          guardian_relationship: string | null
          id: string
          joined_at: string
          last_invited_at: string | null
          last_seen_at: string | null
          lead_source: string | null
          marketing_opt_out: boolean
          media_consent: boolean
          media_consent_at: string | null
          name: string
          partner_matching_opt_in: boolean
          pause_note: string | null
          pause_reason: string | null
          pause_resumes_at: string | null
          paused_at: string | null
          payment_method: string
          payment_status: Database["public"]["Enums"]["member_payment_status"]
          payment_status_updated_at: string
          pending_price_cents: number | null
          pending_price_effective_at: string | null
          phone: string | null
          plan: Database["public"]["Enums"]["plan_type"]
          plan_covered_by: string | null
          plan_price_cents: number | null
          plan_price_locked_at: string | null
          referred_by: string | null
          retention_hold: boolean
          retention_hold_at: string | null
          retention_hold_by: string | null
          retention_hold_reason: string | null
          retention_notified_at: string | null
          retention_risk_factors: Json
          retention_risk_level: string | null
          retention_risk_score: number | null
          retention_scored_at: string | null
          selected_plan_id: string | null
          signup_source: string | null
          status: Database["public"]["Enums"]["member_status"]
          status_before_pause:
            | Database["public"]["Enums"]["member_status"]
            | null
          stripe_customer_id: string | null
          stripes: number
          terms_accepted_at: string | null
          terms_version_accepted: number | null
          trains: boolean
          trial_reminder_sent_at: string | null
          trial_started_at: string | null
          updated_at: string
          user_id: string | null
          waiver_audience_accepted: string | null
          waiver_signed_at: string | null
          waiver_signed_by: string | null
          waiver_version_accepted: number | null
        }
        SetofOptions: {
          from: "*"
          to: "members"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      set_my_media_consent: {
        Args: { p_consent: boolean; p_member_id: string }
        Returns: {
          anonymised_at: string | null
          belt_color: Database["public"]["Enums"]["belt_color"]
          belt_label: string
          cancellation_reason: string | null
          cancellation_requested_at: string | null
          created_at: string
          dan: number | null
          date_of_birth: string | null
          departed_at: string | null
          discipline: string
          dojo_id: string
          email: string | null
          family_group_id: string | null
          free_trial_ends_at: string | null
          guardian_email: string | null
          guardian_member_id: string | null
          guardian_name: string | null
          guardian_phone: string | null
          guardian_relationship: string | null
          id: string
          joined_at: string
          last_invited_at: string | null
          last_seen_at: string | null
          lead_source: string | null
          marketing_opt_out: boolean
          media_consent: boolean
          media_consent_at: string | null
          name: string
          partner_matching_opt_in: boolean
          pause_note: string | null
          pause_reason: string | null
          pause_resumes_at: string | null
          paused_at: string | null
          payment_method: string
          payment_status: Database["public"]["Enums"]["member_payment_status"]
          payment_status_updated_at: string
          pending_price_cents: number | null
          pending_price_effective_at: string | null
          phone: string | null
          plan: Database["public"]["Enums"]["plan_type"]
          plan_covered_by: string | null
          plan_price_cents: number | null
          plan_price_locked_at: string | null
          referred_by: string | null
          retention_hold: boolean
          retention_hold_at: string | null
          retention_hold_by: string | null
          retention_hold_reason: string | null
          retention_notified_at: string | null
          retention_risk_factors: Json
          retention_risk_level: string | null
          retention_risk_score: number | null
          retention_scored_at: string | null
          selected_plan_id: string | null
          signup_source: string | null
          status: Database["public"]["Enums"]["member_status"]
          status_before_pause:
            | Database["public"]["Enums"]["member_status"]
            | null
          stripe_customer_id: string | null
          stripes: number
          terms_accepted_at: string | null
          terms_version_accepted: number | null
          trains: boolean
          trial_reminder_sent_at: string | null
          trial_started_at: string | null
          updated_at: string
          user_id: string | null
          waiver_audience_accepted: string | null
          waiver_signed_at: string | null
          waiver_signed_by: string | null
          waiver_version_accepted: number | null
        }
        SetofOptions: {
          from: "*"
          to: "members"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      set_my_partner_matching: {
        Args: { p_member_id: string; p_opt_in: boolean }
        Returns: {
          anonymised_at: string | null
          belt_color: Database["public"]["Enums"]["belt_color"]
          belt_label: string
          cancellation_reason: string | null
          cancellation_requested_at: string | null
          created_at: string
          dan: number | null
          date_of_birth: string | null
          departed_at: string | null
          discipline: string
          dojo_id: string
          email: string | null
          family_group_id: string | null
          free_trial_ends_at: string | null
          guardian_email: string | null
          guardian_member_id: string | null
          guardian_name: string | null
          guardian_phone: string | null
          guardian_relationship: string | null
          id: string
          joined_at: string
          last_invited_at: string | null
          last_seen_at: string | null
          lead_source: string | null
          marketing_opt_out: boolean
          media_consent: boolean
          media_consent_at: string | null
          name: string
          partner_matching_opt_in: boolean
          pause_note: string | null
          pause_reason: string | null
          pause_resumes_at: string | null
          paused_at: string | null
          payment_method: string
          payment_status: Database["public"]["Enums"]["member_payment_status"]
          payment_status_updated_at: string
          pending_price_cents: number | null
          pending_price_effective_at: string | null
          phone: string | null
          plan: Database["public"]["Enums"]["plan_type"]
          plan_covered_by: string | null
          plan_price_cents: number | null
          plan_price_locked_at: string | null
          referred_by: string | null
          retention_hold: boolean
          retention_hold_at: string | null
          retention_hold_by: string | null
          retention_hold_reason: string | null
          retention_notified_at: string | null
          retention_risk_factors: Json
          retention_risk_level: string | null
          retention_risk_score: number | null
          retention_scored_at: string | null
          selected_plan_id: string | null
          signup_source: string | null
          status: Database["public"]["Enums"]["member_status"]
          status_before_pause:
            | Database["public"]["Enums"]["member_status"]
            | null
          stripe_customer_id: string | null
          stripes: number
          terms_accepted_at: string | null
          terms_version_accepted: number | null
          trains: boolean
          trial_reminder_sent_at: string | null
          trial_started_at: string | null
          updated_at: string
          user_id: string | null
          waiver_audience_accepted: string | null
          waiver_signed_at: string | null
          waiver_signed_by: string | null
          waiver_version_accepted: number | null
        }
        SetofOptions: {
          from: "*"
          to: "members"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      trial_check: {
        Args: { _date: string; _dojo_id: string; _member_id: string }
        Returns: Json
      }
      update_my_contact: {
        Args: {
          p_email: string
          p_marketing_opt_out: boolean
          p_member_id: string
          p_name: string
          p_phone: string
        }
        Returns: {
          anonymised_at: string | null
          belt_color: Database["public"]["Enums"]["belt_color"]
          belt_label: string
          cancellation_reason: string | null
          cancellation_requested_at: string | null
          created_at: string
          dan: number | null
          date_of_birth: string | null
          departed_at: string | null
          discipline: string
          dojo_id: string
          email: string | null
          family_group_id: string | null
          free_trial_ends_at: string | null
          guardian_email: string | null
          guardian_member_id: string | null
          guardian_name: string | null
          guardian_phone: string | null
          guardian_relationship: string | null
          id: string
          joined_at: string
          last_invited_at: string | null
          last_seen_at: string | null
          lead_source: string | null
          marketing_opt_out: boolean
          media_consent: boolean
          media_consent_at: string | null
          name: string
          partner_matching_opt_in: boolean
          pause_note: string | null
          pause_reason: string | null
          pause_resumes_at: string | null
          paused_at: string | null
          payment_method: string
          payment_status: Database["public"]["Enums"]["member_payment_status"]
          payment_status_updated_at: string
          pending_price_cents: number | null
          pending_price_effective_at: string | null
          phone: string | null
          plan: Database["public"]["Enums"]["plan_type"]
          plan_covered_by: string | null
          plan_price_cents: number | null
          plan_price_locked_at: string | null
          referred_by: string | null
          retention_hold: boolean
          retention_hold_at: string | null
          retention_hold_by: string | null
          retention_hold_reason: string | null
          retention_notified_at: string | null
          retention_risk_factors: Json
          retention_risk_level: string | null
          retention_risk_score: number | null
          retention_scored_at: string | null
          selected_plan_id: string | null
          signup_source: string | null
          status: Database["public"]["Enums"]["member_status"]
          status_before_pause:
            | Database["public"]["Enums"]["member_status"]
            | null
          stripe_customer_id: string | null
          stripes: number
          terms_accepted_at: string | null
          terms_version_accepted: number | null
          trains: boolean
          trial_reminder_sent_at: string | null
          trial_started_at: string | null
          updated_at: string
          user_id: string | null
          waiver_audience_accepted: string | null
          waiver_signed_at: string | null
          waiver_signed_by: string | null
          waiver_version_accepted: number | null
        }
        SetofOptions: {
          from: "*"
          to: "members"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      user_in_dojo: {
        Args: { _dojo_id: string; _user_id: string }
        Returns: boolean
      }
      user_is_in_dojo: {
        Args: { _dojo_id: string; _user_id: string }
        Returns: boolean
      }
      withdraw_my_cancellation: {
        Args: { p_member_id: string }
        Returns: {
          anonymised_at: string | null
          belt_color: Database["public"]["Enums"]["belt_color"]
          belt_label: string
          cancellation_reason: string | null
          cancellation_requested_at: string | null
          created_at: string
          dan: number | null
          date_of_birth: string | null
          departed_at: string | null
          discipline: string
          dojo_id: string
          email: string | null
          family_group_id: string | null
          free_trial_ends_at: string | null
          guardian_email: string | null
          guardian_member_id: string | null
          guardian_name: string | null
          guardian_phone: string | null
          guardian_relationship: string | null
          id: string
          joined_at: string
          last_invited_at: string | null
          last_seen_at: string | null
          lead_source: string | null
          marketing_opt_out: boolean
          media_consent: boolean
          media_consent_at: string | null
          name: string
          partner_matching_opt_in: boolean
          pause_note: string | null
          pause_reason: string | null
          pause_resumes_at: string | null
          paused_at: string | null
          payment_method: string
          payment_status: Database["public"]["Enums"]["member_payment_status"]
          payment_status_updated_at: string
          pending_price_cents: number | null
          pending_price_effective_at: string | null
          phone: string | null
          plan: Database["public"]["Enums"]["plan_type"]
          plan_covered_by: string | null
          plan_price_cents: number | null
          plan_price_locked_at: string | null
          referred_by: string | null
          retention_hold: boolean
          retention_hold_at: string | null
          retention_hold_by: string | null
          retention_hold_reason: string | null
          retention_notified_at: string | null
          retention_risk_factors: Json
          retention_risk_level: string | null
          retention_risk_score: number | null
          retention_scored_at: string | null
          selected_plan_id: string | null
          signup_source: string | null
          status: Database["public"]["Enums"]["member_status"]
          status_before_pause:
            | Database["public"]["Enums"]["member_status"]
            | null
          stripe_customer_id: string | null
          stripes: number
          terms_accepted_at: string | null
          terms_version_accepted: number | null
          trains: boolean
          trial_reminder_sent_at: string | null
          trial_started_at: string | null
          updated_at: string
          user_id: string | null
          waiver_audience_accepted: string | null
          waiver_signed_at: string | null
          waiver_signed_by: string | null
          waiver_version_accepted: number | null
        }
        SetofOptions: {
          from: "*"
          to: "members"
          isOneToOne: true
          isSetofReturn: false
        }
      }
    }
    Enums: {
      app_role: "manager" | "coach" | "member" | "pending"
      belt_color:
        | "white"
        | "yellow"
        | "orange"
        | "green"
        | "blue"
        | "purple"
        | "brown"
        | "red"
        | "black"
        | "beginner"
        | "novice"
        | "intermediate"
        | "advanced"
        | "competitor"
      broadcast_status: "draft" | "sending" | "sent" | "failed" | "queued"
      class_booking_status: "booked" | "attended" | "no_show" | "cancelled"
      dojo_role: "manager" | "admin" | "coach" | "member" | "pending" | "owner"
      invoice_status:
        | "paid"
        | "due"
        | "overdue"
        | "partially_refunded"
        | "refunded"
      member_payment_status:
        | "current"
        | "due"
        | "overdue"
        | "none"
        | "disputed"
        | "pending"
      member_status: "active" | "lapsed" | "trial" | "pending" | "paused"
      overhead_category:
        | "rent"
        | "utilities"
        | "payroll"
        | "equipment"
        | "marketing"
        | "insurance"
        | "software"
        | "other"
      overhead_recurrence: "one_off" | "monthly" | "yearly"
      payment_method: "card" | "bank_transfer" | "cash" | "check" | "other"
      payment_status:
        | "pending"
        | "succeeded"
        | "failed"
        | "refunded"
        | "partially_refunded"
        | "canceled"
      plan_type: "Monthly" | "Annual" | "Drop-in" | "Family" | "Unknown"
      subscription_status:
        | "trialing"
        | "active"
        | "past_due"
        | "paused"
        | "canceled"
        | "unpaid"
        | "incomplete"
      task_status: "open" | "done" | "dismissed"
      workflow_run_status:
        | "queued"
        | "running"
        | "succeeded"
        | "failed"
        | "partial"
        | "pending"
      workflow_trigger_type: "manual" | "scheduled" | "event"
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends (DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never) = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends (PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never) = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  public: {
    Enums: {
      app_role: ["manager", "coach", "member", "pending"],
      belt_color: [
        "white",
        "yellow",
        "orange",
        "green",
        "blue",
        "purple",
        "brown",
        "red",
        "black",
        "beginner",
        "novice",
        "intermediate",
        "advanced",
        "competitor",
      ],
      broadcast_status: ["draft", "sending", "sent", "failed", "queued"],
      class_booking_status: ["booked", "attended", "no_show", "cancelled"],
      dojo_role: ["manager", "admin", "coach", "member", "pending", "owner"],
      invoice_status: [
        "paid",
        "due",
        "overdue",
        "partially_refunded",
        "refunded",
      ],
      member_payment_status: [
        "current",
        "due",
        "overdue",
        "none",
        "disputed",
        "pending",
      ],
      member_status: ["active", "lapsed", "trial", "pending", "paused"],
      overhead_category: [
        "rent",
        "utilities",
        "payroll",
        "equipment",
        "marketing",
        "insurance",
        "software",
        "other",
      ],
      overhead_recurrence: ["one_off", "monthly", "yearly"],
      payment_method: ["card", "bank_transfer", "cash", "check", "other"],
      payment_status: [
        "pending",
        "succeeded",
        "failed",
        "refunded",
        "partially_refunded",
        "canceled",
      ],
      plan_type: ["Monthly", "Annual", "Drop-in", "Family", "Unknown"],
      subscription_status: [
        "trialing",
        "active",
        "past_due",
        "paused",
        "canceled",
        "unpaid",
        "incomplete",
      ],
      task_status: ["open", "done", "dismissed"],
      workflow_run_status: [
        "queued",
        "running",
        "succeeded",
        "failed",
        "partial",
        "pending",
      ],
      workflow_trigger_type: ["manual", "scheduled", "event"],
    },
  },
} as const
