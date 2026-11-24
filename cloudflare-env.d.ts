declare namespace Cloudflare {
  interface Env {
    DB?: D1Database;
    MICET_MODE?: string;
    MICET_BRIDGE_SECRET?: string;
    MICET_PUBLIC_LAUNCH?: string;
    MICET_LOCAL_TEST?: string;
    MICET_STATUS_URL?: string;
  }
}
