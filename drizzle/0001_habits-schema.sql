CREATE TABLE "app_settings" (
	"id" smallint PRIMARY KEY DEFAULT 1 NOT NULL,
	"vapid_public_key" text NOT NULL,
	"vapid_private_key" text NOT NULL,
	"vapid_key_id" char(8) NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "app_settings_single_row" CHECK ("app_settings"."id" = 1)
);
--> statement-breakpoint
CREATE TABLE "check_in" (
	"habit_id" uuid NOT NULL,
	"local_date" date NOT NULL,
	"owner_id" text NOT NULL,
	"value" numeric(10, 2) DEFAULT '1' NOT NULL,
	"done" boolean DEFAULT true NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "check_in_habit_id_local_date_pk" PRIMARY KEY("habit_id","local_date"),
	CONSTRAINT "check_in_value_chk" CHECK ("check_in"."value" > 0 and "check_in"."value" <= 100000)
);
--> statement-breakpoint
CREATE TABLE "coach_summary" (
	"user_id" text NOT NULL,
	"iso_week" char(8) NOT NULL,
	"data" jsonb NOT NULL,
	"stats" jsonb NOT NULL,
	"mode" text NOT NULL,
	"input_hash" char(64) NOT NULL,
	"regenerations" smallint DEFAULT 0 NOT NULL,
	"generated_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "coach_summary_user_id_iso_week_pk" PRIMARY KEY("user_id","iso_week"),
	CONSTRAINT "coach_summary_week_chk" CHECK ("coach_summary"."iso_week" ~ '^[0-9]{4}-W(0[1-9]|[1-4][0-9]|5[0-3])$'),
	CONSTRAINT "coach_summary_mode_chk" CHECK ("coach_summary"."mode" in ('live', 'demo', 'skipped', 'fallback')),
	CONSTRAINT "coach_summary_regen_chk" CHECK ("coach_summary"."regenerations" between 0 and 2)
);
--> statement-breakpoint
CREATE TABLE "daily_usage" (
	"day" date NOT NULL,
	"kind" text NOT NULL,
	"count" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "daily_usage_day_kind_pk" PRIMARY KEY("day","kind"),
	CONSTRAINT "daily_usage_kind_chk" CHECK ("daily_usage"."kind" in ('push', 'coach', 'demo_load')),
	CONSTRAINT "daily_usage_count_chk" CHECK ("daily_usage"."count" >= 0)
);
--> statement-breakpoint
CREATE TABLE "habit" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" text NOT NULL,
	"name" text NOT NULL,
	"kind" text DEFAULT 'check' NOT NULL,
	"unit" text,
	"daily_target" numeric(10, 2),
	"weekly_goal" smallint DEFAULT 7 NOT NULL,
	"position" smallint DEFAULT 0 NOT NULL,
	"archived_at" timestamp (3) with time zone,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "habit_id_owner_uq" UNIQUE("id","owner_id"),
	CONSTRAINT "habit_name_len" CHECK (char_length("habit"."name") between 1 and 60),
	CONSTRAINT "habit_kind_chk" CHECK ("habit"."kind" in ('check', 'numeric')),
	CONSTRAINT "habit_numeric_chk" CHECK (("habit"."kind" = 'numeric' and "habit"."unit" is not null and char_length("habit"."unit") between 1 and 16 and "habit"."daily_target" is not null and "habit"."daily_target" > 0 and "habit"."daily_target" <= 100000) or ("habit"."kind" = 'check' and "habit"."unit" is null and "habit"."daily_target" is null)),
	CONSTRAINT "habit_weekly_goal_chk" CHECK ("habit"."weekly_goal" between 1 and 7),
	CONSTRAINT "habit_position_chk" CHECK ("habit"."position" >= 0)
);
--> statement-breakpoint
CREATE TABLE "push_subscription" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"endpoint" text NOT NULL,
	"p256dh" text NOT NULL,
	"auth" text NOT NULL,
	"device_label" text DEFAULT 'Browser' NOT NULL,
	"vapid_key_id" char(8) NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"last_success_at" timestamp (3) with time zone,
	"failure_count" integer DEFAULT 0 NOT NULL,
	"last_status" integer,
	CONSTRAINT "push_subscription_endpoint_unique" UNIQUE("endpoint"),
	CONSTRAINT "push_subscription_endpoint_len" CHECK (char_length("push_subscription"."endpoint") between 1 and 1024),
	CONSTRAINT "push_subscription_p256dh_chk" CHECK ("push_subscription"."p256dh" ~ '^[A-Za-z0-9_-]{87}$'),
	CONSTRAINT "push_subscription_auth_chk" CHECK ("push_subscription"."auth" ~ '^[A-Za-z0-9_-]{22}$'),
	CONSTRAINT "push_subscription_label_len" CHECK (char_length("push_subscription"."device_label") between 1 and 60),
	CONSTRAINT "push_subscription_failures_chk" CHECK ("push_subscription"."failure_count" >= 0)
);
--> statement-breakpoint
CREATE TABLE "rate_event" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"kind" text NOT NULL,
	"at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "rate_event_kind_chk" CHECK ("rate_event"."kind" in ('checkin', 'habit_write', 'subscribe', 'test_push', 'coach', 'tz_change', 'demo_load'))
);
--> statement-breakpoint
CREATE TABLE "user_settings" (
	"user_id" text PRIMARY KEY NOT NULL,
	"time_zone" text DEFAULT 'UTC' NOT NULL,
	"reminder_time" time,
	"last_reminder_on" date,
	"last_reminder_at" timestamp (3) with time zone,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_settings_tz_len" CHECK (char_length("user_settings"."time_zone") between 1 and 64),
	CONSTRAINT "user_settings_reminder_chk" CHECK ("user_settings"."reminder_time" is null or ("user_settings"."reminder_time" between time '05:00' and time '21:00' and extract(minute from "user_settings"."reminder_time")::int % 15 = 0 and extract(second from "user_settings"."reminder_time") = 0))
);
--> statement-breakpoint
DROP TABLE "item" CASCADE;--> statement-breakpoint
ALTER TABLE "check_in" ADD CONSTRAINT "check_in_owner_id_user_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "check_in" ADD CONSTRAINT "check_in_habit_owner_fk" FOREIGN KEY ("habit_id","owner_id") REFERENCES "public"."habit"("id","owner_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "coach_summary" ADD CONSTRAINT "coach_summary_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "habit" ADD CONSTRAINT "habit_owner_id_user_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "push_subscription" ADD CONSTRAINT "push_subscription_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rate_event" ADD CONSTRAINT "rate_event_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_settings" ADD CONSTRAINT "user_settings_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "habit_owner_archived_position_idx" ON "habit" USING btree ("owner_id","archived_at","position");--> statement-breakpoint
CREATE INDEX "push_subscription_user_idx" ON "push_subscription" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "rate_event_user_kind_at_idx" ON "rate_event" USING btree ("user_id","kind","at");--> statement-breakpoint
CREATE INDEX "user_settings_reminder_time_idx" ON "user_settings" USING btree ("reminder_time") WHERE "user_settings"."reminder_time" is not null;