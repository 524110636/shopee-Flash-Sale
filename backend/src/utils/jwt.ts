import { SignJWT, jwtVerify, type JWTPayload } from 'jose';

const jwtSecret = process.env.JWT_SECRET;
if (!jwtSecret) {
  throw new Error('JWT_SECRET 环境变量未设置，请设置后重启服务');
}
const secret = new TextEncoder().encode(jwtSecret);

export interface TokenPayload extends JWTPayload {
  userId: number;
  email: string;
  role: string;
  autoModeEnabled: number;
  trialUsed: number;
  trialEnabled: number;
}

export async function signToken(payload: TokenPayload): Promise<string> {
  return new SignJWT(payload)
    .setProtectedHeader({ alg: 'HS256' })
    .setExpirationTime('7d')
    .setIssuedAt()
    .sign(secret);
}

export async function verifyToken(token: string): Promise<TokenPayload> {
  const { payload } = await jwtVerify(token, secret);
  return payload as unknown as TokenPayload;
}
