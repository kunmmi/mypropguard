// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

interface IGuardManager {
    function setGuard(address guard) external;
}

/// @title SafeGuardSetup
/// @notice A tiny helper that lets MyPropGuard deploy a trader's Safe AND attach the risk Guard
/// in one atomic transaction, with no signature from the trader - the standard Safe pattern for
/// "configure extra things during setup" (Safe's own `setup()` takes a `to`/`data` pair that it
/// delegatecalls as part of the same creation transaction, before the Safe is considered
/// initialized).
///
/// Why this is needed: `GuardManager.setGuard` is `authorized` (self-call only - `msg.sender`
/// must equal the Safe itself), which normally means attaching a Guard requires a real
/// `execTransaction` signed by an owner. But at the moment of creation, the trader (who will be
/// the Safe's sole owner) hasn't signed anything yet - MyPropGuard's backend is the one paying
/// gas and calling `SafeProxyFactory.createProxyWithNonce`. Passing this contract's address as
/// `to` and `abi.encodeWithSelector(SafeGuardSetup.setupGuard.selector, guardAddress)` as `data`
/// in the Safe's `setup()` call makes the Safe `delegatecall` into `setupGuard` - which runs in
/// the Safe's own execution context, so the subsequent call to `setGuard` has `msg.sender ==
/// address(this)` (the Safe itself), satisfying GuardManager's `authorized` check. No separate
/// signature or second transaction needed; the trader ends up as the sole owner of a Safe that
/// already has the Guard enforcing limits from block zero.
///
/// This contract holds no state and is never itself the target of a direct call in normal
/// operation - it only ever runs via delegatecall from inside a Safe's own `setup()`.
contract SafeGuardSetup {
    function setupGuard(address guard) external {
        IGuardManager(address(this)).setGuard(guard);
    }
}
