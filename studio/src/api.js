export async function api(path, options = {}) {
  const headers = { 'X-Studio-Request': '1', ...options.headers };
  if (options.body && !(options.body instanceof FormData)) headers['Content-Type'] = 'application/json';
  const response = await fetch(path, { ...options, headers });
  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    throw new Error(data.error || `请求失败 (${response.status})`);
  }
  return options.blob ? response.blob() : response.json();
}
export const post = (url, body, options = {}) => api(url, { method: 'POST', body: JSON.stringify(body), ...options });
export const uid = () => crypto.randomUUID().replaceAll('-', '');
export function downloadJSON(value, name) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(value, null, 2)], { type: 'application/json' }));
  const anchor = document.createElement('a');
  anchor.href = url; anchor.download = name; anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
