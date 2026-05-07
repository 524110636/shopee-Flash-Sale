/** 生成 6 位数字验证码 */
export function generateVerificationCode(): string {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

/** 计算过期时间（默认 5 分钟后） */
export function getExpiresAt(minutes = 5): string {
  const date = new Date(Date.now() + minutes * 60 * 1000);
  return date.toISOString();
}

/** 检查验证码是否已过期 */
export function isCodeExpired(expiresAt: string): boolean {
  return new Date(expiresAt).getTime() < Date.now();
}
