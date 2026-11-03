'use strict';

const UNFOCUSED_IDLE_MS = 2 * 60 * 1000;
const INPUT_IDLE_MS = 3 * 60 * 1000;

function shouldRestartForUpdate({
  updateAvailable,
  pendingSaves,
  busy,
  windowUnfocused,
  unfocusedForMs = 0,
  inactiveForMs = 0,
  manual = false,
} = {}) {
  if (!updateAvailable || pendingSaves !== false || busy !== false) return false;
  return manual || (windowUnfocused && unfocusedForMs >= UNFOCUSED_IDLE_MS) || inactiveForMs >= INPUT_IDLE_MS;
}

module.exports = { INPUT_IDLE_MS, UNFOCUSED_IDLE_MS, shouldRestartForUpdate };
