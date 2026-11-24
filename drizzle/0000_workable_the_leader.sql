CREATE TABLE `bridge_state` (
	`id` text PRIMARY KEY NOT NULL,
	`seen_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `link_codes` (
	`hash` text PRIMARY KEY NOT NULL,
	`owner` text NOT NULL,
	`mode` text NOT NULL,
	`expires_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `code_owner` ON `link_codes` (`owner`,`mode`);--> statement-breakpoint
CREATE TABLE `bridge_jobs` (
	`id` text PRIMARY KEY NOT NULL,
	`owner` text NOT NULL,
	`kind` text NOT NULL,
	`mode` text NOT NULL,
	`payload` text NOT NULL,
	`status` text NOT NULL,
	`created_at` integer NOT NULL,
	`expires_at` integer,
	`lease_until` integer,
	`lease` text,
	`result` text
);
--> statement-breakpoint
CREATE INDEX `job_queue` ON `bridge_jobs` (`mode`,`status`,`created_at`);--> statement-breakpoint
CREATE INDEX `job_owner` ON `bridge_jobs` (`owner`,`created_at`);--> statement-breakpoint
CREATE TABLE `links` (
	`owner` text NOT NULL,
	`mode` text NOT NULL,
	`uuid` text NOT NULL,
	`player` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `link_owner` ON `links` (`owner`,`mode`);--> statement-breakpoint
CREATE UNIQUE INDEX `link_uuid` ON `links` (`uuid`,`mode`);--> statement-breakpoint
CREATE TABLE `micet_orders` (
	`id` text PRIMARY KEY NOT NULL,
	`owner` text NOT NULL,
	`uuid` text NOT NULL,
	`player` text NOT NULL,
	`sku` text NOT NULL,
	`mode` text NOT NULL,
	`status` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`detail` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `order_product` ON `micet_orders` (`owner`,`uuid`,`mode`,`sku`);