CREATE TABLE "coach_claim" (
	"user_id" text NOT NULL,
	"iso_week" char(8) NOT NULL,
	"token" uuid NOT NULL,
	"claimed_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "coach_claim_user_id_iso_week_pk" PRIMARY KEY("user_id","iso_week")
);
--> statement-breakpoint
ALTER TABLE "coach_summary" ADD COLUMN "model_calls" smallint DEFAULT 0 NOT NULL;--> statement-breakpoint
UPDATE "coach_summary" SET "model_calls" = CASE WHEN "mode" = 'skipped' THEN 0 ELSE "regenerations" + 1 END;--> statement-breakpoint
ALTER TABLE "coach_claim" ADD CONSTRAINT "coach_claim_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "coach_summary" ADD CONSTRAINT "coach_summary_calls_chk" CHECK ("coach_summary"."model_calls" between 0 and 3);