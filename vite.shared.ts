/**
 * client 壳产物的构建公共片段。
 *
 * 平台的客户端模块系统只认 `window.__ModuleLoader__.load({ id, factory })` 注册形态，
 * 这个包装把整个 CJS chunk 塞进那个外壳。官方前端壳的产物就是这个形状。
 *
 * @module dsh-harden/vite-shared
 */

import type { Plugin } from 'vite'

/**
 * 交给平台在运行时解析的共享模块。
 *
 * `react` 与 `react/jsx-runtime` 必须 external——漏了会把 react 打进 bundle，
 * 与平台 seed 的那份打架（两个 React 实例会让 hooks 直接报错）。
 */
export const EXTERNAL_MODULES = [
    'react',
    'react/jsx-runtime',
    'react-dom',
    '@deepseek-ai/dsh-client-ui-primitives',
]

/**
 * 把整个 CJS chunk 包进 `window.__ModuleLoader__.load({ id, factory })` 外壳。
 *
 * @param id - 注册的模块 id（本项目就是包名 `dsh-harden`）。
 */
export function dshModuleLoaderWrap(id: string): Plugin {
    return {
        name: 'dsh-module-loader-wrap',
        apply: 'build',

        renderChunk(code, chunk) {
            if (!chunk.isEntry) return null

            return {
                code: `window.__ModuleLoader__.load({
  id: ${JSON.stringify(id)},
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
${code}
    return module.exports;
  },
});
`,
                map: null,
            }
        },
    }
}
