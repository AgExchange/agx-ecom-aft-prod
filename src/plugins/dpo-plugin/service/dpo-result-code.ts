import { DpoTransactionStatus } from '../entities/dpo-transaction.entity';

export type DpoResultClass = 'terminal-success' | 'non-terminal' | 'needs-review' | 'terminal-failure' | 'integration-error';

export interface DpoResultCodeInfo {
  code: string;
  explanation: string;
  class: DpoResultClass;
  /**
   * undefined ⇔ integration-error family: the caller MUST NOT write this onto
   * dpo_transaction.status. These codes mean OUR request was malformed or our
   * credentials are wrong, not that the customer's payment failed — see doc §4.1.3.
   */
  transactionStatus?: DpoTransactionStatus;
  pollAgain: boolean;
}

/**
 * Full result-code reference transcribed from documentation/dpo-pay-vendure-plugin-docs.md
 * §4.1.3. The operationally critical split is terminal vs. non-terminal vs.
 * not-a-transaction-state, since that governs whether the fallback poll job keeps
 * re-checking, and whether dpo_transaction.status may be written at all.
 */
const DPO_RESULT_CODES: Record<string, Omit<DpoResultCodeInfo, 'code'>> = {
  '000': { explanation: 'Transaction paid', class: 'terminal-success', transactionStatus: 'paid', pollAgain: false },
  '001': { explanation: 'Authorized', class: 'non-terminal', transactionStatus: 'authorized', pollAgain: true },
  '002': {
    explanation: 'Overpaid or underpaid',
    class: 'needs-review',
    transactionStatus: 'overpaid_underpaid',
    pollAgain: false,
  },
  '003': { explanation: 'Pending bank', class: 'non-terminal', transactionStatus: 'pending_bank', pollAgain: true },
  '005': {
    explanation: 'Queued authorization',
    class: 'non-terminal',
    transactionStatus: 'queued_authorization',
    pollAgain: true,
  },
  '007': {
    explanation: 'Pending split payment (not fully paid)',
    class: 'non-terminal',
    transactionStatus: 'pending_split_payment',
    pollAgain: true,
  },
  '900': {
    explanation: 'Transaction not paid yet',
    class: 'non-terminal',
    transactionStatus: 'awaiting_payment',
    pollAgain: true,
  },
  '901': { explanation: 'Transaction declined', class: 'terminal-failure', transactionStatus: 'declined', pollAgain: false },
  '903': {
    explanation: 'Payment time limit exceeded',
    class: 'terminal-failure',
    transactionStatus: 'expired',
    pollAgain: false,
  },
  '904': {
    explanation: 'Transaction cancelled',
    class: 'terminal-failure',
    transactionStatus: 'cancelled',
    pollAgain: false,
  },
  '801': { explanation: 'Request missing company token', class: 'integration-error', pollAgain: false },
  '802': { explanation: 'Company token does not exist', class: 'integration-error', pollAgain: false },
  '803': { explanation: 'No request or error in request type name', class: 'integration-error', pollAgain: false },
  '804': { explanation: 'Error in XML', class: 'integration-error', pollAgain: false },
  '902': { explanation: 'Data mismatch in one of the fields', class: 'integration-error', pollAgain: false },
  '950': {
    explanation: 'Request missing transaction-level mandatory fields',
    class: 'integration-error',
    pollAgain: false,
  },
};

/**
 * Classifies a DPO result/code value. Unknown/unrecognized codes fail safe into
 * integration-error treatment — never assume an undocumented code is a customer-facing
 * success or failure.
 */
export function classifyResultCode(code: string, explanation?: string): DpoResultCodeInfo {
  const known = DPO_RESULT_CODES[code];
  if (known) {
    return { code, ...known, explanation: explanation || known.explanation };
  }
  return {
    code,
    explanation: explanation || `Unrecognized DPO result code: ${code}`,
    class: 'integration-error',
    pollAgain: false,
  };
}
