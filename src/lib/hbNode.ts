type HbRequestArgs = {
  url: string;
  method?: 'GET' | 'POST';
  headers?: Record<string, string>;
  body?: string;
  label?: string;
  forceLog?: boolean;
};

function shouldLog(force = false): boolean {
  if (force) return true;
  return import.meta.env.DEV && String(import.meta.env.VITE_DEBUG_HB || '') === '1';
}

function safeJsonParse(text: string): any | null {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

export async function hbRequest(args: HbRequestArgs): Promise<{
  status: number;
  ok: boolean;
  contentType: string;
  json: any | null;
  text: string;
}> {
  const method = args.method || 'GET';
  const headers = args.headers || {};
  const body = args.body;
  const log = shouldLog(args.forceLog);

  if (log) {
    console.info('[hb:req]', {
      label: args.label || '',
      url: args.url,
      method,
      headers,
      body: body ?? null,
    });
  }

  const res = await fetch(args.url, { method, headers, body });
  const contentType = res.headers.get('content-type') || '';
  const text = await res.text();
  const json = contentType.includes('application/json') ? safeJsonParse(text) : null;

  if (log) {
    console.info('[hb:res]', {
      label: args.label || '',
      url: args.url,
      method,
      status: res.status,
      contentType,
      body: json ?? text,
    });
  }

  return {
    status: res.status,
    ok: res.ok,
    contentType,
    json,
    text,
  };
}

export async function runHbNodeDiagnostics(pid: string, nodeBase: string) {
  const base = String(nodeBase || '').replace(/\/+$/, '');
  const headers = { Accept: 'application/json' };
  const results = [];

  results.push(await hbRequest({
    label: 'init',
    url: `${base}/${pid}~process@1.0/init`,
    method: 'GET',
    headers,
    forceLog: true,
  }));
  results.push(await hbRequest({
    label: 'slot/current',
    url: `${base}/${pid}~process@1.0/slot/current`,
    method: 'GET',
    headers,
    forceLog: true,
  }));
  results.push(await hbRequest({
    label: 'now',
    url: `${base}/${pid}~process@1.0/now`,
    method: 'GET',
    headers,
    forceLog: true,
  }));
  results.push(await hbRequest({
    label: 'Action=Info',
    url: `${base}/${pid}~process@1.0/as=execution/compute&Action=Info`,
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: '{}',
    forceLog: true,
  }));

  return results;
}

