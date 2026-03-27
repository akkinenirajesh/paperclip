CREATE TABLE IF NOT EXISTS "telegram_callback_map" (
	"short_id" text PRIMARY KEY NOT NULL,
	"company_id" text NOT NULL,
	"approval_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "telegram_message_map" (
	"id" serial PRIMARY KEY NOT NULL,
	"telegram_chat_id" text NOT NULL,
	"telegram_message_id" text NOT NULL,
	"direction" text NOT NULL,
	"paperclip_issue_id" text,
	"paperclip_comment_id" text,
	"paperclip_company_id" text,
	"agent_task_session_id" uuid,
	"raw_text" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "telegram_poll_cursor" (
	"key" text PRIMARY KEY NOT NULL,
	"value" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "telegram_user_map" (
	"telegram_chat_id" text PRIMARY KEY NOT NULL,
	"telegram_username" text,
	"telegram_display_name" text,
	"paperclip_user_id" text,
	"paperclip_company_id" text,
	"role" text DEFAULT 'member' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
-- Add agent_task_session_id column if migrating from old bridge tables
ALTER TABLE "telegram_message_map" ADD COLUMN IF NOT EXISTS "agent_task_session_id" uuid;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_telegram_msg_chat" ON "telegram_message_map" USING btree ("telegram_chat_id","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_telegram_msg_issue" ON "telegram_message_map" USING btree ("paperclip_issue_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "telegram_user_map_company_idx" ON "telegram_user_map" USING btree ("paperclip_company_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "telegram_user_map_paperclip_user_idx" ON "telegram_user_map" USING btree ("paperclip_user_id");
