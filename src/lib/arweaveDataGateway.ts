/** Default Arweave HTTP gateway: GraphQL, `/{txId}`, `/tx/{txId}`, and `Arweave.init` API host. */
export const ARWEAVE_DATA_GATEWAY_BASE = 'https://arweave.net';
export const ARWEAVE_FALLBACK_DATA_GATEWAY_BASES = [
  'https://arweave.net',
  'https://turbo-gateway.com',
] as const;

export function arweaveDataGatewayHost(): {
  host: string;
  port: number;
  protocol: 'https';
} {
  return { host: 'arweave.net', port: 443, protocol: 'https' };
}

export function arweaveTxDataUrl(txId: string): string {
  return `${ARWEAVE_DATA_GATEWAY_BASE}/${txId}`;
}

export function arweaveTxDataUrls(txId: string): string[] {
  return ARWEAVE_FALLBACK_DATA_GATEWAY_BASES.map((base) => `${base}/${txId}`);
}

export function arweaveTxMetaUrl(txId: string): string {
  return `${ARWEAVE_DATA_GATEWAY_BASE}/tx/${txId}`;
}

export function arweaveTxStatusUrls(txId: string): string[] {
  return ARWEAVE_FALLBACK_DATA_GATEWAY_BASES.map((base) => `${base}/tx/${txId}/status`);
}

export function arweaveGraphqlEndpoint(): string {
  return `${ARWEAVE_DATA_GATEWAY_BASE}/graphql`;
}
