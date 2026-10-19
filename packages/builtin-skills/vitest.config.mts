import { readFileSync } from 'node:fs';

import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [
    {
      // `.md` в пакете — справочники навыков: в тестах отдаём их настоящий текст (как сборщик приложения).
      name: 'raw-md',
      transform(_, id) {
        if (!id.endsWith('.md')) return null;
        return { code: `export default ${JSON.stringify(readFileSync(id, 'utf8'))}`, map: null };
      },
    },
  ],
  test: {
    environment: 'node',
  },
});
