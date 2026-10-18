/**
 * The one test every reader of untrusted JSON here starts with.
 *
 * The claim it makes falsifiable: none - this is plumbing, kept in one place
 * so the seal's ledger reader and the hosts' hook-input readers agree on what
 * an object is. An array is not one, and neither is `null`, although
 * `typeof` says both are.
 */
export const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
