declare global {
  interface Window {
    gtag?: (...args: any[]) => void;
    dataLayer?: any[];
  }
}

type AnalyticsParams = Record<string, string | number | boolean | null | undefined>;
type UserPropertyMap = Record<string, string | number | boolean | null | undefined>;

function sendGtag(...args: any[]) {
  if (typeof window === 'undefined') return;
  if (typeof window.gtag === 'function') {
    window.gtag(...args);
    return;
  }
  if (Array.isArray(window.dataLayer)) {
    window.dataLayer.push(args);
  }
}

export function trackPageView(path: string, title?: string, extraParams: AnalyticsParams = {}) {
  sendGtag('event', 'page_view', {
    page_path: path,
    page_title: title || (typeof document !== 'undefined' ? document.title : undefined),
    page_location: typeof window !== 'undefined' ? window.location.href : undefined,
    ...extraParams,
  });
}

export function trackEvent(eventName: string, params: AnalyticsParams = {}) {
  sendGtag('event', eventName, params);
}

export function configureAnalytics(measurementId: string) {
  sendGtag('config', measurementId);
}

export function setUserProperties(properties: UserPropertyMap) {
  sendGtag('set', 'user_properties', properties);
}

export function setAnalyticsUserId(userId: string | null) {
  sendGtag('set', { user_id: userId });
}
