// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';

import { skillSafeFetch } from './safeFetch';

// arckep (19.10.2026): ссылки на навыки от людей не должны вести во внутренние службы движка.
// Запрещённые адреса отсекаются агентом до соединения, сеть тестам не нужна.

describe('skillSafeFetch', () => {
  it.each([
    ['http://example.com/SKILL.md', /Only https/],
    ['ftp://example.com/x', /Only https/],
    ['file:///etc/passwd', /Only https/],
    ['https://user:pass@example.com/x', /login or password/],
    ['не ссылка', /Invalid URL/],
  ])('%s отклоняется до запроса', async (url, message) => {
    await expect(skillSafeFetch(url)).rejects.toThrow(message);
  });

  it.each([
    'https://127.0.0.1/',
    'https://127.0.0.1:8202/api/internal',
    'https://localhost/',
    'https://[::1]/',
    'https://169.254.169.254/latest/meta-data/',
    'https://10.0.0.5/',
    'https://192.168.1.10/',
    'https://172.16.0.1/',
  ])('внутренний адрес %s заблокирован', async (url) => {
    await expect(skillSafeFetch(url)).rejects.toThrow(/SSRF blocked|is not allowed|Fetch failed/);
  });

  it('переменная SSRF_ALLOW_PRIVATE_IP_ADDRESS=1 здесь не действует', async () => {
    vi.stubEnv('SSRF_ALLOW_PRIVATE_IP_ADDRESS', '1');
    try {
      await expect(skillSafeFetch('https://127.0.0.1/')).rejects.toThrow(
        /SSRF blocked|is not allowed/,
      );
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
