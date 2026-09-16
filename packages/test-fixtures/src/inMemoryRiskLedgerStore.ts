import { Decimal } from "decimal.js";
import {
  OrderReservationStatus,
  type AccountRiskHead,
  type LedgerContext,
  type NewReservationInput,
  type OrderReservation,
  type RiskLedgerStore,
  type RuleVersion,
} from "@mypropguard/domain";

let reservationSequence = 0;

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

  seedAccountRiskHead(head: AccountRiskHead): void {
    this.heads.set(head.accountId, head);
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
        getActiveRules: async (id) => this.rules.get(id) ?? [],
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
            reservedAmount: input.reservedAmount,
            status: OrderReservationStatus.HELD,
            createdAt: new Date(),
            releasedAt: null,
          };
          this.reservations.push(reservation);
          return reservation;
        },
        isProtectionEnabled: async (id) => this.protectionEnabled.get(id) ?? false,
        setProtectionEnabled: async (id, enabled) => {
          this.protectionEnabled.set(id, enabled);
        },
      };
      return await fn(ctx);
    } finally {
      release();
    }
  }
}
