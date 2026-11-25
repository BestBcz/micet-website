CREATE TABLE `shop_events` (
	`id` text PRIMARY KEY NOT NULL,
	`order_id` text NOT NULL,
	`kind` text NOT NULL,
	`amount` integer NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `shop_orders` (
	`id` text PRIMARY KEY NOT NULL,
	`uuid` text NOT NULL,
	`player` text NOT NULL,
	`sku` text NOT NULL,
	`amount` integer NOT NULL,
	`channel` text NOT NULL,
	`status` text NOT NULL,
	`pay_url` text,
	`qr_url` text,
	`expires_at` integer,
	`next_check` integer NOT NULL,
	`created_at` integer NOT NULL,
	`detail` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `shop_open_product` ON `shop_orders` (`uuid`,`sku`) WHERE status IN ('pending','paid','delivered','review');--> statement-breakpoint
CREATE INDEX `shop_due` ON `shop_orders` (`next_check`);