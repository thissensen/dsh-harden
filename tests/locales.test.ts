/**
 * client 文案字典（`src/client/locales.ts`）的单元测试。
 *
 * 字典有三个消费方（设置页面板、两条提示行）却零覆盖。这里只验真实行为：host 暗号的翻译、
 * 两种翻译器的插值，以及 zh / en 两份字典的 key 集合是否逐字相等——A-2 的「检查更新」词条与
 * C-4 的 `progress.rowAria` 都靠这条兜底：只补了一边的话这里先红（en 那头另有 typecheck 兜底）。
 *
 * @module dsh-harden/tests/locales
 */

import { describe, expect, it } from 'vitest'
import { en, translateHostText, translateZh, zh } from '../src/client/locales'

describe('translateHostText', () => {
    it('暗号 key|原因 翻成中文并把原因插进句子', () => {
        const 译文 = translateHostText(translateZh(), 'api.writeFailed|boom')

        expect(译文).toContain('写入失败')
        expect(译文).toContain('boom')
    })

    it('未知 key 原样返回', () => {
        expect(translateHostText(translateZh(), 'no.such.key')).toBe('no.such.key')
    })

    it('已经是人话的文本原样返回', () => {
        expect(translateHostText(translateZh(), '随便一句中文')).toBe('随便一句中文')
    })

    it('两个参数都插进句子', () => {
        const 译文 = translateHostText(translateZh(), 'api.unknownAction|GET|/x')

        expect(译文).toContain('GET')
        expect(译文).toContain('/x')
    })
})

describe('zh / en 两份字典', () => {
    it('key 集合逐字相等', () => {
        expect(Object.keys(en).sort()).toEqual(Object.keys(zh).sort())
    })

    it('A-2 / C-4 的新词条两边都在，且不是 key 本身', () => {
        // 消费方传的是字符串 key（PlatformTranslate 的入参就是 string），漏补词条 typecheck 看不出来
        // ——只有 key 集合相等也拦不住「两边一起漏」，所以这里逐个点名。
        const 新词条组 = [
            'header.updateAvailable',
            'header.checkFailed',
            'progress.rowAria',
            'rule.ptcBreakLimit.title',
            'rule.ptcBreakLimit.desc',
            'rule.ptcBreakLimit.help',
            'api.ptcBreakLimitNotBoolean',
            'rule.authCookieSweep.title',
            'rule.authCookieSweep.desc',
            'rule.authCookieSweep.help',
            'rule.authCookieSweep.inactive',
            'api.authCookieSweepNotBoolean',
        ]

        for (const 词条 of 新词条组) {
            expect((zh as Record<string, string>)[词条], 词条).toBeTruthy()
            expect((en as Record<string, string>)[词条], 词条).toBeTruthy()
            expect((en as Record<string, string>)[词条], 词条).not.toBe(词条)
        }
    })
})

describe('translateZh', () => {
    it('缺 params 时原样返回（占位符保留）', () => {
        expect(translateZh()('progress.held')).toBe(zh['progress.held'])
    })

    it('给了 params 时完成插值', () => {
        const 译文 = translateZh()('progress.held', { p1: 3 })

        expect(译文).toContain('3')
        expect(译文).not.toContain('{p1}')
    })
})
