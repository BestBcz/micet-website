declare namespace Cloudflare {
  interface Env {
    DB?: D1Database;
    MICET_MODE?: string;
    MICET_BRIDGE_SECRET?: string;
    /** Retired. A value of "1" blocks requests until the deployment is migrated. */
    MICET_PUBLIC_LAUNCH?: string;
    MICET_SELF_HOSTED?: string;
    MICET_SITE_ORIGIN?: string;
    MICET_LOCAL_TEST?: string;
    MICET_STATUS_URL?: string;
    XD_BASE_URL?: string;
    XD_APP_ID?: string;
    XD_KEY_ID?: string;
    XD_PRIVATE_KEY?: string;
    XD_PLATFORM_KEYS?: string;
    XD_CASHIER_ORIGIN?: string;
    XD_CHANNELS?: string;
    MICET_PRICE_VAPE_FEN?: string;
    MICET_PRICE_HEART_FEN?: string;
    MICET_RECONCILE_TOKEN?: string;
  }
}
