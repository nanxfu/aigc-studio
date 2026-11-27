export type SiteLang = 'zh' | 'en';

export function normalizeSiteLang(lang?: string | null): SiteLang {
  return lang === 'en' ? 'en' : 'zh';
}

export function basePathOf(path = '/'): string {
  const raw = path.startsWith('/') ? path : `/${path}`;
  if (raw === '/en' || raw === '/en/') return '/';
  if (raw.startsWith('/en/')) return raw.slice(3) || '/';
  return raw;
}

export function localePath(path: string, lang: SiteLang = 'zh'): string {
  const hashIndex = path.indexOf('#');
  const hash = hashIndex >= 0 ? path.slice(hashIndex) : '';
  const clean = basePathOf(hashIndex >= 0 ? path.slice(0, hashIndex) || '/' : path);
  if (lang === 'zh') return `${clean}${hash}`;
  return clean === '/' ? `/en/${hash}` : `/en${clean}${hash}`;
}

export const SITE_UI = {
  zh: {
    htmlLang: 'zh-CN',
    ogLocale: 'zh_CN',
    brandAria: 'AIGC Studio 首页',
    navAria: '主导航',
    mobileNavAria: '移动端导航',
    menuAria: '展开导航菜单',
    nav: {
      domains: '垂直领域',
      models: '模型实测',
      hardware: '算力天梯',
      workshop: '资产工坊',
      guides: '使用指南',
      githubSource: 'GitHub 源码',
    },
    langSwitch: {
      label: 'EN',
      aria: 'Switch to English',
      targetLang: 'en' as SiteLang,
    },
    theme: {
      aria: '切换暗房或日光主题',
      toDaylight: '日光模式',
      toDarkroom: '暗房模式',
    },
    download: {
      compact: '下载客户端',
      compactWin: '下载 Win 版',
      compactSource: 'Releases / 源码',
      compactMobile: 'Releases',
      heroWin: '下载 Windows 版 v{version}',
      heroSource: '前往 Releases / 源码运行',
      heroMobile: '查看桌面版 Releases v{version}',
      heroOther: '前往 GitHub Releases v{version}',
      hintWin: 'Windows x64 安装版（{installer}）与便携版 · MIT 开源',
      hintMac: '安装包目前只验证了 Windows x64；macOS 可用 Node 20+ 从源码启动',
      hintLinux: '安装包目前只验证了 Windows x64；Linux 可用 Node 20+ 从源码启动',
      hintMobile: '桌面客户端面向电脑端，请在电脑上下载安装',
    },
    footer: {
      desc: '独立的开源桌面生图工作台。界面与文件留在本地，算力按需挂载云端。',
      meta: 'MIT 开源 · Windows x64 安装包（macOS / Linux 支持源码运行）',
      colProduct: 'PRODUCT',
      colGuides: 'GUIDES',
      colGet: 'GET',
      workflow: '工作原理',
      compare: '方案对比',
      allGuides: '全部使用指南',
      guideFreeGpu: '免显卡上手指南',
      guideVsComfy: 'vs ComfyUI 选型',
      guideMcp: 'MCP 接入 Claude / Cursor',
      downloadWin: '下载 Windows 安装包',
      sitemap: '站点地图',
      llmsHref: '/llms.txt',
      bottomRight: '本地优先 · 无云端账号绑定',
    },
    lightbox: {
      aria: '大图检视',
      close: 'ESC 关闭',
    },
  },
  en: {
    htmlLang: 'en',
    ogLocale: 'en_US',
    brandAria: 'AIGC Studio Home',
    navAria: 'Main navigation',
    mobileNavAria: 'Mobile navigation',
    menuAria: 'Toggle navigation menu',
    nav: {
      domains: 'Domains',
      models: 'Models',
      hardware: 'GPU Ladder',
      workshop: 'Workshop',
      guides: 'Guides',
      githubSource: 'GitHub Source',
    },
    langSwitch: {
      label: '中文',
      aria: '切换至简体中文',
      targetLang: 'zh' as SiteLang,
    },
    theme: {
      aria: 'Toggle Darkroom or Daylight theme',
      toDaylight: 'Daylight',
      toDarkroom: 'Darkroom',
    },
    download: {
      compact: 'Download',
      compactWin: 'Download Win',
      compactSource: 'Releases / Source',
      compactMobile: 'Releases',
      heroWin: 'Download Windows v{version}',
      heroSource: 'Releases / Run from Source',
      heroMobile: 'View Desktop Releases v{version}',
      heroOther: 'GitHub Releases v{version}',
      hintWin: 'Windows x64 installer ({installer}) & portable · MIT Open Source',
      hintMac: 'Packaged builds currently target Windows x64; macOS runs from source on Node 20+',
      hintLinux: 'Packaged builds currently target Windows x64; Linux runs from source on Node 20+',
      hintMobile: 'Desktop client is built for PC; please download on your computer',
    },
    footer: {
      desc: 'Independent open-source desktop AI image studio. Interface and files stay local; compute mounts cloud GPUs on demand.',
      meta: 'MIT Open Source · Windows x64 installer (macOS / Linux supported via source)',
      colProduct: 'PRODUCT',
      colGuides: 'GUIDES',
      colGet: 'GET',
      workflow: 'Architecture',
      compare: 'Comparison',
      allGuides: 'All Guides',
      guideFreeGpu: 'Free Cloud GPU Guide',
      guideVsComfy: 'vs ComfyUI',
      guideMcp: 'MCP for Claude / Cursor',
      downloadWin: 'Download Windows Installer',
      sitemap: 'Sitemap',
      llmsHref: '/en/llms.txt',
      bottomRight: 'Local-First · No Cloud Lock-in',
    },
    lightbox: {
      aria: 'Image Lightbox',
      close: 'ESC Close',
    },
  },
} as const;
