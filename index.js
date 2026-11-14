/**
 * dsh-tishi —— 「侧栏工作区状态角标」的 Host 半边。
 *
 * 这里刻意是空壳：插件真正的工作全在浏览器半边 client.js。Host 只负责在
 * Loader 组合树里占一行，让 @deepseek-ai/dsh-client-modules 扫描到本包
 * package.json 的 `dsh.client` 声明，从而装载浏览器模块（见 HANDOFF §2.5）。
 *
 * 不注册路由、不读文件、不碰宿主服务——没有可失败的初始化路径。
 */

export const name = 'dsh-tishi'

export function apply() {}
