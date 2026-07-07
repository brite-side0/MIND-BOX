CREATE TYPE "public"."resource_type" AS ENUM('file', 'link');--> statement-breakpoint
CREATE TYPE "public"."verification_status" AS ENUM('pending', 'verified', 'rejected', 'skipped');--> statement-breakpoint
CREATE TABLE "publishers" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"email" text NOT NULL,
	"wallet_address" text NOT NULL,
	"api_key_hash" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "publishers_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "resources" (
	"id" text PRIMARY KEY NOT NULL,
	"publisher_id" text NOT NULL,
	"title" text NOT NULL,
	"description" text,
	"price" text NOT NULL,
	"wallet_address" text NOT NULL,
	"resource_type" "resource_type" NOT NULL,
	"storage_path" text,
	"external_url" text,
	"mime_type" text,
	"verification_status" "verification_status" DEFAULT 'pending' NOT NULL,
	"verification_id" text,
	"listed" boolean DEFAULT false NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "verifications" (
	"id" text PRIMARY KEY NOT NULL,
	"resource_id" text NOT NULL,
	"is_original" boolean NOT NULL,
	"confidence" real NOT NULL,
	"flags" text,
	"checked_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "resources" ADD CONSTRAINT "resources_publisher_id_publishers_id_fk" FOREIGN KEY ("publisher_id") REFERENCES "public"."publishers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "verifications" ADD CONSTRAINT "verifications_resource_id_resources_id_fk" FOREIGN KEY ("resource_id") REFERENCES "public"."resources"("id") ON DELETE no action ON UPDATE no action;