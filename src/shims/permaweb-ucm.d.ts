declare module '@permaweb/ucm' {
  export function createOrderbook(
    deps: unknown,
    args: Record<string, unknown>,
    onStatus?: (status: { processing: boolean; success: boolean; message: string }) => void
  ): Promise<string>;

  export function createOrder(
    deps: unknown,
    args: Record<string, unknown>,
    onStatus?: (status: { processing: boolean; success: boolean; message: string }) => void
  ): Promise<unknown>;

  export function cancelOrder(
    deps: unknown,
    args: Record<string, unknown>,
    onStatus?: (status: { processing: boolean; success: boolean; message: string }) => void
  ): Promise<unknown>;
}
