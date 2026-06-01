function parseCsvEnv(value) {
  return String(value ?? '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

export function getMcpTokens() {
  return parseCsvEnv(process.env.MCP_API_TOKENS || process.env.MCP_API_TOKEN);
}

export function getAllowedOrigins() {
  return parseCsvEnv(process.env.MCP_ALLOWED_ORIGINS);
}

export function isAuthorizedRequest(request) {
  const tokens = getMcpTokens();
  if (tokens.length === 0) {
    return process.env.NODE_ENV !== 'production';
  }

  const authorization = String(request.headers.authorization ?? '');
  const match = authorization.match(/^Bearer\s+(.+)$/i);
  return Boolean(match && tokens.includes(match[1]));
}

export function isAllowedOrigin(request) {
  const allowedOrigins = getAllowedOrigins();
  const origin = request.headers.origin;

  if (!origin || allowedOrigins.length === 0) {
    return true;
  }

  return allowedOrigins.includes(origin);
}
