import { z } from "zod";
import { Client, PrivateKey, TopicMessageSubmitTransaction } from "@hiero-ledger/sdk";
import type { HcsAuditReference } from "@sh/sdk";

/**
 * Public HCS audit record. Minimal by design: no keys, no calldata, no personal data.
 * Denials are written as separate successful HCS messages, because a reverted EVM transaction cannot
 * persist side effects of its own.
 */
export const auditRecordSchema = z.object({
  schemaVersion: z.literal(1),
  decisionId: z.string(),
  account: z.string(),
  actor: z.string(),
  actorType: z.enum(["owner", "session", "sponsor", "guardian", "unknown"]),
  action: z.string(),
  target: z.string().nullable(),
  asset: z.string().nullable(),
  amount: z.string().nullable(),
  allowed: z.boolean(),
  reasonCode: z.string().nullable(),
  decidedBy: z.enum(["sponsor-policy", "account-contract"]),
  intentHash: z.string(),
  timestamp: z.string(),
  transactionId: z.string().nullable(),
});

export type AuditRecord = z.infer<typeof auditRecordSchema>;

export type Auditor = {
  readonly topicId: string | null;
  submit(record: AuditRecord): Promise<HcsAuditReference>;
};

/** HCS message size limit is 1024 bytes per chunk; records are kept well below it. */
const MAX_RECORD_BYTES = 1024;

export class HcsAuditor implements Auditor {
  private readonly client: Client;

  constructor(
    readonly topicId: string,
    operatorId: string,
    operatorKey: string,
  ) {
    this.client = Client.forTestnet().setOperator(operatorId, PrivateKey.fromStringECDSA(operatorKey));
  }

  async submit(record: AuditRecord): Promise<HcsAuditReference> {
    const body = JSON.stringify(auditRecordSchema.parse(record));
    if (Buffer.byteLength(body) > MAX_RECORD_BYTES) throw new Error("HCS_AUDIT_FAILED: record exceeds 1024 bytes");
    const response = await new TopicMessageSubmitTransaction().setTopicId(this.topicId).setMessage(body).execute(this.client);
    const receipt = await response.getReceipt(this.client);
    if (receipt.status.toString() !== "SUCCESS" || receipt.topicSequenceNumber === null) {
      throw new Error(`HCS_AUDIT_FAILED: status ${receipt.status.toString()}`);
    }
    return {
      topicId: this.topicId,
      sequenceNumber: Number(receipt.topicSequenceNumber.toString()),
      transactionId: response.transactionId.toString(),
      consensusTimestamp: null,
    };
  }

  close(): void {
    this.client.close();
  }
}
