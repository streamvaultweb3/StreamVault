/**
 * Self-contained browser shim for rpc-websockets.
 * Turbo's browser import graph only needs these names to exist.
 */
class WSClient {
  constructor() {}
  open() {}
  close() {}
  call() { return Promise.resolve(null); }
  notify() {}
  on() { return this; }
  once() { return this; }
  off() { return this; }
  connect() {}
}

class WebSocketShim {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  readyState = WebSocketShim.OPEN;
  close() {}
  send() {}
  addEventListener() {}
  removeEventListener() {}
}

export { WSClient as Client, WSClient as CommonClient, WebSocketShim as WebSocket };
export default WSClient;
