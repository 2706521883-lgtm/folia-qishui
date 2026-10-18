/**
 * A recommendation request that never settles would otherwise hold the home-feed lock forever.
 * Twelve seconds is long enough for a slow Qishui/QQ batch and short enough that the button comes
 * back while the user is still looking at it.
 */
export const PERSONAL_FM_TIMEOUT_MS = 12_000;
