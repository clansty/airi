import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: {
    'index': 'src/index.ts',
    // 代理是一个独立进程的入口，必须单独产出一个文件，主进程用 `new URL` 找到它。
    'proxy/main': 'src/proxy/main.ts',
  },
  dts: { sourcemap: false },
  format: 'esm',
  platform: 'node',
})
