// Nought never earns an integrator, referral or builder fee. Provider/pool/network
// costs still exist and are itemized by quoteDetails. Enforce this before transport.
const FORBIDDEN = new Set(['platformFeeBps', 'feeAccount', 'feeBps', 'referralAccount', 'referralFee', 'referralFeeBps', 'referral', 'builder', 'builderCode']);
export function assertZeroFeeRequest(url, options = {}) {
  const parsed = new URL(url);
  for (const key of parsed.searchParams.keys()) if (FORBIDDEN.has(key)) throw new Error('Nought fee policy: integrator fees are disabled.');
  if (options.body) {
    const body = JSON.parse(options.body);
    for (const key of Object.keys(body || {})) if (FORBIDDEN.has(key)) throw new Error('Nought fee policy: integrator fees are disabled.');
    if (body?.quoteResponse) assertZeroFeeQuote(body.quoteResponse);
  }
}
export function assertZeroFeeQuote(quote) {
  const fee = quote?.platformFee;
  if (fee != null && (Number(fee.feeBps || 0) !== 0 || Number(fee.amount || 0) !== 0)) throw new Error('The quote includes a platform fee. Nought refused this route.');
}
