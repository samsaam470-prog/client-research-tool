export function generateSecureToken(bytes = 16): string {
  // 16 bytes = 128 bits, URL-safe base64url without padding, ~21-22 chars
  const arr = new Uint8Array(bytes);
  crypto.getRandomValues(arr);
  // base64url
  let binary = '';
  arr.forEach(b => binary += String.fromCharCode(b));
  const base64 = btoa(binary);
  return base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

export function normalizeInterviewCode(n: number): string {
  if (n < 1000) return String(n).padStart(3, '0');
  return String(n);
}
