import { readFile } from 'node:fs/promises';
import { WaffoPancake, verifyWebhook } from '@waffo/pancake-ts';

export const PAYMENT_PACKS = [10, 50, 100].map(amount => ({
  key: `cny_${amount}`, name: `IPZSK AI 创作额度包 · ${amount} 元`, amount_cny: `${amount}.00`, currency: 'CNY',
}));

export function checkoutUrl(value) {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.hostname !== 'pancake.waffo.ai' || url.username || url.password)
    throw new Error('invalid_checkout_url');
  return url.href;
}

export async function loadWaffo(env = process.env) {
  if (!env.WAFFO_CONFIG_FILE) return null;
  const config = JSON.parse(await readFile(env.WAFFO_CONFIG_FILE, 'utf8'));
  if (!['test', 'prod'].includes(config.mode) || !/^MER_[A-Za-z0-9]+$/.test(config.merchantId) ||
      !/^STO_[A-Za-z0-9]+$/.test(config.storeId) || !env.WAFFO_PRIVATE_KEY_FILE)
    throw new Error('invalid_waffo_config');
  const products = PAYMENT_PACKS.map(pack => ({ ...pack, productId: config.products?.[pack.key] }));
  if (products.some(pack => !/^PROD_[A-Za-z0-9]+$/.test(pack.productId ?? '')) ||
      new Set(products.map(pack => pack.productId)).size !== products.length) throw new Error('invalid_waffo_products');
  const client = new WaffoPancake({ merchantId: config.merchantId, environment: config.mode,
    privateKey: await readFile(env.WAFFO_PRIVATE_KEY_FILE, 'utf8'),
    fetch: (url, init) => fetch(url, { ...init, signal: AbortSignal.timeout(15_000) }),
  });
  return {
    mode: config.mode, storeId: config.storeId, products, client,
    createCheckout: params => client.checkout.authenticated.create(params),
    verify: (body, signature) => verifyWebhook(body, signature, { environment: config.mode }),
    async readOrder(id) {
      const result = await client.graphql.query({
        query: `query ($id: String!) { onetimeOrder(id: $id) {
          id status testMode orderMerchantExternalId merchantProvidedBuyerIdentity
          store { id } onetimeProduct { id }
          priceSnapshot { currency subtotal total }
        } }`, variables: { id },
      });
      if (result.errors?.length || !result.data?.onetimeOrder) throw new Error('waffo_order_unavailable');
      return result.data.onetimeOrder;
    },
  };
}
