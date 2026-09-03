/**
 * Doc §3.8: there are two envelope shapes, and the parser must handle both.
 * v6 responses (and v7 *success* responses) use <Result>/<ResultExplanation>;
 * v7 *error* responses use <Code>/<Explanation>. A parser assuming only the v6
 * shape reads `undefined` on every v7 error — see §3.3/§4.1.2.
 */
export interface DpoResultEnvelope {
  result?: string;
  resultExplanation?: string;
}

export interface DpoCodeEnvelope {
  code?: string;
  explanation?: string;
}

/** Normalized shape used everywhere downstream of the raw parsed XML. */
export interface DpoApiEnvelope {
  /** '000' = success — see doc §4.1.3 for the full result-code table. */
  code: string;
  explanation: string;
}

export function normalizeEnvelope(raw: DpoResultEnvelope & DpoCodeEnvelope): DpoApiEnvelope {
  return {
    code: raw.result ?? raw.code ?? '',
    explanation: raw.resultExplanation ?? raw.explanation ?? '',
  };
}
