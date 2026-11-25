CREATE TABLE `shop_lookup_contacts` (
	`contact_hash` text PRIMARY KEY NOT NULL,
	`salt` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `shop_lookup_limits` (
	`bucket` text PRIMARY KEY NOT NULL,
	`attempts` integer NOT NULL,
	`expires_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `shop_limit_expiry` ON `shop_lookup_limits` (`expires_at`);--> statement-breakpoint
CREATE TABLE `shop_lookup_sessions` (
	`token_hash` text PRIMARY KEY NOT NULL,
	`lookup_key` text NOT NULL,
	`expires_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `shop_lookup_expiry` ON `shop_lookup_sessions` (`expires_at`);--> statement-breakpoint
ALTER TABLE `shop_orders` ADD `lookup_key` text;--> statement-breakpoint
CREATE INDEX `shop_lookup_orders` ON `shop_orders` (`lookup_key`,`created_at`);