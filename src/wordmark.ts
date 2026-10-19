import type { Ui } from "@bunizao/cli-kit";

export const HKU_TAGLINE = "Moodle, mail and library spaces from one command line.";
export const MOODLE_TAGLINE = HKU_TAGLINE;

// figlet "Small"; kept as lines so the backslashes survive as typed.
export const HKU_WORDMARK = [
  " _   _ _  __ _   _",
  "| | | | |/ /| | | |",
  "| |_| | ' < | |_| |",
  " \\__, |_|\\_\\\\__,_|",
  " |___/",
].join("\n");

export const MOODLE_WORDMARK = HKU_WORDMARK;

let shown = false;

/** The wordmark opens the first guided step of a run and no other, however many steps follow. */
export function showWordmark(ui: Ui): void {
  if (shown) return;
  shown = true;
  ui.banner(HKU_WORDMARK, HKU_TAGLINE);
}
