/** Input rules for usernames and passwords. Returns a list of problems (empty = acceptable). */

const COMMON = new Set([
  'password', 'password1', 'password123', '12345678', '123456789', '1234567890', 'qwertyui', 'qwerty123',
  'iloveyou', 'admin123', 'welcome1', 'letmein1', '11111111', '00000000', 'abcd1234', 'blaze123',
]);

export function passwordProblems(password: string, username?: string): string[] {
  const problems: string[] = [];
  if (password.length < 8) problems.push('must be at least 8 characters');
  if (password.length > 128) problems.push('must be at most 128 characters');
  if (password.length > 0 && new Set(password).size < 3) problems.push('must use at least 3 different characters');
  if (COMMON.has(password.toLowerCase())) problems.push('is too common');
  if (username && password.toLowerCase() === username.toLowerCase()) problems.push('must not be the same as the username');
  return problems;
}

export function usernameProblems(username: string): string[] {
  const problems: string[] = [];
  if (username.length < 3 || username.length > 32) problems.push('must be 3 to 32 characters');
  if (!/^[A-Za-z0-9._-]*$/.test(username)) problems.push('may only contain letters, digits, dot, underscore and hyphen');
  return problems;
}
