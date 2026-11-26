/**
 * Electron 桌面壳层双语字典（zh / en）。
 *
 * 覆盖：系统托盘状态、托盘右键菜单、关闭保护通知与确认弹窗、
 * 目录/文件选择对话框、服务异常退出通知、启动失败弹窗。
 */

import { normalizeUiLang } from '../shared/locale.js'

const SHELL_DICT = Object.freeze({
  zh: {
    'tray.show': '显示主窗口',
    'tray.quit': '彻底退出',
    'tray.computePrefix': '算力状态：',
    'tray.running': '运行 {count}',
    'tray.queued': '排队 {count}',
    'tray.disconnected': '（本地服务连接异常）',
    'tray.state.absent': '未启动',
    'tray.state.idle': '空闲',
    'tray.state.provisioning': '环境准备中',
    'tray.state.connecting': '隧道连接中',
    'tray.state.warming': '模型预热中',
    'tray.state.ready': '就绪',
    'tray.state.stopping': '正在关机',
    'tray.state.error': '启动失败',
    'tray.state.unknown': '未知',
    'tray.state.unknownWithRaw': '未知（{state}）',

    'dialog.pickDirectory.title': '选择工作区目录',
    'dialog.pickDirectory.button': '选择此目录',
    'dialog.pickFile.title': '选择文件',

    'notify.background.title': 'AIGC Studio 仍在后台运行',
    'notify.background.body': '云端 GPU 会话或任务尚未结束，窗口已最小化到系统托盘。需要退出请使用托盘菜单的「彻底退出」。',

    'dialog.activeSession.title': '云端会话仍在运行',
    'dialog.activeSession.message': '当前有活跃的云端 GPU 会话或任务',
    'dialog.activeSession.detail':
      '直接退出会让云端 Kernel 继续空转到超时，消耗本周 GPU 配额。建议先回到工作台断开算力，或等待任务完成。',
    'dialog.activeSession.back': '返回工作台',
    'dialog.activeSession.quit': '仍要退出',

    'notify.serverFailed.title': '本地服务异常退出',
    'notify.serverFailed.body': '自动重启已停止，请查看日志（logs/electron.log）后重新启动 AIGC Studio。',

    'dialog.startFailed.title': 'AIGC Studio 启动失败',
    'dialog.startFailed.logPrefix': '日志：',
    'dialog.startFailed.logDisabled': '（未启用）',
  },
  en: {
    'tray.show': 'Show Window',
    'tray.quit': 'Quit Completely',
    'tray.computePrefix': 'Compute: ',
    'tray.running': 'Running {count}',
    'tray.queued': 'Queued {count}',
    'tray.disconnected': ' (Local service disconnected)',
    'tray.state.absent': 'Not Started',
    'tray.state.idle': 'Idle',
    'tray.state.provisioning': 'Provisioning',
    'tray.state.connecting': 'Connecting',
    'tray.state.warming': 'Warming Up',
    'tray.state.ready': 'Ready',
    'tray.state.stopping': 'Stopping',
    'tray.state.error': 'Failed',
    'tray.state.unknown': 'Unknown',
    'tray.state.unknownWithRaw': 'Unknown ({state})',

    'dialog.pickDirectory.title': 'Select Workspace Folder',
    'dialog.pickDirectory.button': 'Select Folder',
    'dialog.pickFile.title': 'Select File',

    'notify.background.title': 'AIGC Studio is still running in the background',
    'notify.background.body':
      'A cloud GPU session or task is still active. The window has been minimized to the system tray. Use "Quit Completely" from the tray menu to exit.',

    'dialog.activeSession.title': 'Cloud Session Still Running',
    'dialog.activeSession.message': 'An active cloud GPU session or task is running',
    'dialog.activeSession.detail':
      'Quitting now will leave the cloud kernel idling until timeout and consume your weekly GPU quota. Return to the studio to shut it down or wait for completion.',
    'dialog.activeSession.back': 'Back to Studio',
    'dialog.activeSession.quit': 'Quit Anyway',

    'notify.serverFailed.title': 'Local Service Exited Unexpectedly',
    'notify.serverFailed.body': 'Auto-restart has stopped. Please check logs/electron.log and restart AIGC Studio.',

    'dialog.startFailed.title': 'AIGC Studio Failed to Start',
    'dialog.startFailed.logPrefix': 'Log: ',
    'dialog.startFailed.logDisabled': '(disabled)',
  },
})

export function resolveShellLang(lang) {
  return normalizeUiLang(lang) ?? 'zh'
}

export function shellText(lang, key, vars = null) {
  const resolved = resolveShellLang(lang)
  const template = SHELL_DICT[resolved]?.[key] ?? SHELL_DICT.zh[key] ?? key
  if (!vars || typeof vars !== 'object') return template
  return template.replace(/\{([a-zA-Z0-9_]+)\}/g, (_match, name) =>
    Object.prototype.hasOwnProperty.call(vars, name) ? String(vars[name]) : '',
  )
}
