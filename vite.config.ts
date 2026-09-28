/**
 * client 壳产物的构建配置：`client/index.js`（`package.json` 的 `exports["./client"]`）。
 *
 * 壳受 DSH 启动快照约束 ⇒ **首次构建必须在启动 DSH 之前完成**，之后改壳要重启。
 * 本项目没有「部件热重载」那层（GUI 简单，不需要）。
 *
 * @module dsh-harden/vite
 */

import { readFileSync } from 'node:fs'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'
import { dshModuleLoaderWrap, EXTERNAL_MODULES } from './vite.shared'

/** 包元数据（版本号从这里取，页头显示不再手写常量）。 */
const packageJson = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as { version: string }

export default defineConfig({
    plugins: [react(), dshModuleLoaderWrap('dsh-harden')],

    // 版本号在构建期固化成字面量：发版只改 package.json 一处。
    define: { __PLUGIN_VERSION__: JSON.stringify(packageJson.version) },

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
