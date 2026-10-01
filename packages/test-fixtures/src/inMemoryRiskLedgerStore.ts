import { Decimal } from "decimal.js";
import {
  AccountAlreadyExistsError,
  OrderReservationStatus,
  type AccountRiskHead,
  type LedgerContext,
  type NewAccountInput,
  type NewAccountRuleInput,
  type NewReservationInput,
  type NewStateCheckpointInput,
  type OrderReservation,
  type ProtectedAccount,
  type RiskLedgerStore,
  type RuleType,
  type RuleVersion,
  type StateCheckpoint,
} from "@mypropguard/domain";

let reservationSequence = 0;
let ruleSequence = 0;
let checkpointSequence = 0;

/**
 * In-memory RiskLedgerStore for tests. Serializes `runExclusive` calls per
 * accountId with a real JS promise-chain mutex, so a test that fires two
 * concurrent reservation attempts genuinely exercises the "only one critical
 * section at a time per account" contract — the same invariant a Postgres
 * `SELECT ... FOR UPDATE` provides in production (see PgRiskLedgerStore).
 */
export class InMemoryRiskLedgerStore implements RiskLedgerStore {
  private readonly heads = new Map<string, AccountRiskHead>();
  private readonly rules = new Map<string, RuleVersion[]>();
  private readonly reservations: OrderReservation[] = [];
  private readonly locks = new Map<string, Promise<unknown>>();
  private readonly protectionEnabled = new Map<string, boolean>();
  private readonly checkpoints = new Map<string, StateCheckpoint[]>();
  private readonly accounts = new Map<string, ProtectedAccount>();

  seedAccountRiskHead(head: AccountRiskHead): void {
    this.heads.set(head.accountId, head);
  }

  seedAccount(account: ProtectedAccount): void {
    this.accounts.set(account.accountId, account);
  }

  seedProtectionEnabled(accountId: string, enabled: boolean): void {
    this.protectionEnabled.set(accountId, enabled);
  }

  seedRules(accountId: string, rules: RuleVersion[]): void {
    this.rules.set(accountId, rules);
  }

  getReservations(): readonly OrderReservation[] {
    return this.reservations;
  }

  async findReservationById(reservationId: string): Promise<OrderReservation | null> {
    return this.reservations.find((r) => r.id === reservationId) ?? null;
  }

  async listAccounts(ownerUserId: string): Promise<readonly ProtectedAccount[]> {
    return [...this.accounts.values()]
      .filter((a) => a.ownerUserId === ownerUserId)
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  }

  async findAccountById(accountId: string): Promise<ProtectedAccount | null> {
    return this.accounts.get(accountId) ?? null;
  }

  async listAccountsWithActiveRuleType(ruleType: RuleType): Promise<readonly ProtectedAccount[]> {
    const matchingAccountIds = new Set(
      [...this.rules.entries()]
        .filter(([, rules]) => rules.some((r) => r.ruleType === ruleType && r.isActive))
        .map(([accountId]) => accountId),
    );
    return [...this.accounts.values()].filter((a) => matchingAccountIds.has(a.accountId));
  }

  async createAccount(input: NewAccountInput): Promise<void> {
    if (this.heads.has(input.accountId)) {
      throw new AccountAlreadyExistsError(input.accountId);
    }

    this.accounts.set(input.accountId, {
      accountId: input.accountId,
      ownerUserId: input.ownerUserId,
      venue: input.venue,
      protectionEnabled: false,
      createdAt: new Date(),
      agentWalletId: input.agentWalletId ?? null,
      agentWalletAddress: input.agentWalletAddress ?? null,
      evmOwnerWalletAddress: input.evmOwnerWalletAddress ?? null,
      evmSafeAddress: input.evmSafeAddress ?? null,
      evmChainId: input.evmChainId ?? null,
    });
    this.heads.set(input.accountId, {
      accountId: input.accountId,
      equityStartOfDay: input.initialEquity,
      currentEquity: input.initialEquity,
      realizedPnlToday: new Decimal(0),
      peakEquity: input.initialEquity,
      currentDrawdown: new Decimal(0),
      openNotional: new Decimal(0),
      leverage: new Decimal(0),
      tradeCountToday: 0,
      lastTradeAt: null,
      version: 1,
    });
    this.protectionEnabled.set(input.accountId, false);
    this.rules.set(
      input.accountId,
      input.initialRules.map((rule) => {
        ruleSequence += 1;
        return {
          id: `rule_${ruleSequence}`,
          accountId: input.accountId,
          ruleType: rule.ruleType,
          param: rule.param,
          tokenAddress: rule.tokenAddress ?? null,
          effectiveFrom: new Date(),
          isActive: true,
          createdAt: new Date(),
        };
      }),
    );
  }

