// NEAR Intents 1Click quote client. dry:true quotes cost nothing and need no JWT (0.2% fee without one).
export const ONECLICK_BASE = process.env.ONECLICK_BASE || 'https://1click.chaindefuser.com/v0';
export async function getQuote({ originAsset, destinationAsset, amount, recipient, refundTo, dry = true,
  slippageTolerance = 100, deadline = new Date(Date.now() + 3600e3).toISOString() }, fetchImpl = fetch) {
  if (!originAsset || !destinationAsset || !amount || !recipient) throw new Error('missing quote fields');
  const body = { dry, swapType: 'EXACT_INPUT', slippageTolerance, originAsset, depositType: 'ORIGIN_CHAIN',
    destinationAsset, amount: String(amount), refundTo: refundTo || recipient, refundType: 'ORIGIN_CHAIN',
    recipient, recipientType: 'DESTINATION_CHAIN', deadline };
  const headers = { 'content-type': 'application/json' };
  if (process.env.ONECLICK_JWT) headers.authorization = `Bearer ${process.env.ONECLICK_JWT}`;
  const r = await fetchImpl(`${ONECLICK_BASE}/quote`, { method: 'POST', headers, body: JSON.stringify(body) });
  if (!r.ok) throw new Error(`1Click quote failed: ${r.status} ${await r.text()}`);
  return r.json();
}
export async function getStatus(depositAddress, fetchImpl = fetch) {
  const r = await fetchImpl(`${ONECLICK_BASE}/status?depositAddress=${encodeURIComponent(depositAddress)}`);
  if (!r.ok) throw new Error(`1Click status failed: ${r.status}`);
  return r.json();
}
