CREATE TABLE `web_link_challenges` (
	`code_hash` text PRIMARY KEY NOT NULL,
	`browser_hash` text NOT NULL,
	`address_hash` text,
	`uuid` text,
	`player` text,
	`expires_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `web_link_browser` ON `web_link_challenges` (`browser_hash`);--> statement-breakpoint
CREATE INDEX `web_link_address` ON `web_link_challenges` (`address_hash`);--> statement-breakpoint
CREATE INDEX `web_link_expiry` ON `web_link_challenges` (`expires_at`);--> statement-breakpoint
CREATE TABLE `web_sessions` (
	`hash` text PRIMARY KEY NOT NULL,
	`uuid` text NOT NULL,
	`player` text NOT NULL,
	`expires_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `web_session_expiry` ON `web_sessions` (`expires_at`);