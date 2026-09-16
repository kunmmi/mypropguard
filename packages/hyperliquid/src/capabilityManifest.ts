/**
 * Static Venue Capability Manifest for Hyperliquid, populated from what the
 * MyPropGuard research (Sept 2026 updates) has already verified against
 * Hyperliquid's own docs/SDK. This is DATA ONLY — no live WebSocket/Info API
 * client, no signing. Live integration is Phase 2/3.
 *
 * Each field distinguishes "credential hardening" from "owner bypass
 * resistance" per the doc's explicit warning that these are different
 * guarantees and must never share the same Locked-Mode label.
 */
export interface VenueCapabilityManifest {
  venue: string;
  accountMode: string;
  agentWallet: {
    /** Agent/API wallets cannot perform master-only user-signed withdrawals. */
    canWithdraw: false;
    /** Agents CAN place/cancel/modify orders and change leverage/margin (L1 actions) —
     * "cannot withdraw" must never be treated as "order-only". */
    canPlaceOrders: true;
    canChangeLeverage: true;
    /** MyPropGuard's own signer firewall must default-deny this even though the venue allows it. */
    shouldBeDefaultDeniedByMpgSigner: readonly string[];
  };
  ownerBypassResistance: {
    /** The account owner can always trade directly through the native venue interface. */
    ownerCanBypassProtectedMode: true;
    /** Locked Mode (native multisig + delegated agent) remains UNPROVEN per the doc's
     * own testnet build gate — do not market non-bypassability until reproduced. */
    lockedModeStatus: "UNPROVEN";
  };
  limits: {
    /** Hyperliquid gates native sub-account creation behind $100k+ trading volume. */
    subAccountMinVolumeUsd: 100_000;
    /** Default outstanding open-order allowance per account. */
    defaultMaxOpenOrders: 1_000;
    /** MPG must keep its own ceiling below this so a protective reduce-only order can
     * always be placed even near the venue limit (Emergency-Action Headroom Guard). */
    mpgOpenOrderHeadroomCeiling: 900;
    /** scheduleCancel dead-man-switch triggers allowed per UTC day. */
    scheduleCancelTriggersPerUtcDay: 10;
    /** WebSocket connections and unique user subscriptions allowed per IP on the public API. */
    maxWebsocketConnectionsPerIp: 10;
    maxUniqueUserSubscriptionsPerIp: 10;
  };
  supportedOrderActions: readonly string[];
}

export const HYPERLIQUID_STANDARD_MODE_MANIFEST: VenueCapabilityManifest = {
  venue: "hyperliquid",
  accountMode: "STANDARD",
  agentWallet: {
    canWithdraw: false,
    canPlaceOrders: true,
    canChangeLeverage: true,
    shouldBeDefaultDeniedByMpgSigner: [
      "updateLeverage",
      "updateIsolatedMargin",
      "vaultTransfer",
      "subAccountTransfer",
      "agentSetAbstraction",
      "userSetAbstraction",
      "approveAgent",
      "sendAsset",
      "withdraw",
    ],
  },
  ownerBypassResistance: {
    ownerCanBypassProtectedMode: true,
    lockedModeStatus: "UNPROVEN",
  },
  limits: {
    subAccountMinVolumeUsd: 100_000,
    defaultMaxOpenOrders: 1_000,
    mpgOpenOrderHeadroomCeiling: 900,
    scheduleCancelTriggersPerUtcDay: 10,
    maxWebsocketConnectionsPerIp: 10,
    maxUniqueUserSubscriptionsPerIp: 10,
  },
  supportedOrderActions: ["order", "cancel", "modify", "reduceOnly", "normalTpsl"],
};
