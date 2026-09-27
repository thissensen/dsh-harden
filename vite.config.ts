/**
 * client 壳产物的构建配置：`client/index.js`（`package.json` 的 `exports["./client"]`）。
 *
 * 壳受 DSH 启动快照约束 ⇒ **首次构建必须在启动 DSH 之前完成**，之后改壳要重启。
 * 本项目没有「部件热重载」那层（GUI 简单，不需要）。
 *
 * @module dsh-harden/vite
 */

import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'
import { dshModuleLoaderWrap, EXTERNAL_MODULES } from './vite.shared'

export default defineConfig({
    plugins: [react(), dshModuleLoaderWrap('dsh-harden')],

    build: {
        emptyOutDir: false,
        outDir: 'client',
        lib: {
            entry: 'src/client/index.ts',
            formats: ['cjs'],
            fileName: () => 'index.js',
        },
        rollupOptions: {
            external: [...EXTERNAL_MODULES],
            output: { exports: 'named' },
        },
    },
})
