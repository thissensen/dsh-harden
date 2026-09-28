/**
 * client 半边用到的全局与平台模块声明（只声明本项目用到的部分）。
 *
 * 与 host 半边同纪律：不 import 平台包的类型入口，只声明实际用到的成员。
 *
 * @module dsh-harden/client-globals
 */

/** 平台的客户端模块系统，以及构建期注入的版本号。 */
declare global {
    /** 构建期由 Vite 从 `package.json` 注入的插件版本号（见 vite.config.ts 的 define）。 */
    const __PLUGIN_VERSION__: string

    interface Window {
        __ModuleLoader__?: {
            load(entry: { id: string; factory: (require: (name: string) => unknown) => unknown }): void
        }
    }
}

export {}
