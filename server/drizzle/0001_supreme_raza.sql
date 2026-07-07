CREATE TABLE "payments" (
	"id" text PRIMARY KEY NOT NULL,
	"resource_id" text NOT NULL,
	"payer_address" text NOT NULL,
	"recipient_address" text NOT NULL,
	"amount" text NOT NULL,
	"paid_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_resource_id_resources_id_fk" FOREIGN KEY ("resource_id") REFERENCES "public"."resources"("id") ON DELETE no action ON UPDATE no action;