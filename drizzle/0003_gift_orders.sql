ALTER TABLE `shop_orders` ADD `buyer` text;--> statement-breakpoint
UPDATE shop_orders SET buyer='account:' || uuid;--> statement-breakpoint
CREATE INDEX `shop_buyer_orders` ON `shop_orders` (`buyer`,`created_at`);
