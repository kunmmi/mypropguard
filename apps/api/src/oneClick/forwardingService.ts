import type { WalletConnectService } from "./walletConnectService.js";

export type LinkService = Pick<WalletConnectService, "pair" | "disconnect" | "disconnectAccount">;

/**
 * A link service that waits until the real one is running, then hands over EVERY argument it was given.
 * (Listing the arguments by hand once dropped the "this is a trading wallet link" flag, which turned every wallet link
 * into a Safe link. Passing them all through, with their types, makes that kind of slip a compile error.)
 */
export function forwardingService(running: () => Promise<LinkService>): LinkService {
  return {
    pair: async (...args: Parameters<LinkService["pair"]>) => (await running()).pair(...args),
    disconnect: async (...args: Parameters<LinkService["disconnect"]>) => (await running()).disconnect(...args),
    disconnectAccount: async (...args: Parameters<LinkService["disconnectAccount"]>) => (await running()).disconnectAccount(...args),
  };
}
