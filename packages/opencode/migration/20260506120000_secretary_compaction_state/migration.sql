CREATE TABLE `secretary_state` (
	`session_id` text PRIMARY KEY NOT NULL,
	`version` integer NOT NULL,
	`status` text NOT NULL,
	`summary` text,
	`summary_up_to` text,
	`previous_diff_start` text,
	`previous_diff_end` text,
	`new_diff_start` text,
	`running_snapshot_start` text,
	`running_snapshot_end` text,
	`retry_count` integer NOT NULL,
	`last_error` text,
	`last_success_at` integer,
	`payload_degraded` integer NOT NULL,
	`classic` integer NOT NULL,
	`time_created` integer NOT NULL,
	`time_updated` integer NOT NULL,
	CONSTRAINT `fk_secretary_state_session_id_session_id_fk` FOREIGN KEY (`session_id`) REFERENCES `session`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE INDEX `secretary_state_status_idx` ON `secretary_state` (`status`);