  async runExclusive<T>(accountId: string, fn: (ctx: LedgerContext) => Promise<T>): Promise<T> {
    const previous = this.locks.get(accountId) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.locks.set(
      accountId,
      previous.then(() => gate),
    );

    await previous;
    try {
      const ctx: LedgerContext = {
        getAccountRiskHead: async (id) => {
          const head = this.heads.get(id);
          if (!head) throw new Error(`No account risk head seeded for ${id}`);
          return head;
        },
        updateAccountRiskHead: async (head) => {
          this.heads.set(head.accountId, head);
        },
        getActiveRules: async (id) => (this.rules.get(id) ?? []).filter((r) => r.isActive),
        insertRule: async (accountId: string, input: NewAccountRuleInput) => {
          ruleSequence += 1;
          const rule: RuleVersion = {
            id: `rule_${ruleSequence}`,
            accountId,
            ruleType: input.ruleType,
            param: input.param,
            tokenAddress: input.tokenAddress ?? null,
            effectiveFrom: new Date(),
            isActive: true,
            createdAt: new Date(),
          };
          const existing = this.rules.get(accountId) ?? [];
          this.rules.set(accountId, [...existing, rule]);
          return rule;
        },
        deactivateRule: async (ruleId: string) => {
          for (const list of this.rules.values()) {
            const rule = list.find((r) => r.id === ruleId);
            if (rule) {
              rule.isActive = false;
              return;
            }
          }
        },
        getOutstandingReservationTotal: async (id) =>
          this.reservations
            .filter((r) => r.accountId === id && r.status === OrderReservationStatus.HELD)
            .reduce((sum, r) => sum.plus(r.reservedAmount), new Decimal(0)),
        insertReservation: async (input: NewReservationInput) => {
          reservationSequence += 1;
          const reservation: OrderReservation = {
            id: `resv_${reservationSequence}`,
            accountId: input.accountId,
            clientIntentId: input.clientIntentId,
            coin: input.coin,
            reservedAmount: input.reservedAmount,
            status: OrderReservationStatus.HELD,
            createdAt: new Date(),
            releasedAt: null,
            venueOrderId: null,
          };
          this.reservations.push(reservation);
          return reservation;
        },
        releaseReservation: async (reservationId: string) => {
          const reservation = this.reservations.find((r) => r.id === reservationId && r.status === OrderReservationStatus.HELD);
          if (!reservation) return;
          reservation.status = OrderReservationStatus.RELEASED;
          reservation.releasedAt = new Date();
        },
        recordVenueOrderId: async (reservationId: string, venueOrderId: string) => {
          const reservation = this.reservations.find((r) => r.id === reservationId);
          if (!reservation) return;
          reservation.venueOrderId = venueOrderId;
        },
        isProtectionEnabled: async (id) => this.protectionEnabled.get(id) ?? false,
        setProtectionEnabled: async (id, enabled) => {
          this.protectionEnabled.set(id, enabled);
          const account = this.accounts.get(id);
          if (account) account.protectionEnabled = enabled;
        },
        recordStateCheckpoint: async (input: NewStateCheckpointInput) => {
          checkpointSequence += 1;
          const list = this.checkpoints.get(input.accountId) ?? [];
          list.push({ id: `chk_${checkpointSequence}`, ...input });
          this.checkpoints.set(input.accountId, list);
        },
        getLatestStateCheckpoint: async (id) => {
          const list = this.checkpoints.get(id);
          if (!list || list.length === 0) return null;
          return list.reduce((latest, c) => (c.verifiedAt > latest.verifiedAt ? c : latest));
        },
      };
      return await fn(ctx);
    } finally {
      release();
    }
  }
}
