CREATE TYPE "public"."automod_rule_type" AS ENUM('message_rate', 'repeated_message', 'mention_spam', 'invite_link', 'suspicious_link', 'blocked_terms', 'regex', 'caps', 'emoji_spam', 'channel_hopping', 'new_account');--> statement-breakpoint
CREATE TYPE "public"."case_action" AS ENUM('warn', 'timeout', 'untimeout', 'kick', 'ban', 'unban', 'automod');--> statement-breakpoint
CREATE TYPE "public"."case_status" AS ENUM('active', 'expired', 'voided');--> statement-breakpoint
CREATE TYPE "public"."log_kind" AS ENUM('moderation', 'automod', 'joins', 'leaves', 'messages', 'members', 'tickets', 'reports', 'suggestions', 'config');--> statement-breakpoint
CREATE TYPE "public"."panel_style" AS ENUM('buttons', 'select');--> statement-breakpoint
CREATE TYPE "public"."report_status" AS ENUM('open', 'in_review', 'resolved', 'dismissed');--> statement-breakpoint
CREATE TYPE "public"."report_type" AS ENUM('user', 'message', 'general');--> statement-breakpoint
CREATE TYPE "public"."role_menu_style" AS ENUM('buttons', 'select');--> statement-breakpoint
CREATE TYPE "public"."suggestion_status" AS ENUM('open', 'under_review', 'planned', 'accepted', 'declined', 'implemented');--> statement-breakpoint
CREATE TYPE "public"."ticket_status" AS ENUM('open', 'closed');--> statement-breakpoint
CREATE TABLE "audit_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"guild_id" bigint NOT NULL,
	"actor_id" bigint,
	"action" text NOT NULL,
	"target" text,
	"data" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "automod_rules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"guild_id" bigint NOT NULL,
	"name" text NOT NULL,
	"type" "automod_rule_type" NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"severity" integer DEFAULT 1 NOT NULL,
	"config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"actions" jsonb DEFAULT '{"delete":true,"warn":false,"timeoutMs":null,"notifyStaff":false,"createCase":false}'::jsonb NOT NULL,
	"exempt_role_ids" bigint[] DEFAULT '{}' NOT NULL,
	"exempt_channel_ids" bigint[] DEFAULT '{}' NOT NULL,
	"cooldown_seconds" integer DEFAULT 30 NOT NULL,
	"created_by" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "guild_log_channels" (
	"guild_id" bigint NOT NULL,
	"kind" "log_kind" NOT NULL,
	"channel_id" bigint NOT NULL,
	CONSTRAINT "guild_log_channels_guild_id_kind_pk" PRIMARY KEY("guild_id","kind")
);
--> statement-breakpoint
CREATE TABLE "guild_sequences" (
	"guild_id" bigint NOT NULL,
	"kind" text NOT NULL,
	"value" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "guild_sequences_guild_id_kind_pk" PRIMARY KEY("guild_id","kind")
);
--> statement-breakpoint
CREATE TABLE "guild_settings" (
	"guild_id" bigint PRIMARY KEY NOT NULL,
	"member_role_id" bigint,
	"welcome_channel_id" bigint,
	"welcome_message" text,
	"leave_channel_id" bigint,
	"leave_message" text,
	"dm_on_moderation" boolean DEFAULT true NOT NULL,
	"persist_roles" boolean DEFAULT false NOT NULL,
	"suggestion_channel_id" bigint,
	"report_channel_id" bigint,
	"ticket_archive_category_id" bigint,
	"ticket_inactivity_hours" integer DEFAULT 72 NOT NULL,
	"raid_join_threshold" integer DEFAULT 10 NOT NULL,
	"raid_join_window_seconds" integer DEFAULT 60 NOT NULL,
	"raid_min_account_age_hours" integer DEFAULT 24 NOT NULL,
	"raid_alert_role_id" bigint,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "guilds" (
	"id" bigint PRIMARY KEY NOT NULL,
	"name" text DEFAULT '' NOT NULL,
	"joined_at" timestamp with time zone DEFAULT now() NOT NULL,
	"left_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "member_persisted_roles" (
	"guild_id" bigint NOT NULL,
	"user_id" bigint NOT NULL,
	"role_ids" bigint[] DEFAULT '{}' NOT NULL,
	"left_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "member_persisted_roles_guild_id_user_id_pk" PRIMARY KEY("guild_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "moderation_case_notes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"case_id" uuid NOT NULL,
	"author_id" bigint NOT NULL,
	"content" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "moderation_cases" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"guild_id" bigint NOT NULL,
	"case_number" integer NOT NULL,
	"action" "case_action" NOT NULL,
	"status" "case_status" DEFAULT 'active' NOT NULL,
	"target_user_id" bigint NOT NULL,
	"moderator_user_id" bigint NOT NULL,
	"reason" text,
	"duration_ms" integer,
	"expires_at" timestamp with time zone,
	"evidence" jsonb DEFAULT '{"urls":[],"messageIds":[],"attachments":[]}'::jsonb NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"dm_delivered" text DEFAULT 'skipped' NOT NULL,
	"log_message_id" bigint,
	"voided_by" bigint,
	"voided_at" timestamp with time zone,
	"void_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "permission_grants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"guild_id" bigint NOT NULL,
	"role_id" bigint NOT NULL,
	"permission" text NOT NULL,
	"granted_by" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "report_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"report_id" uuid NOT NULL,
	"type" text NOT NULL,
	"actor_id" bigint,
	"data" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "reports" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"guild_id" bigint NOT NULL,
	"report_number" integer NOT NULL,
	"type" "report_type" NOT NULL,
	"status" "report_status" DEFAULT 'open' NOT NULL,
	"reporter_id" bigint NOT NULL,
	"target_user_id" bigint,
	"message_id" bigint,
	"channel_id" bigint,
	"message_content" text,
	"reason" text NOT NULL,
	"evidence" text,
	"assigned_to" bigint,
	"case_id" uuid,
	"staff_message_id" bigint,
	"resolution" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "role_menu_options" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"menu_id" uuid NOT NULL,
	"role_id" bigint NOT NULL,
	"label" text NOT NULL,
	"description" text,
	"emoji" text,
	"requires_role_id" bigint,
	"conflicts_with_role_ids" bigint[] DEFAULT '{}' NOT NULL,
	"position" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "role_menus" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"guild_id" bigint NOT NULL,
	"name" text NOT NULL,
	"title" text NOT NULL,
	"body" text,
	"style" "role_menu_style" DEFAULT 'buttons' NOT NULL,
	"exclusive" boolean DEFAULT false NOT NULL,
	"max_selections" integer,
	"required_role_id" bigint,
	"channel_id" bigint,
	"message_id" bigint,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "staff_notes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"guild_id" bigint NOT NULL,
	"user_id" bigint NOT NULL,
	"author_id" bigint NOT NULL,
	"content" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	"deleted_by" bigint
);
--> statement-breakpoint
CREATE TABLE "suggestion_votes" (
	"suggestion_id" uuid NOT NULL,
	"user_id" bigint NOT NULL,
	"vote" smallint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "suggestion_votes_suggestion_id_user_id_pk" PRIMARY KEY("suggestion_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "suggestions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"guild_id" bigint NOT NULL,
	"suggestion_number" integer NOT NULL,
	"author_id" bigint NOT NULL,
	"channel_id" bigint NOT NULL,
	"message_id" bigint,
	"title" text NOT NULL,
	"content" text NOT NULL,
	"status" "suggestion_status" DEFAULT 'open' NOT NULL,
	"upvotes" integer DEFAULT 0 NOT NULL,
	"downvotes" integer DEFAULT 0 NOT NULL,
	"official_response" text,
	"responded_by" bigint,
	"responded_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ticket_categories" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"guild_id" bigint NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"emoji" text,
	"parent_channel_id" bigint,
	"staff_role_ids" bigint[] DEFAULT '{}' NOT NULL,
	"opening_message" text,
	"position" integer DEFAULT 0 NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ticket_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"ticket_id" uuid NOT NULL,
	"type" text NOT NULL,
	"actor_id" bigint,
	"data" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ticket_notes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"ticket_id" uuid NOT NULL,
	"author_id" bigint NOT NULL,
	"content" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ticket_panels" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"guild_id" bigint NOT NULL,
	"channel_id" bigint NOT NULL,
	"message_id" bigint,
	"title" text NOT NULL,
	"body" text,
	"style" "panel_style" DEFAULT 'buttons' NOT NULL,
	"category_ids" uuid[] DEFAULT '{}' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ticket_participants" (
	"ticket_id" uuid NOT NULL,
	"user_id" bigint NOT NULL,
	"added_by" bigint NOT NULL,
	"added_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ticket_participants_ticket_id_user_id_pk" PRIMARY KEY("ticket_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "ticket_transcripts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"ticket_id" uuid NOT NULL,
	"storage_key" text NOT NULL,
	"format" text DEFAULT 'html' NOT NULL,
	"message_count" integer DEFAULT 0 NOT NULL,
	"size_bytes" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tickets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"guild_id" bigint NOT NULL,
	"ticket_number" integer NOT NULL,
	"category_id" uuid,
	"opener_user_id" bigint NOT NULL,
	"channel_id" bigint NOT NULL,
	"status" "ticket_status" DEFAULT 'open' NOT NULL,
	"claimed_by" bigint,
	"closed_by" bigint,
	"closed_at" timestamp with time zone,
	"close_reason" text,
	"last_activity_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_guild_id_guilds_id_fk" FOREIGN KEY ("guild_id") REFERENCES "public"."guilds"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automod_rules" ADD CONSTRAINT "automod_rules_guild_id_guilds_id_fk" FOREIGN KEY ("guild_id") REFERENCES "public"."guilds"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "guild_log_channels" ADD CONSTRAINT "guild_log_channels_guild_id_guilds_id_fk" FOREIGN KEY ("guild_id") REFERENCES "public"."guilds"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "guild_sequences" ADD CONSTRAINT "guild_sequences_guild_id_guilds_id_fk" FOREIGN KEY ("guild_id") REFERENCES "public"."guilds"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "guild_settings" ADD CONSTRAINT "guild_settings_guild_id_guilds_id_fk" FOREIGN KEY ("guild_id") REFERENCES "public"."guilds"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "member_persisted_roles" ADD CONSTRAINT "member_persisted_roles_guild_id_guilds_id_fk" FOREIGN KEY ("guild_id") REFERENCES "public"."guilds"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "moderation_case_notes" ADD CONSTRAINT "moderation_case_notes_case_id_moderation_cases_id_fk" FOREIGN KEY ("case_id") REFERENCES "public"."moderation_cases"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "moderation_cases" ADD CONSTRAINT "moderation_cases_guild_id_guilds_id_fk" FOREIGN KEY ("guild_id") REFERENCES "public"."guilds"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "permission_grants" ADD CONSTRAINT "permission_grants_guild_id_guilds_id_fk" FOREIGN KEY ("guild_id") REFERENCES "public"."guilds"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "report_events" ADD CONSTRAINT "report_events_report_id_reports_id_fk" FOREIGN KEY ("report_id") REFERENCES "public"."reports"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reports" ADD CONSTRAINT "reports_guild_id_guilds_id_fk" FOREIGN KEY ("guild_id") REFERENCES "public"."guilds"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reports" ADD CONSTRAINT "reports_case_id_moderation_cases_id_fk" FOREIGN KEY ("case_id") REFERENCES "public"."moderation_cases"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "role_menu_options" ADD CONSTRAINT "role_menu_options_menu_id_role_menus_id_fk" FOREIGN KEY ("menu_id") REFERENCES "public"."role_menus"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "role_menus" ADD CONSTRAINT "role_menus_guild_id_guilds_id_fk" FOREIGN KEY ("guild_id") REFERENCES "public"."guilds"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "staff_notes" ADD CONSTRAINT "staff_notes_guild_id_guilds_id_fk" FOREIGN KEY ("guild_id") REFERENCES "public"."guilds"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "suggestion_votes" ADD CONSTRAINT "suggestion_votes_suggestion_id_suggestions_id_fk" FOREIGN KEY ("suggestion_id") REFERENCES "public"."suggestions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "suggestions" ADD CONSTRAINT "suggestions_guild_id_guilds_id_fk" FOREIGN KEY ("guild_id") REFERENCES "public"."guilds"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ticket_categories" ADD CONSTRAINT "ticket_categories_guild_id_guilds_id_fk" FOREIGN KEY ("guild_id") REFERENCES "public"."guilds"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ticket_events" ADD CONSTRAINT "ticket_events_ticket_id_tickets_id_fk" FOREIGN KEY ("ticket_id") REFERENCES "public"."tickets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ticket_notes" ADD CONSTRAINT "ticket_notes_ticket_id_tickets_id_fk" FOREIGN KEY ("ticket_id") REFERENCES "public"."tickets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ticket_panels" ADD CONSTRAINT "ticket_panels_guild_id_guilds_id_fk" FOREIGN KEY ("guild_id") REFERENCES "public"."guilds"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ticket_participants" ADD CONSTRAINT "ticket_participants_ticket_id_tickets_id_fk" FOREIGN KEY ("ticket_id") REFERENCES "public"."tickets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ticket_transcripts" ADD CONSTRAINT "ticket_transcripts_ticket_id_tickets_id_fk" FOREIGN KEY ("ticket_id") REFERENCES "public"."tickets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_guild_id_guilds_id_fk" FOREIGN KEY ("guild_id") REFERENCES "public"."guilds"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_category_id_ticket_categories_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."ticket_categories"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "audit_events_guild_id_created_at_index" ON "audit_events" USING btree ("guild_id","created_at");--> statement-breakpoint
CREATE INDEX "audit_events_guild_id_action_index" ON "audit_events" USING btree ("guild_id","action");--> statement-breakpoint
CREATE UNIQUE INDEX "automod_rules_guild_id_name_index" ON "automod_rules" USING btree ("guild_id","name");--> statement-breakpoint
CREATE INDEX "automod_rules_guild_id_enabled_index" ON "automod_rules" USING btree ("guild_id","enabled");--> statement-breakpoint
CREATE INDEX "guild_sequences_guild_id_index" ON "guild_sequences" USING btree ("guild_id");--> statement-breakpoint
CREATE INDEX "moderation_case_notes_case_id_index" ON "moderation_case_notes" USING btree ("case_id");--> statement-breakpoint
CREATE UNIQUE INDEX "moderation_cases_guild_id_case_number_index" ON "moderation_cases" USING btree ("guild_id","case_number");--> statement-breakpoint
CREATE INDEX "moderation_cases_guild_id_target_user_id_created_at_index" ON "moderation_cases" USING btree ("guild_id","target_user_id","created_at");--> statement-breakpoint
CREATE INDEX "moderation_cases_guild_id_moderator_user_id_index" ON "moderation_cases" USING btree ("guild_id","moderator_user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "permission_grants_guild_id_role_id_permission_index" ON "permission_grants" USING btree ("guild_id","role_id","permission");--> statement-breakpoint
CREATE INDEX "report_events_report_id_created_at_index" ON "report_events" USING btree ("report_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "reports_guild_id_report_number_index" ON "reports" USING btree ("guild_id","report_number");--> statement-breakpoint
CREATE INDEX "reports_guild_id_status_index" ON "reports" USING btree ("guild_id","status");--> statement-breakpoint
CREATE INDEX "reports_guild_id_reporter_id_index" ON "reports" USING btree ("guild_id","reporter_id");--> statement-breakpoint
CREATE UNIQUE INDEX "role_menu_options_menu_id_role_id_index" ON "role_menu_options" USING btree ("menu_id","role_id");--> statement-breakpoint
CREATE INDEX "role_menu_options_menu_id_position_index" ON "role_menu_options" USING btree ("menu_id","position");--> statement-breakpoint
CREATE UNIQUE INDEX "role_menus_guild_id_name_index" ON "role_menus" USING btree ("guild_id","name");--> statement-breakpoint
CREATE INDEX "staff_notes_guild_id_user_id_index" ON "staff_notes" USING btree ("guild_id","user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "suggestions_guild_id_suggestion_number_index" ON "suggestions" USING btree ("guild_id","suggestion_number");--> statement-breakpoint
CREATE INDEX "suggestions_guild_id_status_index" ON "suggestions" USING btree ("guild_id","status");--> statement-breakpoint
CREATE INDEX "suggestions_message_id_index" ON "suggestions" USING btree ("message_id");--> statement-breakpoint
CREATE UNIQUE INDEX "ticket_categories_guild_id_name_index" ON "ticket_categories" USING btree ("guild_id","name");--> statement-breakpoint
CREATE INDEX "ticket_events_ticket_id_created_at_index" ON "ticket_events" USING btree ("ticket_id","created_at");--> statement-breakpoint
CREATE INDEX "ticket_notes_ticket_id_index" ON "ticket_notes" USING btree ("ticket_id");--> statement-breakpoint
CREATE INDEX "ticket_panels_guild_id_index" ON "ticket_panels" USING btree ("guild_id");--> statement-breakpoint
CREATE INDEX "ticket_transcripts_ticket_id_index" ON "ticket_transcripts" USING btree ("ticket_id");--> statement-breakpoint
CREATE UNIQUE INDEX "tickets_guild_id_ticket_number_index" ON "tickets" USING btree ("guild_id","ticket_number");--> statement-breakpoint
CREATE UNIQUE INDEX "tickets_one_open_per_opener_category" ON "tickets" USING btree ("guild_id","opener_user_id","category_id") WHERE "tickets"."status" = 'open';--> statement-breakpoint
CREATE UNIQUE INDEX "tickets_channel_id_index" ON "tickets" USING btree ("channel_id");--> statement-breakpoint
CREATE INDEX "tickets_guild_id_status_last_activity_at_index" ON "tickets" USING btree ("guild_id","status","last_activity_at");