export function generateSecureToken(bytes = 24): string {
  const data = new Uint8Array(bytes);
  crypto.getRandomValues(data);
  let binary = "";
  for (const byte of data) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

export function displayInterviewId(code: string): string {
  const match = code.match(/(\d+)$/);
  if (!match) return code;
  const n = Number(match[1]);
  return n < 1000 ? String(n).padStart(3, "0") : String(n);
}
