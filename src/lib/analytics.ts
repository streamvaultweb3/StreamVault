declare global {
  interface Window {
    gtag?: (...args: any[]) => void;
  }
}

function hasGtag(): boolean {
  return typeof window !== 'undefined' && typeof window.gtag === 'function';
}

export function trackPageView(path: string, title?: string, extraParams: AnalyticsParams = {}) {
  if (!hasGtag()) return;
  window.gtag?.('event', 'page_view', {
    page_path: path,
    page_title: title || (typeof document !== 'undefined' ? document.title : undefined),
    page_location: typeof window !== 'undefined' ? window.location.href : undefined,
    ...extraParams,
  });
}

type AnalyticsParams = Record<string, string | number | boolean | null | undefined>;
type UserPropertyMap = Record<string, string | number | boolean | null | undefined>;

export function trackEvent(eventName: string, params: AnalyticsParams = {}) {
  if (!hasGtag()) return;
  window.gtag?.('event', eventName, params);
}

export function configureAnalytics(measurementId: string) {
  if (!hasGtag()) return;
  window.gtag?.('config', measurementId, {
    send_page_view: false,
  });
}

export function setUserProperties(properties: UserPropertyMap) {
  if (!hasGtag()) return;
  window.gtag?.('set', 'user_properties', properties);
}

export function setAnalyticsUserId(userId: string | null) {
  if (!hasGtag()) return;
  window.gtag?.('set', { user_id: userId });
}
