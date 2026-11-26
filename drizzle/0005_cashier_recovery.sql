ALTER TABLE `shop_orders` ADD `cashier_version` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `shop_orders` ADD `attempt_request` text;--> statement-breakpoint
ALTER TABLE `shop_orders` ADD `attempt_until` integer DEFAULT 0 NOT NULL;