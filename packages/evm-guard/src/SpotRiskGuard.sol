// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {BaseGuard} from "safe-smart-account/contracts/examples/guards/BaseGuard.sol";
import {Enum} from "safe-smart-account/contracts/interfaces/Enum.sol";

interface ISafeView {
    function nonce() external view returns (uint256);
    function getThreshold() external view returns (uint256);
    function domainSeparator() external view returns (bytes32);
}

/// @title SpotRiskGuard
/// @notice A Safe Guard that enforces MyPropGuard's risk rules on a trader's Safe by measuring what a
/// transaction DOES to the Safe's balances, instead of decoding which exchange or router it calls.
/// That is what lets the Safe be connected to any trading site or terminal: PancakeSwap's own
/// site, Axiom, an aggregator or a bot all work without being registered, because the rules
/// look at the outcome, not the route.
///
/// ## How a trade is judged
/// Before a transaction runs, the Guard snapshots the Safe's balance of the native coin and of
/// every "base asset" (wrapped native coin and the stablecoins). After it runs it compares. If any
/// base asset went DOWN, the transaction was a BUY (money was spent) and these apply, reverting
/// the whole Safe transaction on a violation:
///  - the account must not be frozen for today (max daily loss),
///  - a max-buys-per-day limit must be configured, and not exceeded,
///  - the amount spent of each base asset must not exceed that asset's per-buy limit.
/// If no base asset went down the transaction is a SELL or a no-spend action (for example
/// swapping a token back into BNB, or approving a router). Those are never limited, never counted
/// and never blocked by a freeze, so a trader can always get out of a position.
///
/// ## What is blocked outright (block-by-default for the dangerous few)
/// - Delegatecall to anything except Safe's official MultiSendCallOnly. Batches from that contract
///   are decoded and every inner call is checked by the same rules.
/// - Approving a base asset (or a Permit2 allowance) to a spender that MyPropGuard has not
///   allowlisted. An allowance lets a contract pull the Safe's money without a Safe transaction,
///   which would sidestep every limit. Revoking (amount 0) is always allowed.
/// - Safe management calls that could disable the Guard or open a bypass: enableModule,
///   setFallbackHandler and anything not listed below. Allowed: owner changes, disableModule, and
///   setGuard only after the removal cooldown and never while the account is frozen.
/// - Module transactions entirely.
///
/// ## Always allowed (never counted as a buy)
/// Plain native sends and ERC-20 transfers (withdrawals - the Safe stays non-custodial), wrapping and
/// unwrapping the native coin, and revoking approvals.
///
/// ## Session keys (trading with no prompt per trade)
/// A trader's Safe may have session keys: Safe owners that the Guard knows about (addSessionKey,
/// called by a real owner). A key like that can sign trades without a wallet popup, so it must be
/// harmless if stolen. For every transaction the Guard reads who signed it (the same way the Safe does).
/// If any required signer is a session key, the transaction may ONLY trade: it can never send BNB or
/// tokens out, call the Safe itself (owner, threshold, Guard or module changes), call this Guard,
/// transfer a non-base token or NFT, or approve anything to a spender that is not allowlisted. Buys are
/// still held to the per-buy cap, the daily buy count and the freeze. The trader's own key keeps every
/// normal power, so withdrawals and key management still take the trader's own signature. Accounts
/// with no session keys skip the check entirely and pay no extra gas.
///
/// ## Known limits (documented, not hidden)
/// - Amount limits are per base asset in that asset's units, not dollars.
/// - Rotating one non-base token into another inside a single transaction, with no base asset
///   spent, is not detected as a buy. For the same reason a stolen session key could still send a
///   NON-BASE token out through a swap that pays a stranger; base assets (BNB, WBNB, stablecoins)
///   stay bounded by the buy limits.
/// - The max-daily-loss freeze is still attested by MyPropGuard's backend (admin key): a daily loss
///   cannot be derived from one transaction. The admin can only freeze for the current UTC day and
///   can never unfreeze, extend a freeze, or move funds.
/// - The Safe must have no fallback handler (MyPropGuard deploys it that way) so that off-chain
///   signatures (EIP-1271, Permit2 permits) cannot grant allowances without a Safe transaction.
///
/// One Guard instance is shared across many Safes - `msg.sender` inside the hooks is the Safe.
contract SpotRiskGuard is BaseGuard {
    address public immutable admin;
    /// @notice The chain's wrapped native coin (WBNB / WETH).
    address public immutable wrappedNative;
    /// @notice Safe's official MultiSendCallOnly - the only contract a Safe may delegatecall.
    address public immutable multiSendCallOnly;
    /// @notice Uniswap's Permit2 (same address on every chain), or address(0) if not used.
    address public immutable permit2;

    uint256 public constant REMOVAL_DELAY = 24 hours;
    uint256 public constant MAX_TRACKED_ASSETS = 12;

    /// @dev Index 0 is the native coin (address(0)); the rest are ERC-20 base assets.
    address[] private _tracked;
    mapping(address => bool) public isTrackedToken;

    /// @notice Spenders an account may approve base assets to (routers, Permit2).
    mapping(address => bool) public allowedSpender;

    /// @notice Max amount of `asset` spent per BUY. 0 means no per-asset cap.
    mapping(address => mapping(address => uint256)) public maxAmountPerTrade;
    /// @notice Max BUYS per UTC day (the name predates "buys"; sells never count).
    mapping(address => uint256) public maxTradesPerDay;

    struct AccountState {
        uint256 lastTradeDay;
        uint256 tradesToday;
    }

    mapping(address => AccountState) public tradeState;
    mapping(address => uint256) public frozenThroughDay;
    mapping(address => uint256) public removalRequestedAt;

    /// @notice Running total, per account and asset (address(0) = native coin), of what the account has
    /// sent out through plain native sends and ERC-20 `transfer` calls. MyPropGuard's backend reads this
    /// to tell an owner's withdrawal apart from a trading loss when it computes daily profit and loss.
    /// Free to read from any RPC at any recent block, unlike event logs, which free BNB Chain nodes
    /// refuse to serve. Bookkeeping only: it never blocks anything.
    mapping(address => mapping(address => uint256)) public withdrawnTotal;

    /// @notice Keys an account has marked as session keys: owners of the Safe that sign trades on the
    /// trader's behalf without a prompt. A transaction signed by one of them is judged by the strict
    /// "trade only" rules below; one signed by any other owner keeps the normal rules.
    mapping(address => mapping(address => bool)) public isSessionKey;
    /// @notice How many session keys an account has. An account with none skips the signer check
    /// altogether, so ordinary accounts pay no extra gas for this feature.
    mapping(address => uint256) public sessionKeyCount;

    mapping(address => bool) private _snapshotActive;
    mapping(address => mapping(uint256 => uint256)) private _preBalance;

    /// @dev Flags passed down the call policy instead of stored, so a trade pays no extra storage gas.
    uint8 private constant IN_BATCH = 1;
    uint8 private constant SESSION = 2;

    /// @dev keccak256("SafeTx(address to,uint256 value,bytes data,uint8 operation,uint256 safeTxGas,uint256 baseGas,uint256 gasPrice,address gasToken,address refundReceiver,uint256 nonce)")
    bytes32 private constant SAFE_TX_TYPEHASH = 0xbb8310d486368db6bd6f849402fdd73ad53d316b5a4b2644ad6efe0f941286d8;

    bytes4 private constant ADD_SESSION_KEY =bytes4(keccak256("addSessionKey(address)"));
    bytes4 private constant REMOVE_SESSION_KEY = bytes4(keccak256("removeSessionKey(address)"));
    bytes4 private constant ERC20_TRANSFER_FROM = bytes4(keccak256("transferFrom(address,address,uint256)"));
    bytes4 private constant NFT_SAFE_TRANSFER_FROM = bytes4(keccak256("safeTransferFrom(address,address,uint256)"));
    bytes4 private constant NFT_SAFE_TRANSFER_FROM_DATA =
        bytes4(keccak256("safeTransferFrom(address,address,uint256,bytes)"));
    bytes4 private constant SET_APPROVAL_FOR_ALL = bytes4(keccak256("setApprovalForAll(address,bool)"));
    bytes4 private constant INCREASE_ALLOWANCE = bytes4(keccak256("increaseAllowance(address,uint256)"));

    bytes4 private constant SET_GUARD = bytes4(keccak256("setGuard(address)"));
    bytes4 private constant ADD_OWNER = bytes4(keccak256("addOwnerWithThreshold(address,uint256)"));
    bytes4 private constant REMOVE_OWNER = bytes4(keccak256("removeOwner(address,address,uint256)"));
    bytes4 private constant SWAP_OWNER = bytes4(keccak256("swapOwner(address,address,address)"));
    bytes4 private constant CHANGE_THRESHOLD = bytes4(keccak256("changeThreshold(uint256)"));
    bytes4 private constant DISABLE_MODULE = bytes4(keccak256("disableModule(address,address)"));
    bytes4 private constant REQUEST_REMOVAL = bytes4(keccak256("requestRemoval()"));
    bytes4 private constant CANCEL_REMOVAL = bytes4(keccak256("cancelRemoval()"));
    bytes4 private constant ERC20_TRANSFER = bytes4(keccak256("transfer(address,uint256)"));
    bytes4 private constant ERC20_APPROVE = bytes4(keccak256("approve(address,uint256)"));
    bytes4 private constant WRAP_DEPOSIT = bytes4(keccak256("deposit()"));
    bytes4 private constant WRAP_WITHDRAW = bytes4(keccak256("withdraw(uint256)"));
    bytes4 private constant PERMIT2_APPROVE = bytes4(keccak256("approve(address,address,uint160,uint48)"));
    bytes4 private constant MULTI_SEND = bytes4(keccak256("multiSend(bytes)"));

    event TokenLimitSet(address indexed account, address indexed token, uint256 maxAmountPerBuy);
    event TradeCountLimitSet(address indexed account, uint256 maxBuysPerDay);
    event BuyRecorded(address indexed account, uint256 buysToday);
    event DailyLossBreachRecorded(address indexed account, uint256 day);
    event SpenderAllowed(address indexed spender, bool allowed);
    event TrackedAssetAdded(address indexed token);
    event RemovalRequested(address indexed account, uint256 unlockTime);
    event RemovalCancelled(address indexed account);
    event SessionKeyAdded(address indexed account, address indexed key);
    event SessionKeyRemoved(address indexed account, address indexed key);

    error NotAdmin();
    error SessionKeyBlocked(address to, bytes4 selector);
    error LimitsNotConfigured(address account);
    error AccountIsFrozen(address account);
    error TradeAmountExceeded(address token, uint256 requested, uint256 max);
    error TradeCountExceeded(uint256 attempted, uint256 max);
    error DelegateCallNotAllowed();
    error BlockedCall(address to, bytes4 selector);
    error SpenderNotAllowed(address token, address spender);
    error GuardRemovalNotReady(uint256 unlockTime);
    error GuardRemovalBlockedWhileFrozen(address account);
    error ModulesNotAllowed();
    error NestedExecution();
    error MalformedMultiSend();
    error BalanceReadFailed(address token);
    error TooManyTrackedAssets();
    error AlreadyTracked(address token);

    modifier onlyAdmin() {
        if (msg.sender != admin) revert NotAdmin();
        _;
    }

    /// @param _admin MyPropGuard's backend key. Can set limits, allowlist spenders, add tracked
    /// assets and record a daily-loss breach. Cannot unfreeze, cannot move funds, is never an owner.
    /// @param _wrappedNative WBNB / WETH. Must also appear in `_baseTokens` if it should count as money.
    /// @param _multiSendCallOnly Safe's official MultiSendCallOnly on this chain.
    /// @param _permit2 Permit2, or address(0).
    /// @param _baseTokens ERC-20 base assets: wrapped native coin and stablecoins.
    /// @param _spenders Routers and other contracts a trader may approve base assets to.
    constructor(
        address _admin,
        address _wrappedNative,
        address _multiSendCallOnly,
        address _permit2,
        address[] memory _baseTokens,
        address[] memory _spenders
    ) {
        admin = _admin;
        wrappedNative = _wrappedNative;
        multiSendCallOnly = _multiSendCallOnly;
        permit2 = _permit2;

        _tracked.push(address(0));
        for (uint256 i = 0; i < _baseTokens.length; i++) {
            _addTracked(_baseTokens[i]);
        }
        for (uint256 i = 0; i < _spenders.length; i++) {
            allowedSpender[_spenders[i]] = true;
            emit SpenderAllowed(_spenders[i], true);
        }
    }

    // ---- admin -------------------------------------------------------------------------

    function setTokenLimit(address account, address token, uint256 amount) external onlyAdmin {
        maxAmountPerTrade[account][token] = amount;
        emit TokenLimitSet(account, token, amount);
    }

    function setMaxTradesPerDay(address account, uint256 limit) external onlyAdmin {
        maxTradesPerDay[account] = limit;
        emit TradeCountLimitSet(account, limit);
    }

    function setAllowedSpender(address spender, bool allowed) external onlyAdmin {
        allowedSpender[spender] = allowed;
        emit SpenderAllowed(spender, allowed);
    }

    /// @notice Adds a base asset. Assets can only be added, never removed, so a tracked asset
    /// can't be dropped to hide spending of it.
    function addTrackedAsset(address token) external onlyAdmin {
        _addTracked(token);
    }

    /// @notice Records that an account breached its max-daily-loss rule today, freezing buys through
    /// the end of the current UTC day. One-directional: it can only set the CURRENT day. Nothing
    /// anywhere lifts a freeze early - it expires when the UTC day rolls over.
    function recordDailyLossBreach(address account) external onlyAdmin {
        uint256 today = block.timestamp / 1 days;
        frozenThroughDay[account] = today;
        emit DailyLossBreachRecorded(account, today);
    }

    // ---- views -------------------------------------------------------------------------

    function trackedAssets() external view returns (address[] memory) {
        return _tracked;
    }

    function isFrozen(address account) public view returns (bool) {
        uint256 frozenDay = frozenThroughDay[account];
        // frozenThroughDay defaults to 0 for every never-frozen account, and 0 is also what
        // block.timestamp / 1 days is on a chain whose clock is near the Unix epoch (a local test
        // chain) - the != 0 guard stops that collision from looking like a freeze.
        return frozenDay != 0 && frozenDay == block.timestamp / 1 days;
    }

    // ---- account self-service ----------------------------------------------------------

    /// @notice A Safe calls this (through its own transaction) to start the 24-hour countdown
    /// before it may detach this Guard.
    function requestRemoval() external {
        removalRequestedAt[msg.sender] = block.timestamp;
        emit RemovalRequested(msg.sender, block.timestamp + REMOVAL_DELAY);
    }

    function cancelRemoval() external {
        delete removalRequestedAt[msg.sender];
        emit RemovalCancelled(msg.sender);
    }

    /// @notice A Safe calls this (through its own transaction, signed by a real owner) to mark `key` as a
    /// session key. The key must also be added to the Safe as an owner. A session key can never call this
    /// itself: every call to the Guard is blocked for it.
    function addSessionKey(address key) external {
        if (!isSessionKey[msg.sender][key]) {
            isSessionKey[msg.sender][key] = true;
            sessionKeyCount[msg.sender]++;
        }
        emit SessionKeyAdded(msg.sender, key);
    }

    /// @notice Takes the session mark off `key` at once. Removing the key as a Safe owner is a separate step.
    function removeSessionKey(address key) external {
        if (isSessionKey[msg.sender][key]) {
            delete isSessionKey[msg.sender][key];
            sessionKeyCount[msg.sender]--;
        }
        emit SessionKeyRemoved(msg.sender, key);
    }

    // ---- Safe Guard hooks --------------------------------------------------------------

    function checkTransaction(
        address to,
        uint256 value,
        bytes memory data,
        Enum.Operation operation,
        uint256 safeTxGas,
        uint256 baseGas,
        uint256 gasPrice,
        address gasToken,
        address payable refundReceiver,
        bytes memory signatures,
        address
    ) external override {
        address account = msg.sender;
        if (_snapshotActive[account]) revert NestedExecution();

        uint8 flags;
        if (sessionKeyCount[account] != 0) {
            // The Safe has already bumped its nonce by the time it calls the Guard, so this transaction's was nonce - 1.
            bytes32 safeTxHash = keccak256(
                abi.encode(
                    SAFE_TX_TYPEHASH,
                    to,
                    value,
                    keccak256(data),
                    operation,
                    safeTxGas,
                    baseGas,
                    gasPrice,
                    gasToken,
                    refundReceiver,
                    ISafeView(account).nonce() - 1
                )
            );
            if (_signedBySessionKey(account, safeTxHash, signatures)) flags = SESSION;
        }

        bool exempt;
        if (operation == Enum.Operation.DelegateCall) {
            if (multiSendCallOnly == address(0) || to != multiSendCallOnly) revert DelegateCallNotAllowed();
            exempt = _policyMultiSend(account, data, flags);
        } else {
            exempt = _policyCall(account, to, value, data, flags);
        }
        if (exempt) return;

        uint256 n = _tracked.length;
        for (uint256 i = 0; i < n; i++) {
            _preBalance[account][i] = _balanceOf(_tracked[i], account);
        }
        _snapshotActive[account] = true;
    }

    function checkAfterExecution(bytes32, bool success) external override {
        address account = msg.sender;
        if (!_snapshotActive[account]) return;
        _snapshotActive[account] = false;
        if (!success) return;
        _evaluate(account);
    }

    function checkModuleTransaction(address, uint256, bytes memory, Enum.Operation, address)
        external
        pure
        override
        returns (bytes32)
    {
        revert ModulesNotAllowed();
    }

    function checkAfterModuleExecution(bytes32, bool) external pure override {}

    // ---- outcome check -----------------------------------------------------------------

    function _evaluate(address account) private {
        uint256 n = _tracked.length;
        uint256[] memory spentAmounts = new uint256[](n);
        bool spent;
        for (uint256 i = 0; i < n; i++) {
            uint256 pre = _preBalance[account][i];
            uint256 post = _balanceOf(_tracked[i], account);
            if (post < pre) {
                spentAmounts[i] = pre - post;
                spent = true;
            }
        }
        // No base asset left the Safe: a sell, an approval, or any other non-spending action.
        if (!spent) return;

        if (isFrozen(account)) revert AccountIsFrozen(account);

        uint256 tradeLimit = maxTradesPerDay[account];
        if (tradeLimit == 0) revert LimitsNotConfigured(account);

        for (uint256 i = 0; i < n; i++) {
            uint256 amount = spentAmounts[i];
            if (amount == 0) continue;
            uint256 cap = maxAmountPerTrade[account][_tracked[i]];
            if (cap != 0 && amount > cap) revert TradeAmountExceeded(_tracked[i], amount, cap);
        }

        uint256 today = block.timestamp / 1 days;
        AccountState memory existing = tradeState[account];
        uint256 buysToday = (existing.lastTradeDay == today ? existing.tradesToday : 0) + 1;
        if (buysToday > tradeLimit) revert TradeCountExceeded(buysToday, tradeLimit);

        tradeState[account] = AccountState(today, buysToday);
        emit BuyRecorded(account, buysToday);
    }

    // ---- call policy -------------------------------------------------------------------

    /// @dev Returns true if the call can never spend base assets in a trade (a withdrawal, a wrap,
    /// a revoke, a Safe management call), so no balance snapshot is needed. Returns false for
    /// anything else, whose effect is judged by the outcome check. Reverts for forbidden calls.
    function _policyCall(address account, address to, uint256 value, bytes memory data, uint8 flags)
        private
        returns (bool)
    {
        bytes4 sel = data.length >= 4 ? _selector(data) : bytes4(0);
        bool session = flags & SESSION != 0;

        // A session key may only trade: it can never call the Guard, manage the Safe, or send money out.
        if (session && (to == address(this) || to == account)) revert SessionKeyBlocked(to, sel);

        if (to == address(this)) {
            if (
                value == 0
                    && (sel == REQUEST_REMOVAL || sel == CANCEL_REMOVAL || sel == ADD_SESSION_KEY || sel == REMOVE_SESSION_KEY)
            ) return true;
            revert BlockedCall(to, sel);
        }

        if (to == account) {
            if (data.length == 0) return true;
            if (sel == SET_GUARD) {
                // Detaching the Guard inside a batch would leave the batch's balance check un-run.
                if (flags & IN_BATCH != 0) revert BlockedCall(to, sel);
                _checkRemoval(account);
                return true;
            }
            if (
                sel == ADD_OWNER || sel == REMOVE_OWNER || sel == SWAP_OWNER || sel == CHANGE_THRESHOLD
                    || sel == DISABLE_MODULE
            ) return true;
            revert BlockedCall(to, sel);
        }

        // A plain native-coin send: a withdrawal.
        if (data.length == 0) {
            if (session) revert SessionKeyBlocked(to, sel);
            withdrawnTotal[account][address(0)] += value;
            return true;
        }

        if (isTrackedToken[to]) {
            if (value == 0 && sel == ERC20_TRANSFER) {
                if (session) revert SessionKeyBlocked(to, sel);
                _recordTransferOut(account, to, data);
                return true;
            }
            if (value == 0 && sel == ERC20_APPROVE && data.length == 68) {
                (address spender, uint256 amount) = abi.decode(_stripSelector(data), (address, uint256));
                if (amount == 0 || allowedSpender[spender]) return true;
                revert SpenderNotAllowed(to, spender);
            }
            if (to == wrappedNative && sel == WRAP_DEPOSIT) return true;
            if (to == wrappedNative && value == 0 && sel == WRAP_WITHDRAW) return true;
            revert BlockedCall(to, sel);
        }

        if (permit2 != address(0) && to == permit2) {
            if (value == 0 && sel == PERMIT2_APPROVE && data.length == 4 + 128) {
                (, address spender, uint160 amount,) =
                    abi.decode(_stripSelector(data), (address, address, uint160, uint48));
                if (amount == 0 || allowedSpender[spender]) return true;
                revert SpenderNotAllowed(to, spender);
            }
            revert BlockedCall(to, sel);
        }

        if (session) _sessionPolicyForOtherToken(to, data, sel);

        // A transfer of any other token is still judged by the outcome check (it spends no base asset,
        // so it passes), but is counted as a withdrawal for the backend's profit and loss maths.
        if (value == 0 && sel == ERC20_TRANSFER && data.length == 68) _recordTransferOut(account, to, data);

        return false;
    }

    /// @dev What a session key may not do to a token that is not a base asset: send it anywhere, hand
    /// out an allowance to anyone but an allowlisted router, or hand out blanket NFT access.
    function _sessionPolicyForOtherToken(address token, bytes memory data, bytes4 sel) private view {
        if (
            sel == ERC20_TRANSFER || sel == ERC20_TRANSFER_FROM || sel == NFT_SAFE_TRANSFER_FROM
                || sel == NFT_SAFE_TRANSFER_FROM_DATA || sel == SET_APPROVAL_FOR_ALL || sel == INCREASE_ALLOWANCE
        ) revert SessionKeyBlocked(token, sel);
        if (sel == ERC20_APPROVE) {
            if (data.length < 68) revert SessionKeyBlocked(token, sel);
            (address spender, uint256 amount) = abi.decode(_stripSelector(data), (address, uint256));
            if (amount != 0 && !allowedSpender[spender]) revert SessionKeyBlocked(token, sel);
        }
    }

    /// @dev Finds out whether any of the signatures that satisfy the Safe's threshold belongs to a session
    /// key, reading them exactly the way the Safe does (checkSignatures).
    function _signedBySessionKey(address account, bytes32 safeTxHash, bytes memory signatures)
        private
        view
        returns (bool)
    {
        bytes32 txHash =
            keccak256(abi.encodePacked(bytes1(0x19), bytes1(0x01), ISafeView(account).domainSeparator(), safeTxHash));
        uint256 threshold = ISafeView(account).getThreshold();
        for (uint256 i = 0; i < threshold; i++) {
            uint8 v;
            bytes32 r;
            bytes32 s;
            assembly {
                let pos := add(signatures, mul(0x41, i))
                r := mload(add(pos, 0x20))
                s := mload(add(pos, 0x40))
                v := and(mload(add(pos, 0x41)), 0xff)
            }
            address signer;
            if (v == 0 || v == 1) {
                signer = address(uint160(uint256(r))); // a contract signature, or a pre-approved hash
            } else if (v > 30) {
                signer = ecrecover(keccak256(abi.encodePacked("\x19Ethereum Signed Message:\n32", txHash)), v - 4, r, s);
            } else {
                signer = ecrecover(txHash, v, r, s);
            }
            if (signer != address(0) && isSessionKey[account][signer]) return true;
        }
        return false;
    }

    function _recordTransferOut(address account, address token, bytes memory data) private {
        if (data.length != 68) return;
        (, uint256 amount) = abi.decode(_stripSelector(data), (address, uint256));
        withdrawnTotal[account][token] += amount;
    }

    /// @dev Walks a MultiSendCallOnly batch (packed: operation(1) | to(20) | value(32) |
    /// dataLength(32) | data) and applies the call policy to every inner call.
    function _policyMultiSend(address account, bytes memory data, uint8 flags) private returns (bool) {
        if (data.length < 4 || _selector(data) != MULTI_SEND) revert DelegateCallNotAllowed();
        bytes memory packed = abi.decode(_stripSelector(data), (bytes));

        flags |= IN_BATCH;
        uint256 len = packed.length;
        uint256 i = 0;
        bool allExempt = true;
        while (i < len) {
            if (i + 85 > len) revert MalformedMultiSend();
            uint8 op;
            address to;
            uint256 value;
            uint256 dataLength;
            assembly {
                let p := add(add(packed, 32), i)
                op := byte(0, mload(p))
                to := shr(96, mload(add(p, 1)))
                value := mload(add(p, 21))
                dataLength := mload(add(p, 53))
            }
            if (op != 0) revert DelegateCallNotAllowed();
            if (dataLength > len || i + 85 + dataLength > len) revert MalformedMultiSend();

            if (!_policyCall(account, to, value, _slice(packed, i + 85, dataLength), flags)) allExempt = false;
            i += 85 + dataLength;
        }
        return allExempt;
    }

    function _slice(bytes memory source, uint256 start, uint256 length) private pure returns (bytes memory out) {
        out = new bytes(length);
        for (uint256 j = 0; j < length; j++) {
            out[j] = source[start + j];
        }
    }

    function _checkRemoval(address account) private {
        uint256 requestedAt = removalRequestedAt[account];
        uint256 unlock = requestedAt + REMOVAL_DELAY;
        if (requestedAt == 0 || block.timestamp < unlock) revert GuardRemovalNotReady(unlock);
        if (isFrozen(account)) revert GuardRemovalBlockedWhileFrozen(account);
        delete removalRequestedAt[account];
    }

    // ---- helpers -----------------------------------------------------------------------

    function _addTracked(address token) private {
        if (token == address(0) || isTrackedToken[token]) revert AlreadyTracked(token);
        if (_tracked.length >= MAX_TRACKED_ASSETS) revert TooManyTrackedAssets();
        isTrackedToken[token] = true;
        _tracked.push(token);
        emit TrackedAssetAdded(token);
    }

    function _balanceOf(address asset, address account) private view returns (uint256) {
        if (asset == address(0)) return account.balance;
        (bool ok, bytes memory ret) = asset.staticcall(abi.encodeWithSignature("balanceOf(address)", account));
        if (!ok || ret.length < 32) revert BalanceReadFailed(asset);
        return abi.decode(ret, (uint256));
    }

    function _selector(bytes memory data) private pure returns (bytes4 sel) {
        assembly {
            sel := mload(add(data, 32))
        }
    }

    function _stripSelector(bytes memory data) private pure returns (bytes memory out) {
        out = new bytes(data.length - 4);
        for (uint256 i = 0; i < out.length; i++) {
            out[i] = data[i + 4];
        }
    }
}
