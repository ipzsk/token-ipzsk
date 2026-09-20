// Read-only configuration check. Never prints the private key, customer data or checkout tokens.
import { loadWaffo } from '../src/waffo.mjs';
import { randomUUID } from 'node:crypto';
const provider = await loadWaffo();
if (!provider || provider.mode !== 'test') throw new Error('test_waffo_config_required');
const result = await provider.client.graphql.query({ query: `query ($storeId: String!) {
  onetimeProducts(storeId: $storeId) { id name prices { currency priceInfo { amount taxCategory } } }
}`, variables: { storeId: provider.storeId } });
if (result.errors?.length || !result.data?.onetimeProducts) {
  console.error('waffo_product_check_failed', result.errors?.map(e => e.message)); process.exitCode = 1;
} else {
  for (const pack of provider.products) {
    const product = result.data.onetimeProducts.find(p => p.id === pack.productId);
    const price = product?.prices.find(p => p.currency === 'CNY');
    if (!product || Number(price?.priceInfo?.amount) !== Number(pack.amount_cny)) throw new Error('product_config_mismatch');
    console.log(JSON.stringify({ pack: pack.key, product_id: product.id, mode: 'test', amount_cny: price.priceInfo.amount }));
    if (process.argv.includes('--checkouts')) {
      const session = await provider.createCheckout({ productId: pack.productId, currency: 'CNY',
        buyerIdentity: 'ipzsk-integration-test', orderMerchantExternalId: 'smoke-' + randomUUID(),
        language: 'zh-Hans', expiresInSeconds: 1800, successUrl: 'https://www.ipzsk.com/account.html?payment=return' });
      console.log(JSON.stringify({ pack: pack.key, checkout_created: Boolean(session.sessionId),
        checkout_host: new URL(session.checkoutUrl).hostname, expires_at: session.expiresAt }));
    }
  }
}
