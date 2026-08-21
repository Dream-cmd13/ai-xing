import { authenticationFailed, authenticationRequired } from './errors.mjs';

function decodeBase64(value) {
  if (!value || value.length % 4 === 1 || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) {
    throw authenticationFailed();
  }
  try {
    const decoded = Buffer.from(value, 'base64').toString('utf8');
    if (decoded.includes('\uFFFD')) throw new Error('invalid utf8');
    return decoded;
  } catch {
    throw authenticationFailed();
  }
}

export function parseBasicAuthorization(header) {
  if (typeof header !== 'string' || !header.trim()) throw authenticationRequired();
  const match = /^Basic\s+([^\s]+)$/i.exec(header.trim());
  if (!match) throw authenticationRequired();

  const decoded = decodeBase64(match[1]);
  const separator = decoded.indexOf(':');
  if (separator <= 0) throw authenticationFailed();

  const rawUsername = decoded.slice(0, separator).trim().toLowerCase();
  const password = decoded.slice(separator + 1);
  if (!rawUsername || !password || rawUsername.length > 128 || password.length > 1024) {
    throw authenticationFailed();
  }
  if (/\p{C}/u.test(rawUsername) || /[\u0000\r\n]/u.test(password)) throw authenticationFailed();

  let username = rawUsername;
  if (username.endsWith('@app.local')) username = username.slice(0, -'@app.local'.length);
  if (!username || username.includes('@')) throw authenticationFailed();

  return {
    username,
    email: `${username}@app.local`,
    password,
  };
}
